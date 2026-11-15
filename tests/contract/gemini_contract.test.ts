import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalChatOutputSchema } from "../../contracts/schemas.ts";
import { GeminiClient } from "../../src/llm/gemini_client.ts";
import { RateLimiter } from "../../src/llm/rate_limiter.ts";
import { ReplayLLMClient } from "../../src/llm/replay_client.ts";

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

  test("captures cachedContentTokenCount, avoids double-counting 429s, and respects Retry-After header", async () => {
    let attempts = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "1",
            },
          });
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ private_thought: "cached", say: "selam" }) }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 1200,
              candidatesTokenCount: 40,
              cachedContentTokenCount: 960,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    try {
      const limiter = new RateLimiter({
        rpmLimit: 100,
        tpmLimit: 100_000,
        maxConcurrency: 2,
        maxTotalCalls: 20,
        dailyCallBudget: 20,
      });
      const client = new GeminiClient({
        apiKey: "fake-key",
        modelId: "gemini-2.5-flash",
        contextWindow: 1_000_000,
        rateLimiter: limiter,
        baseURL: `http://127.0.0.1:${server.port}/v1beta`,
        timeoutMs: 8000,
        maxNetworkRetries: 2,
      });

      const t0 = Date.now();
      const res = await client.generate({
        callId: "c-cache-429",
        day: 1,
        phase: "local_chat",
        agentId: "a1",
        purpose: "local_chat",
        systemPrompt: "Shared long world rules prefix",
        prompt: "hi",
        schema: LocalChatOutputSchema,
      });
      const elapsed = Date.now() - t0;

      expect(res.success).toBe(true);
      expect(attempts).toBe(2);
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(res.promptTokens).toBe(1200);
      expect(res.completionTokens).toBe(40);
      expect(res.cachedTokens).toBe(960);

      const health = limiter.getHealth();
      // Must not double-count the single HTTP 429 (once per 429 response, not again in recordAttempt)
      expect(health.rateLimit429Count).toBe(1);
      expect(health.cachedTokensTotal).toBe(960);
      expect(health.promptTokensTotal).toBe(1200);
      expect(health.completionTokensTotal).toBe(40);
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test("ReplayLLMClient skips corrupt trailing JSONL lines and prefers parsedOk: true on duplicate callId", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ventriana-replay-client-"));
    const jsonlPath = path.join(tmpDir, "llm_calls.jsonl");
    try {
      const validEntry = {
        callId: "c-dup",
        day: 0,
        phase: "local_chat",
        agentId: "a1",
        purpose: "local_chat",
        promptHash: "h1",
        rawResponse: JSON.stringify({ private_thought: "ok", say: "first good" }),
        parsedOk: true,
        safetyBlocked: false,
        retries: 0,
        latencyMs: 10,
        promptTokens: 50,
        completionTokens: 15,
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      const badOverrideAttempt = {
        ...validEntry,
        rawResponse: "{corrupt",
        parsedOk: false,
        retries: 1,
      };
      const lines = [
        JSON.stringify(badOverrideAttempt),
        JSON.stringify(validEntry),
        // Subsequent failed entry should NOT overwrite an earlier parsedOk: true entry
        JSON.stringify({ ...badOverrideAttempt, retries: 2 }),
        '{"callId":"truncated-crash',
      ];
      fs.writeFileSync(jsonlPath, lines.join("\n"), "utf8");

      const replay = new ReplayLLMClient(jsonlPath);
      const result = await replay.generate({
        callId: "c-dup",
        day: 0,
        phase: "local_chat",
        agentId: "a1",
        purpose: "local_chat",
        prompt: "hi",
        schema: LocalChatOutputSchema,
      });
      expect(result.success).toBe(true);
      expect(result.data?.say).toBe("first good");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
