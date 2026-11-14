import { describe, expect, test } from "bun:test";
import type { SimEvent } from "../../contracts/events.ts";
import type { LLMCallLogEntry, StorageAdapter } from "../../contracts/interfaces.ts";
import { MorningOutputSchema } from "../../contracts/schemas.ts";
import type { DailyMetricsRow, PhaseName, RunMetadata, WorldState } from "../../contracts/types.ts";
import { loadConfig } from "../../src/config.ts";
import { initializeWorld } from "../../src/engine/genesis.ts";
import { SimulationRunner } from "../../src/engine/loop.ts";
import { MockLLMClient } from "../../src/llm/mock_client.ts";
import { PromptLoader } from "../../src/llm/prompt_loader.ts";

class MemoryStorage implements StorageAdapter {
  readonly runDir = ":memory:";
  async initRun(_m: RunMetadata) {}
  async updateRunMetadata(_p: Partial<RunMetadata>) {}
  async getRunMetadata() { return null; }
  async saveSnapshot(_d: number, _p: PhaseName, _s: WorldState) {}
  async loadLatestSnapshot() { return null; }
  async loadSnapshotForDay(_d: number) { return null; }
  async appendEvent(_e: SimEvent) {}
  async readEvents() { return []; }
  async appendLLMCall(_e: LLMCallLogEntry) {}
  async appendDailyStats(_r: DailyMetricsRow) {}
  close() {}
}

describe("Layer 3 — Property & Fuzz Tests", () => {
  test("1000 random mock runs preserve all world invariants", async () => {
    const { config, world } = loadConfig();
    config.MOCK_LLM = true;
    // Run 1000 seeds across 7-day election cycles (or full 56 days if fast; 1000x7 = 7000 sim days)
    // Also test 10 full 56-day runs for multi-generation lifespan invariants
    const prompts = new PromptLoader("en", "default");

    for (let seed = 1; seed <= 1000; seed++) {
      const days = seed <= 10 ? 56 : 7;
      const cfg = { ...config, SIM_SEED: seed, SIM_DAYS: days };
      const llm = new MockLLMClient(seed);
      const storage = new MemoryStorage();

      const state = await initializeWorld({
        config: cfg,
        world,
        llm,
        prompts,
        emitEvent: async () => {},
        logLLM: async () => {},
      });

      const runner = new SimulationRunner({
        state,
        config: cfg,
        world,
        llm,
        prompts,
        storage,
      });

      await runner.runDays(days);

      const living = Object.values(runner.state.agents).filter((a) => a.alive);
      expect(living.length).toBe(27);
      expect(living.filter((a) => a.nation === "lyrians").length).toBe(9);
      expect(living.filter((a) => a.nation === "skalians").length).toBe(9);
      expect(living.filter((a) => a.nation === "ventrians").length).toBe(9);

      // Every region belongs to exactly one country
      for (const rid of Object.keys(runner.state.regions)) {
        const owners = Object.values(runner.state.countries).filter(
          (c) => c.exists && c.regions.includes(rid)
        );
        expect(owners.length).toBe(1);
      }
    }
  }, 60_000);

  test("action validator survives random and malformed JSON", () => {
    const malformedInputs = [
      null,
      undefined,
      "",
      42,
      {},
      { private_thought: 123, actions: "nope" },
      { private_thought: "ok", actions: [{ type: "unknown_action" }] },
      { private_thought: "ok", actions: [{ type: "move" }] },
      { private_thought: "ok", actions: [{ type: "cede_region", region: "" }] },
      { private_thought: "ok", actions: [{ type: "set_border", region: "oslen", blocked: "invalid" }] },
    ];

    for (const input of malformedInputs) {
      const parsed = MorningOutputSchema.safeParse(input);
      expect(parsed.success).toBe(false);
    }
  });
});
