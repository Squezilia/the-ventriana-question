#!/usr/bin/env bun
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import type { LLMClient } from "../../contracts/interfaces.ts";
import type { PhaseName, RunMetadata } from "../../contracts/types.ts";
import { loadConfig, sanitizeConfig } from "../config.ts";
import { initializeWorld } from "../engine/genesis.ts";
import { hashWorldState } from "../engine/hash.ts";
import { SimulationRunner } from "../engine/loop.ts";
import { GeminiClient } from "../llm/gemini_client.ts";
import { MockLLMClient } from "../llm/mock_client.ts";
import { PromptLoader } from "../llm/prompt_loader.ts";
import { RateLimiter } from "../llm/rate_limiter.ts";
import { ReplayLLMClient } from "../llm/replay_client.ts";
import { createApp } from "../server/app.ts";
import { SimulationManager } from "../server/run_manager.ts";
import { computeSpecHash, getGitCommitHash, RunStore } from "../storage/run_store.ts";
import { buildStaticReplayHtml } from "./replay_build.ts";

function makeRunId(seed: number): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `run_${ts}_s${seed}`;
}

function findLatestRunId(outputDir: string): string | null {
  if (!fs.existsSync(outputDir)) return null;
  const dirs = fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("run_"))
    .map((d) => d.name)
    .sort();
  return dirs[dirs.length - 1] ?? null;
}

function createLLMClient(
  config: ReturnType<typeof loadConfig>["config"],
  rateLimiter: RateLimiter
): LLMClient {
  if (config.MOCK_LLM) {
    return new MockLLMClient(config.SIM_SEED);
  }
  if (!config.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing in .env (or set MOCK_LLM=true).");
  }
  return new GeminiClient({
    apiKey: config.GEMINI_API_KEY,
    modelId: config.MODEL_ID,
    contextWindow: config.MODEL_CONTEXT_WINDOW,
    rateLimiter,
  });
}

const program = new Command();
program
  .name("sim")
  .description("Ventriana Sorunu (The Ventrian Question) — Aldoria Simulation CLI")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize a new simulation run")
  .option("--run <run_id>", "Explicit run id")
  .action(async (opts: { run?: string }) => {
    const { config, world, warnings } = loadConfig();
    for (const w of warnings) console.warn(`[Config Warning] ${w}`);

    const runId = opts.run ?? makeRunId(config.SIM_SEED);
    const runDir = path.resolve(config.OUTPUT_DIR, runId);
    const store = new RunStore(runDir);

    const rateLimiter = new RateLimiter({
      rpmLimit: config.RPM_LIMIT,
      tpmLimit: config.TPM_LIMIT,
      maxConcurrency: config.MAX_CONCURRENCY,
      maxTotalCalls: config.MAX_TOTAL_CALLS,
      dailyCallBudget: config.DAILY_CALL_BUDGET,
    });
    const llm = createLLMClient(config, rateLimiter);
    const prompts = new PromptLoader(config.SIM_LANGUAGE, config.PROMPT_VARIANT);

    const meta: RunMetadata = {
      runId,
      seed: config.SIM_SEED,
      modelId: config.MOCK_LLM ? "mock" : config.MODEL_ID,
      mockLlm: config.MOCK_LLM,
      language: config.SIM_LANGUAGE,
      promptVariant: config.PROMPT_VARIANT,
      gitCommit: getGitCommitHash(),
      specHash: computeSpecHash(),
      config: sanitizeConfig(config),
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "initialized",
      lastCompletedDay: -1,
      lastCompletedPhase: null,
    };
    await store.initRun(meta);

    const state = await initializeWorld({
      config,
      world,
      llm,
      prompts,
      emitEvent: (ev) => store.appendEvent(ev),
      logLLM: (entry) => store.appendLLMCall(entry),
    });
    await store.saveSnapshot(0, "rollover", state);
    store.close();
    console.log(`Initialized run ${runId} at ${runDir}`);
  });

