import { AsyncLocalStorage } from "node:async_hooks";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import type {
  LLMClient,
  LLMGenerateOptions,
  LLMGenerateResult,
} from "../../contracts/interfaces.ts";
import type { RateLimiter } from "./rate_limiter.ts";

export interface GeminiClientOptions {
  apiKey: string;
  modelId: string;
  contextWindow: number;
  rateLimiter: RateLimiter;
  baseURL?: string;
  timeoutMs?: number;
  maxNetworkRetries?: number;
}

interface HttpAttemptTelemetry {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  retryAfterMs?: number;
  status?: number;
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil(Math.max(text.length / 3.1, utf8Bytes / 3.4));
}

function parseRetryAfterMs(headerVal: string | null): number | undefined {
  if (!headerVal) return undefined;
  const trimmed = headerVal.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function isSafetyBlockError(err: unknown): boolean {
  const anyErr = err as { finishReason?: string; message?: string };
  if (anyErr?.finishReason === "content-filter") return true;
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes("safety") ||
    lower.includes("content_filter") ||
    lower.includes("blocked") ||
    lower.includes("finishreason: content-filter")
  );
}

function isTransientHttpError(err: unknown): { transient: boolean; is429: boolean } {
  const anyErr = err as { statusCode?: number; status?: number; message?: string };
  const status = anyErr?.statusCode ?? anyErr?.status;
  if (status === 429) return { transient: true, is429: true };
  if (status !== undefined && status >= 500 && status < 600) {
    return { transient: true, is429: false };
  }
  const msg = (anyErr?.message ?? String(err)).toLowerCase();
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("quota")) {
    return { transient: true, is429: true };
  }
  if (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    msg.includes("econnreset")
  ) {
    return { transient: true, is429: false };
  }
  return { transient: false, is429: false };
}

export class GeminiClient implements LLMClient {
  readonly name = "gemini";
  private readonly opts: GeminiClientOptions;
  private readonly google: ReturnType<typeof createGoogleGenerativeAI>;
  private readonly attemptStorage = new AsyncLocalStorage<HttpAttemptTelemetry>();

  constructor(opts: GeminiClientOptions) {
    this.opts = opts;
    this.google = createGoogleGenerativeAI({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      fetch: (async (input, init) => {
        const response = await fetch(input, init);
        const telemetry = this.attemptStorage.getStore();
        if (telemetry) {
          telemetry.status = response.status;
          if (response.status === 429 || response.status === 503) {
            telemetry.retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          }
          const contentType = response.headers.get("content-type") ?? "";
          if (response.ok && contentType.toLowerCase().includes("application/json")) {
            try {
              const body = (await response.clone().json()) as {
                usageMetadata?: {
                  promptTokenCount?: number;
                  candidatesTokenCount?: number;
                  cachedContentTokenCount?: number;
                };
              };
              const meta = body?.usageMetadata;
              if (meta) {
                if (typeof meta.promptTokenCount === "number") {
                  telemetry.promptTokenCount = meta.promptTokenCount;
                }
                if (typeof meta.candidatesTokenCount === "number") {
                  telemetry.candidatesTokenCount = meta.candidatesTokenCount;
                }
                if (typeof meta.cachedContentTokenCount === "number") {
                  telemetry.cachedContentTokenCount = meta.cachedContentTokenCount;
                }
              }
            } catch {
              // Ignore non-JSON or unreadable cloned body
            }
          }
        }
        return response;
      }) as typeof fetch,
    });
  }

