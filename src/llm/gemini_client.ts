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

function isSafetyBlockError(err: unknown): boolean {
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

  constructor(opts: GeminiClientOptions) {
    this.opts = opts;
    this.google = createGoogleGenerativeAI({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async generate<T>(options: LLMGenerateOptions<T>): Promise<LLMGenerateResult<T>> {
    const startMs = Date.now();
    const estimatedPromptTokens = Math.ceil(options.prompt.length / 4);
    if (estimatedPromptTokens > this.opts.contextWindow * 0.7) {
      console.warn(
        `[GeminiClient] Context warning: prompt for ${options.callId} (~${estimatedPromptTokens} tokens) exceeds 70% of context window (${this.opts.contextWindow})`
      );
    }

    let currentPrompt = options.prompt;
    let retries = 0;
    let safetyRetries = 0;
    let validationRetries = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let saw429 = false;
    const maxNetRetries = this.opts.maxNetworkRetries ?? 4;

    while (true) {
      try {
        const res = await this.opts.rateLimiter.run(estimatedPromptTokens, async () => {
          const model = this.google(this.opts.modelId);
          const controller = new AbortController();
          const timeoutMs = this.opts.timeoutMs ?? 60_000;
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            return await generateObject({
              model,
              schema: options.schema,
              prompt: currentPrompt,
              system: options.systemPrompt,
              maxRetries: 0,
              abortSignal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
        });

        const pTok = res.usage?.promptTokens ?? estimatedPromptTokens;
        const cTok = res.usage?.completionTokens ?? 0;
        totalPromptTokens += pTok;
        totalCompletionTokens += cTok;

        this.opts.rateLimiter.recordAttempt({
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          retries,
          invalidOutput: false,
          safetyBlocked: false,
          rateLimit429: saw429,
        });

        return {
          success: true,
          data: res.object,
          rawText: JSON.stringify(res.object),
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          latencyMs: Date.now() - startMs,
          retries,
          safetyBlocked: false,
        };
      } catch (err) {
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
            retries,
            invalidOutput: false,
            safetyBlocked: true,
            rateLimit429: saw429,
          });
          return {
            success: false,
            data: null,
            rawText: "",
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            latencyMs: Date.now() - startMs,
            retries,
            safetyBlocked: true,
            error: `Safety blocked: ${errMsg}`,
          };
        }

        // 2. Transient 429 / 5xx / timeout: exponential backoff
        const transient = isTransientHttpError(err);
        if (transient.transient && retries < maxNetRetries) {
          if (transient.is429) {
            saw429 = true;
            this.opts.rateLimiter.record429();
          }
          retries += 1;
          const backoffMs = Math.min(1000 * Math.pow(2, retries - 1), 16_000);
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
          retries,
          invalidOutput: true,
          safetyBlocked: false,
          rateLimit429: saw429,
        });

        return {
          success: false,
          data: null,
          rawText: "",
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          latencyMs: Date.now() - startMs,
          retries,
          safetyBlocked: false,
          error: errMsg,
        };
      }
    }
  }
}
