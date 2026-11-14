import fs from "node:fs";
import type {
  LLMCallLogEntry,
  LLMClient,
  LLMGenerateOptions,
  LLMGenerateResult,
} from "../../contracts/interfaces.ts";

/**
 * Replays recorded LLM responses from llm_calls.jsonl without making network calls.
 */
export class ReplayLLMClient implements LLMClient {
  readonly name = "replay";
  private readonly byCallId = new Map<string, LLMCallLogEntry>();

  constructor(jsonlPath: string) {
    const content = fs.readFileSync(jsonlPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = JSON.parse(trimmed) as LLMCallLogEntry;
      this.byCallId.set(entry.callId, entry);
    }
  }

  async generate<T>(options: LLMGenerateOptions<T>): Promise<LLMGenerateResult<T>> {
    const entry = this.byCallId.get(options.callId);
    if (!entry) {
      return {
        success: false,
        data: null,
        rawText: "",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        retries: 0,
        safetyBlocked: false,
        error: `Missing recorded LLM call for callId=${options.callId}`,
      };
    }

    if (!entry.parsedOk) {
      return {
        success: false,
        data: null,
        rawText: entry.rawResponse,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        latencyMs: 0,
        retries: entry.retries,
        safetyBlocked: entry.safetyBlocked,
        error: entry.error ?? "Recorded call failed",
      };
    }

    const raw = JSON.parse(entry.rawResponse);
    const parsed = options.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        success: false,
        data: null,
        rawText: entry.rawResponse,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        latencyMs: 0,
        retries: entry.retries,
        safetyBlocked: false,
        error: parsed.error.message,
      };
    }

    return {
      success: true,
      data: parsed.data,
      rawText: entry.rawResponse,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      latencyMs: 0,
      retries: entry.retries,
      safetyBlocked: entry.safetyBlocked,
    };
  }
}