  async generate<T>(options: LLMGenerateOptions<T>): Promise<LLMGenerateResult<T>> {
    const startMs = Date.now();
    const systemTokens = estimateTokenCount(options.systemPrompt ?? "");
    const initialEstimatedTokens = systemTokens + estimateTokenCount(options.prompt);
    if (initialEstimatedTokens > this.opts.contextWindow * 0.7) {
      console.warn(
        `[GeminiClient] Context warning: prompt for ${options.callId} (~${initialEstimatedTokens} tokens) exceeds 70% of context window (${this.opts.contextWindow})`
      );
    }

    let currentPrompt = options.prompt;
    let retries = 0;
    let safetyRetries = 0;
    let validationRetries = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;
    const maxNetRetries = this.opts.maxNetworkRetries ?? 4;

    while (true) {
      const attemptEstTokens = systemTokens + estimateTokenCount(currentPrompt);
      const telemetry: HttpAttemptTelemetry = {};

      try {
        const res = await this.opts.rateLimiter.run(attemptEstTokens, async (reservation) => {
          const model = this.google(this.opts.modelId);
          const controller = new AbortController();
          const timeoutMs = this.opts.timeoutMs ?? 60_000;
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const out = await this.attemptStorage.run(telemetry, () =>
              generateObject({
                model,
                schema: options.schema,
                prompt: currentPrompt,
                system: options.systemPrompt,
                maxRetries: 0,
                abortSignal: controller.signal,
              })
            );
            const pTok =
              telemetry.promptTokenCount ?? out.usage?.promptTokens ?? attemptEstTokens;
            const cTok = telemetry.candidatesTokenCount ?? out.usage?.completionTokens ?? 0;
            reservation.settle(pTok + cTok);
            return out;
          } catch (attemptErr) {
            // Settle actual tokens if HTTP response returned usage metadata (e.g. schema/JSON error);
            // otherwise release reserved TPM tokens when the HTTP call failed transiently.
            if (
              telemetry.promptTokenCount !== undefined ||
              telemetry.candidatesTokenCount !== undefined
            ) {
              reservation.settle(
                (telemetry.promptTokenCount ?? 0) + (telemetry.candidatesTokenCount ?? 0)
              );
            } else {
              reservation.settle(0);
            }
            throw attemptErr;
          } finally {
            clearTimeout(timer);
          }
        });

        const pTok = telemetry.promptTokenCount ?? res.usage?.promptTokens ?? attemptEstTokens;
        const cTok = telemetry.candidatesTokenCount ?? res.usage?.completionTokens ?? 0;
        const cachedTok = telemetry.cachedContentTokenCount ?? 0;
        totalPromptTokens += pTok;
        totalCompletionTokens += cTok;
        totalCachedTokens += cachedTok;

        this.opts.rateLimiter.recordAttempt({
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          cachedTokens: totalCachedTokens,
          retries,
          invalidOutput: false,
          safetyBlocked: false,
          alreadyWindowTracked: true,
        });

        return {
          success: true,
          data: res.object,
          rawText: JSON.stringify(res.object),
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
          latencyMs: Date.now() - startMs,
          retries,
          safetyBlocked: false,
        };
      } catch (err) {
        if (telemetry.promptTokenCount !== undefined) {
          totalPromptTokens += telemetry.promptTokenCount;
        }
        if (telemetry.candidatesTokenCount !== undefined) {
          totalCompletionTokens += telemetry.candidatesTokenCount;
        }
        if (telemetry.cachedContentTokenCount !== undefined) {
          totalCachedTokens += telemetry.cachedContentTokenCount;
        }

        const errMsg = err instanceof Error ? err.message : String(err);

        // 1. Safety block: retry once, then logged no-op
        if (isSafetyBlockError(err)) {
          if (safetyRetries < 1) {
            safetyRetries += 1;
            retries += 1;
            continue;
          }
          this.opts.rateLimiter.recordAttempt({
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            cachedTokens: totalCachedTokens,
            retries,
            invalidOutput: false,
            safetyBlocked: true,
            alreadyWindowTracked: true,
          });
          return {
            success: false,
            data: null,
            rawText: "",
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
            latencyMs: Date.now() - startMs,
            retries,
            safetyBlocked: true,
            error: `Safety blocked: ${errMsg}`,
          };
        }

        // 2. Transient 429 / 5xx / timeout: exponential backoff (respecting Retry-After)
        const transient = isTransientHttpError(err);
        if (transient.transient && retries < maxNetRetries) {
          retries += 1;
          const expBackoffMs = Math.min(1000 * Math.pow(2, retries - 1), 16_000);
          const backoffMs =
            telemetry.retryAfterMs !== undefined
              ? Math.min(Math.max(telemetry.retryAfterMs, expBackoffMs), 60_000)
              : expBackoffMs;
          if (transient.is429 || telemetry.status === 429) {
            this.opts.rateLimiter.record429(backoffMs);
          }
          console.warn(
            `[GeminiClient] Transient error on ${options.callId} (attempt ${retries}): ${errMsg}. Backing off ${backoffMs}ms`
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        // 3. Schema / JSON validation error: retry up to 2 times with error appended
        if (validationRetries < 2) {
          validationRetries += 1;
          retries += 1;
          currentPrompt = `${options.prompt}\n\nPrevious output was invalid (${errMsg}). Fix it and reply ONLY with valid JSON matching the schema.`;
          continue;
        }

        this.opts.rateLimiter.recordAttempt({
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          cachedTokens: totalCachedTokens,
          retries,
          invalidOutput: true,
          safetyBlocked: false,
          alreadyWindowTracked: true,
        });

        return {
          success: false,
          data: null,
          rawText: "",
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
          latencyMs: Date.now() - startMs,
          retries,
          safetyBlocked: false,
          error: errMsg,
        };
      }
    }
  }
}