program
  .command("run")
  .description("Run the simulation")
  .option("--days <n>", "Number of days to run")
  .option("--resume", "Resume the latest or specified run")
  .option("--run <run_id>", "Run id")
  .action(async (opts: { days?: string; resume?: boolean; run?: string }) => {
    const { config, world, warnings } = loadConfig();
    for (const w of warnings) console.warn(`[Config Warning] ${w}`);

    let runId = opts.run;
    if (opts.resume && !runId) {
      runId = findLatestRunId(path.resolve(config.OUTPUT_DIR)) ?? undefined;
      if (!runId) throw new Error("No existing run found to resume.");
    }
    if (!runId) runId = makeRunId(config.SIM_SEED);

    const runDir = path.resolve(config.OUTPUT_DIR, runId);
    const store = new RunStore(runDir);
    const existingMeta = opts.resume ? await store.getRunMetadata() : null;
    const effectiveConfig = existingMeta?.config
      ? { ...config, SIM_DAYS: existingMeta.config.SIM_DAYS }
      : config;
    const targetDays = opts.days ? Number(opts.days) : effectiveConfig.SIM_DAYS;
    const estCallsPerDay = effectiveConfig.NUM_AGENTS * (1 + effectiveConfig.ROUNDS_PER_DAY + 1);
    console.log(
      `[Startup] Seed=${effectiveConfig.SIM_SEED}, Days=${targetDays}, Mock=${effectiveConfig.MOCK_LLM}, Est. max ~${estCallsPerDay} calls/day (~${estCallsPerDay * targetDays} total)`
    );

    const rateLimiter = new RateLimiter({
      rpmLimit: effectiveConfig.RPM_LIMIT,
      tpmLimit: effectiveConfig.TPM_LIMIT,
      maxConcurrency: effectiveConfig.MAX_CONCURRENCY,
      maxTotalCalls: effectiveConfig.MAX_TOTAL_CALLS,
      dailyCallBudget: effectiveConfig.DAILY_CALL_BUDGET,
    });
    if (opts.resume) {
      rateLimiter.seedTotals(store.getLLMUsageSummary());
    }
    const llm = createLLMClient(effectiveConfig, rateLimiter);
    const prompts = new PromptLoader(
      existingMeta?.language ?? effectiveConfig.SIM_LANGUAGE,
      existingMeta?.promptVariant ?? effectiveConfig.PROMPT_VARIANT
    );

    let state;
    let resumeFrom: { day: number; phase: PhaseName } | undefined;

    const latest = opts.resume ? await store.loadLatestSnapshot() : null;
    if (latest) {
      state = latest.state;
      resumeFrom = { day: latest.day, phase: latest.phase };
      await store.updateRunMetadata({ status: "running" });
      console.log(`Resuming run ${runId} from Day ${latest.day} (${latest.phase})`);
    } else {
      const meta: RunMetadata = {
        runId,
        seed: config.SIM_SEED,
        modelId: config.MOCK_LLM ? "mock" : config.MODEL_ID,
        mockLlm: config.MOCK_LLM,
        language: config.SIM_LANGUAGE,
        promptVariant: config.PROMPT_VARIANT,
        gitCommit: getGitCommitHash(),
        specHash: computeSpecHash(),
        config: sanitizeConfig(config),
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "running",
        lastCompletedDay: -1,
        lastCompletedPhase: null,
      };
      await store.initRun(meta);
      state = await initializeWorld({
        config,
        world,
        llm,
        prompts,
        emitEvent: (ev) => store.appendEvent(ev),
        logLLM: (entry) => store.appendLLMCall(entry),
      });
    }

    const runner = new SimulationRunner({
      state,
      config: effectiveConfig,
      world,
      llm,
      prompts,
      storage: store,
      rateLimiter,
    });

    const outcome = await runner.runDays(targetDays, resumeFrom);
    store.close();

    if (outcome.budgetStopped) {
      console.log(`[Stopped cleanly] ${outcome.reason}. Use --resume --run ${runId} to continue.`);
    } else {
      console.log(`Run ${runId} completed (${targetDays} days). Hash=${hashWorldState(runner.state).slice(0, 12)}`);
    }
  });

