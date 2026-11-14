import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.ts";
import { initializeWorld } from "../../src/engine/genesis.ts";
import { hashWorldState } from "../../src/engine/hash.ts";
import { SimulationRunner } from "../../src/engine/loop.ts";
import { MockLLMClient } from "../../src/llm/mock_client.ts";
import { PromptLoader } from "../../src/llm/prompt_loader.ts";
import { ReplayLLMClient } from "../../src/llm/replay_client.ts";
import { RunStore } from "../../src/storage/run_store.ts";

describe("Layer 5 — Determinism & Replay Tests", () => {
  test("replay from llm_calls.jsonl produces identical final state hash", async () => {
    const { config, world } = loadConfig();
    config.MOCK_LLM = true;
    config.SIM_SEED = 77;
    const prompts = new PromptLoader("en", "default");

    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "ventriana-det1-"));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ventriana-det2-"));

    try {
      const store1 = new RunStore(dir1);
      const llm1 = new MockLLMClient(77);
      const s1 = await initializeWorld({
        config,
        world,
        llm: llm1,
        prompts,
        emitEvent: (ev) => store1.appendEvent(ev),
        logLLM: (e) => store1.appendLLMCall(e),
      });
      const r1 = new SimulationRunner({
        state: s1,
        config,
        world,
        llm: llm1,
        prompts,
        storage: store1,
      });
      await r1.runDays(5);
      const hash1 = hashWorldState(r1.state);
      store1.close();

      // Replay from llm_calls.jsonl
      const replayLlm = new ReplayLLMClient(path.join(dir1, "llm_calls.jsonl"));
      const store2 = new RunStore(dir2);
      const s2 = await initializeWorld({
        config,
        world,
        llm: replayLlm,
        prompts,
        emitEvent: (ev) => store2.appendEvent(ev),
        logLLM: (e) => store2.appendLLMCall(e),
      });
      const r2 = new SimulationRunner({
        state: s2,
        config,
        world,
        llm: replayLlm,
        prompts,
        storage: store2,
      });
      await r2.runDays(5);
      const hash2 = hashWorldState(r2.state);
      store2.close();

      expect(hash2).toBe(hash1);
    } finally {
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  test("killed and resumed run produces identical state hash to uninterrupted run", async () => {
    const { config, world } = loadConfig();
    config.MOCK_LLM = true;
    config.SIM_SEED = 99;
    const prompts = new PromptLoader("en", "default");

    const dirFull = fs.mkdtempSync(path.join(os.tmpdir(), "ventriana-full-"));
    const dirRes = fs.mkdtempSync(path.join(os.tmpdir(), "ventriana-res-"));

    try {
      // Uninterrupted 4-day run
      const storeFull = new RunStore(dirFull);
      const llmFull = new MockLLMClient(99);
      const sFull = await initializeWorld({
        config,
        world,
        llm: llmFull,
        prompts,
        emitEvent: (ev) => storeFull.appendEvent(ev),
        logLLM: (e) => storeFull.appendLLMCall(e),
      });
      const rFull = new SimulationRunner({
        state: sFull,
        config,
        world,
        llm: llmFull,
        prompts,
        storage: storeFull,
      });
      await rFull.runDays(4);
      const hashFull = hashWorldState(rFull.state);
      storeFull.close();

      // Interrupted after day 2, then resumed using ReplayLLMClient from full log
      const replayLlm = new ReplayLLMClient(path.join(dirFull, "llm_calls.jsonl"));
      const storeRes = new RunStore(dirRes);
      const sRes = await initializeWorld({
        config,
        world,
        llm: replayLlm,
        prompts,
        emitEvent: (ev) => storeRes.appendEvent(ev),
        logLLM: (e) => storeRes.appendLLMCall(e),
      });
      const rPart1 = new SimulationRunner({
        state: sRes,
        config,
        world,
        llm: replayLlm,
        prompts,
        storage: storeRes,
      });
      await rPart1.runDays(2);
      storeRes.close();

      // Resume from checkpoint
      const storeRes2 = new RunStore(dirRes);
      const latest = await storeRes2.loadLatestSnapshot();
      expect(latest).not.toBeNull();
      const rPart2 = new SimulationRunner({
        state: latest!.state,
        config,
        world,
        llm: replayLlm,
        prompts,
        storage: storeRes2,
      });
      await rPart2.runDays(4, { day: latest!.day, phase: latest!.phase });
      const hashRes = hashWorldState(rPart2.state);
      storeRes2.close();

      expect(hashRes).toBe(hashFull);
    } finally {
      fs.rmSync(dirFull, { recursive: true, force: true });
      fs.rmSync(dirRes, { recursive: true, force: true });
    }
  });
});
