import { describe, expect, test } from "bun:test";
import { LocalChatOutputSchema } from "../../contracts/schemas.ts";
import { GeminiClient } from "../../src/llm/gemini_client.ts";
import { RateLimiter } from "../../src/llm/rate_limiter.ts";

describe("Layer 4 — LLM Contract Tests against fake server", () => {
  test("handles 429 and 5xx with backoff, and degrades malformed/safety responses to logged no-op", async () => {
    let mode: "429_then_ok" | "503_then_ok" | "bad_json" | "safety_block" = "429_then_ok";
    let attempts = 0;

    const server = Bun.serve({
      port: 0,
      async fetch(_req) {
        attempts += 1;
        if (mode === "429_then_ok" && attempts === 1) {
          return new Response(JSON.stringify({ error: { message: "Rate limit 429" } }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (mode === "503_then_ok" && attempts === 1) {
          return new Response(JSON.stringify({ error: { message: "Service unavailable 503" } }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (mode === "bad_json") {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [{ text: "{truncated_json" }] },
                  finishReason: "STOP",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (mode === "safety_block") {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [] },
                  finishReason: "SAFETY",
                },
              ],
              promptFeedback: { blockReason: "SAFETY" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ private_thought: "ok", say: "hello" }) }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      },
    });

    try {
      const limiter = new RateLimiter({
        rpmLimit: 1000,
        tpmLimit: 1_000_000,
        maxConcurrency: 4,
        maxTotalCalls: 0,
        dailyCallBudget: 0,
      });
      const client = new GeminiClient({
        apiKey: "fake-key",
        modelId: "gemini-2.5-flash",
        contextWindow: 1_000_000,
        rateLimiter: limiter,
        baseURL: `http://127.0.0.1:${server.port}/v1beta`,
        timeoutMs: 5000,
        maxNetworkRetries: 2,
      });

      // 1. 429 then OK
      mode = "429_then_ok";
      attempts = 0;
      const r1 = await client.generate({
        callId: "c1",
        day: 0,
        phase: "local_chat",
        agentId: "a1",
        purpose: "local_chat",
        prompt: "hi",
        schema: LocalChatOutputSchema,
      });
      expect(r1.success).toBe(true);
      expect(r1.data?.say).toBe("hello");
      expect(r1.retries).toBeGreaterThanOrEqual(1);

      // 2. 503 then OK
      mode = "503_then_ok";
      attempts = 0;
      const r2 = await client.generate({
        callId: "c2",
        day: 0,
        phase: "local_chat",
        agentId: "a1",
        purpose: "local_chat",
        prompt: "hi",
        schema: LocalChatOutputSchema,
      });
      expect(r2.success).toBe(true);

      // 3. Malformed/truncated JSON -> degrades to logged no-op
      mode = "bad_json";
      attempts = 0;
      const r3 = await client.generate({
        callId: "c3",
        day: 0,
        phase: "local_chat",
        agentId: "a1",
        purpose: "local_chat",
        prompt: "hi",
        schema: LocalChatOutputSchema,
      });
      expect(r3.success).toBe(false);
      expect(r3.data).toBeNull();

      // 4. Safety block -> retries once, then degrades to safetyBlocked no-op
      mode = "safety_block";
      attempts = 0;
      const r4 = await client.generate({
        callId: "c4",
        day: 0,
        phase: "local_chat",
        agentId: "a1",
        purpose: "local_chat",
        prompt: "hi",
        schema: LocalChatOutputSchema,
      });
      expect(r4.success).toBe(false);
      expect(r4.safetyBlocked).toBe(true);
      expect(attempts).toBe(2);
    } finally {
      server.stop(true);
    }
  }, 15_000);
});