program
  .command("serve")
  .description("Start the live or replay dashboard server")
  .option("--live", "Start the live simulation control center dashboard")
  .option("--run <run_id>", "Run id to serve (in --live, immediately creates or resumes this run)")
  .option("--days <n>", "Days to run when starting/resuming via --run in live mode")
  .action(async (opts: { live?: boolean; run?: string; days?: string }) => {
    const { config, world } = loadConfig();
    const port = config.UI_PORT;

    if (opts.live) {
      const manager = new SimulationManager({
        mode: "live",
        baseConfig: config,
        world,
      });
      const { app } = createApp({ manager });
      app.listen({ hostname: "127.0.0.1", port });
      console.log(`Live Control Center running at http://127.0.0.1:${port}`);

      const handleSignal = async () => {
        await manager.shutdown();
        process.exit(0);
      };
      process.on("SIGINT", () => void handleSignal());
      process.on("SIGTERM", () => void handleSignal());

      if (opts.run) {
        const runDir = path.resolve(config.OUTPUT_DIR, opts.run);
        const daysNum = opts.days ? Number(opts.days) : undefined;
        if (fs.existsSync(path.join(runDir, "run.json"))) {
          manager.setDefaultRunId(opts.run);
          const details = await manager.getRunDetails(opts.run);
          if (details.metadata?.status !== "completed") {
            await manager.resumeRun(opts.run, { days: daysNum });
            console.log(`Resumed live run ${opts.run}`);
          } else {
            console.log(`Focused completed run ${opts.run}`);
          }
        } else {
          await manager.createRun({
            runId: opts.run,
            days: daysNum,
            autoStart: true,
          });
          console.log(`Started live run ${opts.run}`);
        }
      } else if (opts.days) {
        const daysNum = Number(opts.days);
        const created = await manager.createRun({
          days: daysNum,
          autoStart: true,
        });
        console.log(`Started live run ${created.runId} (${daysNum} days)`);
      }
    } else {
      const manager = new SimulationManager({
        mode: "replay",
        baseConfig: config,
        world,
      });
      if (opts.run) {
        const runDir = path.resolve(config.OUTPUT_DIR, opts.run);
        if (!fs.existsSync(runDir)) {
          throw new Error(`Run '${opts.run}' not found in ${config.OUTPUT_DIR}.`);
        }
        manager.setDefaultRunId(opts.run);
      }
      const { app } = createApp({ manager });
      app.listen({ hostname: "127.0.0.1", port });
      const activeOrLatest = manager.getPreferredRunId();
      console.log(
        `Replay dashboard running at http://127.0.0.1:${port}${activeOrLatest ? ` (Run ${activeOrLatest})` : ""}`
      );
    }
  });

program
  .command("replay-build")
  .description("Build self-contained replay.html")
  .requiredOption("--run <run_id>", "Run id")
  .option("--no-private", "Strip DMs and private_thought from export")
  .action(async (opts: { run: string; private: boolean }) => {
    const { config } = loadConfig();
    const runDir = path.resolve(config.OUTPUT_DIR, opts.run);
    const outPath = await buildStaticReplayHtml({
      runDir,
      noPrivate: opts.private === false,
    });
    console.log(`Built static replay at ${outPath}`);
  });

program
  .command("stats")
  .description("Print daily metrics for a run")
  .requiredOption("--run <run_id>", "Run id")
  .action(async (opts: { run: string }) => {
    const { config } = loadConfig();
    const runDir = path.resolve(config.OUTPUT_DIR, opts.run);
    const store = new RunStore(runDir);
    const stats = store.readAllStats();
    store.close();
    console.table(
      stats.map((s) => ({
        day: s.day,
        alive: s.totalAlive,
        venReg: s.ventrianRegionsCount,
        venCluster: s.largestVentrianCluster,
        lyriaReg: s.lyriaRegionsCount,
        skaliaReg: s.skaliaRegionsCount,
        ventrianaReg: s.ventrianaRegionsCount,
        posts: s.postsCount,
        dms: s.dmsCount,
        chat: s.localChatCount,
      }))
    );
  });

program
  .command("replay-from-log")
  .description("Deterministically replay a run from llm_calls.jsonl without API calls")
  .requiredOption("--run <run_id>", "Run id")
  .action(async (opts: { run: string }) => {
    const { config, world } = loadConfig();
    const srcDir = path.resolve(config.OUTPUT_DIR, opts.run);
    const srcStore = new RunStore(srcDir);
    const meta = await srcStore.getRunMetadata();
    srcStore.close();
    if (!meta) throw new Error(`Metadata not found for ${opts.run}`);

    const replayClient = new ReplayLLMClient(path.join(srcDir, "llm_calls.jsonl"));
    const tmpDir = path.resolve(config.OUTPUT_DIR, `${opts.run}_replayed`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const tmpStore = new RunStore(tmpDir);
    await tmpStore.initRun(meta);

    const prompts = new PromptLoader(meta.config.SIM_LANGUAGE, meta.config.PROMPT_VARIANT);
    const state = await initializeWorld({
      config: meta.config,
      world,
      llm: replayClient,
      prompts,
      emitEvent: (ev) => tmpStore.appendEvent(ev),
      logLLM: (entry) => tmpStore.appendLLMCall(entry),
    });

    const runner = new SimulationRunner({
      state,
      config: meta.config,
      world,
      llm: replayClient,
      prompts,
      storage: tmpStore,
    });
    const daysToReplay = meta.lastCompletedDay + 1;
    await runner.runDays(daysToReplay);
    const hash = hashWorldState(runner.state);
    tmpStore.close();
    console.log(`Replayed ${daysToReplay} days from log. Final state hash: ${hash}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
