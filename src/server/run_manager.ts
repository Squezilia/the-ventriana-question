import fs from "node:fs";
import path from "node:path";
import type { LLMClient } from "../../contracts/interfaces.ts";
import type {
  ConfigDefaultsResponse,
  CreateRunRequest,
  ResumeRunRequest,
  RunHealthStats,
  RunSummaryInfo,
  RunSummaryResponse,
  StreamStateMessage,
} from "../../contracts/stream.ts";
import type {
  PhaseName,
  RunMetadata,
  SimConfig,
  WorldConfig,
  WorldState,
} from "../../contracts/types.ts";
import { sanitizeConfig } from "../config.ts";
import { initializeWorld } from "../engine/genesis.ts";
import { SimulationRunner } from "../engine/loop.ts";
import { GeminiClient } from "../llm/gemini_client.ts";
import { MockLLMClient } from "../llm/mock_client.ts";
import { PromptLoader } from "../llm/prompt_loader.ts";
import { RateLimiter } from "../llm/rate_limiter.ts";
import { computeSpecHash, getGitCommitHash, RunStore } from "../storage/run_store.ts";

export class RunManagerError extends Error {
  readonly statusCode: number;
  readonly conflictRunId?: string;

  constructor(message: string, statusCode: number = 400, conflictRunId?: string) {
    super(message);
    this.name = "RunManagerError";
    this.statusCode = statusCode;
    this.conflictRunId = conflictRunId;
  }
}

interface ActiveSession {
  runId: string;
  store: RunStore;
  rateLimiter: RateLimiter;
  runner: SimulationRunner | null;
  targetDays: number;
  initializing: boolean;
  started: boolean;
  queuedPause: boolean;
  stopRequested: boolean;
  status: RunMetadata["status"];
  currentDay: number;
  currentPhase: PhaseName;
  latestState: WorldState | null;
  initPromise: Promise<void> | null;
  runPromise: Promise<void> | null;
  startFn: (() => void) | null;
}

const RUN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;

export class SimulationManager {
  readonly mode: "live" | "replay";
  readonly outputDir: string;
  private readonly baseConfig: SimConfig;
  private readonly world: WorldConfig;
  private readonly promptsBaseDir: string;
  private readonly phaseDelayMs: number;
  private activeSession: ActiveSession | null = null;
  private lastFocusedRunId: string | null = null;
  private readonly listeners = new Set<(msg: StreamStateMessage) => void>();

  constructor(opts: {
    mode: "live" | "replay";
    baseConfig: SimConfig;
    world: WorldConfig;
    promptsBaseDir?: string;
    phaseDelayMs?: number;
  }) {
    this.mode = opts.mode;
    this.baseConfig = opts.baseConfig;
    this.world = opts.world;
    this.outputDir = path.resolve(opts.baseConfig.OUTPUT_DIR);
    this.promptsBaseDir = opts.promptsBaseDir ?? path.join(process.cwd(), "prompts");
    const envDelay = Number(process.env.LIVE_PHASE_DELAY_MS ?? "0");
    this.phaseDelayMs = opts.phaseDelayMs ?? (Number.isFinite(envDelay) && envDelay > 0 ? envDelay : 0);
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  subscribe(listener: (msg: StreamStateMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private broadcast(msg: StreamStateMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  private async broadcastRunsUpdated(): Promise<void> {
    const runs = await this.listRuns();
    const active = this.activeSession;
    this.broadcast({
      type: "runs_updated",
      runId: active?.runId ?? "",
      day: active?.currentDay ?? 0,
      phase: active?.currentPhase ?? "rollover",
      status: active?.status ?? "completed",
      activeRunId: this.getActiveRunId(),
      runs,
    });
  }

  getActiveRunId(): string | null {
    return this.activeSession?.runId ?? null;
  }

  setDefaultRunId(runId: string): void {
    this.lastFocusedRunId = runId;
  }

  getPreferredRunId(): string | null {
    if (this.activeSession) return this.activeSession.runId;
    if (this.lastFocusedRunId && this.runExists(this.lastFocusedRunId)) {
      return this.lastFocusedRunId;
    }
    return this.findLatestRunId();
  }

  private validateRunId(runId: string): string {
    const trimmed = runId.trim();
    if (!RUN_ID_RE.test(trimmed)) {
      throw new RunManagerError(
        "Invalid run ID. Use 1-81 letters, numbers, underscores, or hyphens starting with an alphanumeric character.",
        400
      );
    }
    const resolved = path.resolve(this.outputDir, trimmed);
    if (!resolved.startsWith(this.outputDir + path.sep)) {
      throw new RunManagerError("Invalid run path.", 403);
    }
    return trimmed;
  }

  private getRunDir(runId: string): string {
    const valid = this.validateRunId(runId);
    return path.resolve(this.outputDir, valid);
  }

  private runExists(runId: string): boolean {
    try {
      const dir = this.getRunDir(runId);
      return (
        fs.existsSync(dir) &&
        (fs.existsSync(path.join(dir, "run.json")) ||
          fs.existsSync(path.join(dir, "state.sqlite")))
      );
    } catch {
      return false;
    }
  }

  private makeUniqueRunId(seed: number): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base = `run_${ts}_s${seed}`;
    if (!fs.existsSync(path.resolve(this.outputDir, base))) {
      return base;
    }
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}_${i}`;
      if (!fs.existsSync(path.resolve(this.outputDir, candidate))) {
        return candidate;
      }
    }
    return `${base}_${Date.now()}`;
  }

  private discoverAvailableVariants(): Record<"en" | "tr", string[]> {
    const out: Record<"en" | "tr", string[]> = { en: ["default"], tr: ["default"] };
    for (const lang of ["en", "tr"] as const) {
      const langDir = path.join(this.promptsBaseDir, lang);
      if (!fs.existsSync(langDir)) continue;
      const dirs = fs
        .readdirSync(langDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      if (dirs.length > 0) {
        out[lang] = dirs;
      }
    }
    return out;
  }

  getConfigDefaults(): ConfigDefaultsResponse {
    return {
      seed: this.baseConfig.SIM_SEED,
      days: this.baseConfig.SIM_DAYS,
      language: this.baseConfig.SIM_LANGUAGE,
      promptVariant: this.baseConfig.PROMPT_VARIANT,
      mockLlm: this.baseConfig.MOCK_LLM,
      modelId: this.baseConfig.MODEL_ID,
      hasGeminiKey: Boolean(this.baseConfig.GEMINI_API_KEY?.trim()),
      availableVariants: this.discoverAvailableVariants(),
    };
  }

  findLatestRunId(): string | null {
    if (!fs.existsSync(this.outputDir)) return null;
    const dirs = fs
      .readdirSync(this.outputDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && RUN_ID_RE.test(d.name))
      .map((d) => d.name)
      .filter((name) => this.runExists(name));
    if (dirs.length === 0) return null;

    // Sort by run.json startedAt / mtime descending
    const withTime = dirs.map((name) => {
      const dir = path.join(this.outputDir, name);
      let time = 0;
      const runJson = path.join(dir, "run.json");
      if (fs.existsSync(runJson)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(runJson, "utf8")) as { startedAt?: string };
          if (parsed.startedAt) time = Date.parse(parsed.startedAt) || 0;
        } catch {
          // ignore
        }
      }
      if (!time) {
        try {
          time = fs.statSync(dir).mtimeMs;
        } catch {
          time = 0;
        }
      }
      return { name, time };
    });
    withTime.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
    return withTime[0]?.name ?? null;
  }

  private createLLMClient(cfg: SimConfig, rateLimiter: RateLimiter): LLMClient {
    if (cfg.MOCK_LLM) {
      return new MockLLMClient(cfg.SIM_SEED);
    }
    if (!cfg.GEMINI_API_KEY) {
      throw new RunManagerError(
        "GEMINI_API_KEY is missing in .env (enable Mock LLM mode or configure GEMINI_API_KEY).",
        400
      );
    }
    return new GeminiClient({
      apiKey: cfg.GEMINI_API_KEY,
      modelId: cfg.MODEL_ID,
      contextWindow: cfg.MODEL_CONTEXT_WINDOW,
      rateLimiter,
    });
  }

  private buildSummaryFromStore(
    runId: string,
    store: RunStore,
    meta: RunMetadata
  ): RunSummaryInfo {
    const isActive = this.activeSession?.runId === runId;
    const session = isActive ? this.activeSession! : null;
    const cpInfo = store.getLatestCheckpointInfo();
    const latestStats = store.readLatestStatsRow();

    let livingAgents: number | null = latestStats?.totalAlive ?? null;
    let ventrianaExists = latestStats ? latestStats.ventrianaRegionsCount > 0 : false;
    if (session?.latestState) {
      livingAgents = Object.values(session.latestState.agents).filter((a) => a.alive).length;
      ventrianaExists = Boolean(session.latestState.countries.ventriana?.exists);
    }

    const currentDay = session
      ? session.currentDay
      : cpInfo?.day ?? Math.max(0, meta.lastCompletedDay);
    const currentPhase = session
      ? session.currentPhase
      : cpInfo?.phase ?? meta.lastCompletedPhase;

    // If a run on disk had status "running" from an earlier terminated process, treat as paused/interrupted
    const effectiveStatus: RunMetadata["status"] = isActive
      ? session!.status
      : meta.status === "running"
        ? "paused"
        : meta.status;

    return {
      runId,
      status: effectiveStatus,
      isActiveLive: isActive,
      isPausedInMemory: session?.runner?.isPaused() ?? session?.queuedPause ?? false,
      isStopping: session?.stopRequested ?? false,
      seed: meta.seed,
      modelId: meta.modelId,
      mockLlm: meta.mockLlm,
      language: meta.language,
      promptVariant: meta.promptVariant,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      currentDay,
      currentPhase,
      targetDays: session?.targetDays ?? meta.config.SIM_DAYS,
      livingAgents,
      ventrianaExists,
      lastUpdatedAt: cpInfo?.savedAt ?? meta.endedAt ?? meta.startedAt,
    };
  }

  async listRuns(): Promise<RunSummaryInfo[]> {
    if (!fs.existsSync(this.outputDir)) return [];
    const dirs = fs
      .readdirSync(this.outputDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && RUN_ID_RE.test(d.name))
      .map((d) => d.name)
      .filter((name) => this.runExists(name));

    const results: RunSummaryInfo[] = [];
    for (const runId of dirs) {
      if (this.activeSession?.runId === runId) {
        const meta = await this.activeSession.store.getRunMetadata();
        if (meta) {
          results.push(this.buildSummaryFromStore(runId, this.activeSession.store, meta));
        }
        continue;
      }

      const dir = path.join(this.outputDir, runId);
      const store = new RunStore(dir);
      try {
        const meta = await store.getRunMetadata();
        if (!meta) continue;
        results.push(this.buildSummaryFromStore(runId, store, meta));
      } catch {
        // Skip unreadable/corrupt directory
      } finally {
        store.close();
      }
    }

    results.sort((a, b) => {
      if (a.isActiveLive !== b.isActiveLive) return a.isActiveLive ? -1 : 1;
      return b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId);
    });
    return results;
  }

  private async withStore<T>(
    runId: string,
    fn: (store: RunStore, isActive: boolean) => Promise<T>
  ): Promise<T> {
    const valid = this.validateRunId(runId);
    if (this.activeSession?.runId === valid) {
      return await fn(this.activeSession.store, true);
    }
    const dir = this.getRunDir(valid);
    if (!this.runExists(valid)) {
      throw new RunManagerError(`Run '${valid}' not found`, 404);
    }
    const store = new RunStore(dir);
    try {
      return await fn(store, false);
    } finally {
      store.close();
    }
  }

  async getRunDetails(requestedRunId?: string): Promise<RunSummaryResponse> {
    const runId = requestedRunId ? this.validateRunId(requestedRunId) : this.getPreferredRunId();
    if (!runId) {
      return {
        mode: this.mode,
        metadata: null,
        latestState: null,
        events: [],
        stats: [],
        health: {
          callsLastMinute: 0,
          totalCalls: 0,
          throttledCount: 0,
          rateLimit429Count: 0,
          retryCount: 0,
          invalidOutputCount: 0,
          safetyBlockCount: 0,
          promptTokensTotal: 0,
          completionTokensTotal: 0,
          cachedTokensTotal: 0,
          estimatedSecondsRemaining: null,
        },
        availableDays: [],
        isActiveLive: false,
        isPaused: false,
        isStopping: false,
        activeRunId: this.getActiveRunId(),
      };
    }

    return await this.withStore(runId, async (store, isActive) => {
      const rawMeta = await store.getRunMetadata();
      const session = isActive ? this.activeSession : null;
      const metadata = rawMeta
        ? {
            ...rawMeta,
            status:
              session?.status ??
              (!isActive && rawMeta.status === "running" ? "paused" : rawMeta.status),
            config: sanitizeConfig(rawMeta.config),
          }
        : null;
      const latest = await store.loadLatestSnapshot();
      const events = await store.readEvents(0);
      const stats = store.readAllStats();
      const summary = store.getLLMUsageSummary();
      const availableDays = store.getAvailableCheckpointDays();

      const health: RunHealthStats =
        isActive && session
          ? session.rateLimiter.getHealth()
          : {
              callsLastMinute: 0,
              totalCalls: summary.totalCalls,
              throttledCount: 0,
              rateLimit429Count: 0,
              retryCount: summary.retryCount,
              invalidOutputCount: summary.invalidOutputCount,
              safetyBlockCount: summary.safetyBlockCount,
              promptTokensTotal: summary.promptTokensTotal,
              completionTokensTotal: summary.completionTokensTotal,
              cachedTokensTotal: summary.cachedTokensTotal,
              estimatedSecondsRemaining: null,
            };

      return {
        mode: this.mode,
        metadata,
        latestState: latest?.state ?? session?.latestState ?? null,
        events,
        stats,
        health,
        availableDays,
        isActiveLive: isActive,
        isPaused:
          (session?.runner?.isPaused() ?? session?.queuedPause ?? false) ||
          metadata?.status === "paused",
        isStopping: session?.stopRequested ?? false,
        activeRunId: this.getActiveRunId(),
      };
    });
  }

  async getSnapshotDays(requestedRunId?: string): Promise<number[]> {
    const runId = requestedRunId ? this.validateRunId(requestedRunId) : this.getPreferredRunId();
    if (!runId) return [];
    return await this.withStore(runId, async (store) => store.getAvailableCheckpointDays());
  }

  async getSnapshotForDay(day: number, requestedRunId?: string): Promise<WorldState | null> {
    const runId = requestedRunId ? this.validateRunId(requestedRunId) : this.getPreferredRunId();
    if (!runId) return null;
    return await this.withStore(runId, async (store) => store.loadSnapshotForDay(day));
  }

  async getStreamInitMessage(requestedRunId?: string): Promise<StreamStateMessage | null> {
    const runId = requestedRunId ? this.validateRunId(requestedRunId) : this.getPreferredRunId();
    if (!runId) return null;
    return await this.withStore(runId, async (store, isActive) => {
      const meta = await store.getRunMetadata();
      const latest = await store.loadLatestSnapshot();
      const stats = store.readAllStats();
      const session = isActive ? this.activeSession : null;
      if (!meta || !latest) return null;
      return {
        type: "init",
        runId: meta.runId,
        day: latest.day,
        phase: latest.phase,
        status: session?.status ?? meta.status,
        isPaused: session?.runner?.isPaused() ?? session?.queuedPause ?? meta.status === "paused",
        isStopping: session?.stopRequested ?? false,
        targetDays: session?.targetDays ?? meta.config.SIM_DAYS,
        activeRunId: this.getActiveRunId(),
        state: latest.state,
        stats,
        health: session?.rateLimiter.getHealth(),
      };
    });
  }

  private assertLiveMode(): void {
    if (this.mode !== "live") {
      throw new RunManagerError("Server is running in read-only replay mode.", 400);
    }
  }

  private launchRunnerLoop(
    session: ActiveSession,
    state: WorldState,
    runConfig: SimConfig,
    llm: LLMClient,
    prompts: PromptLoader,
    resumeFrom?: { day: number; phase: PhaseName },
    autoStart: boolean = true
  ): SimulationRunner {
    const { runId, store, rateLimiter } = session;
    const runner = new SimulationRunner({
      state,
      config: runConfig,
      world: this.world,
      llm,
      prompts,
      storage: store,
      rateLimiter,
      phaseDelayMs: this.phaseDelayMs,
      onEvent: (ev) => {
        this.broadcast({
          type: "event",
          runId,
          day: ev.day,
          phase: ev.phase,
          status: session.status,
          isPaused: runner.isPaused(),
          isStopping: runner.isStopping(),
          targetDays: session.targetDays,
          activeRunId: this.getActiveRunId(),
          event: ev,
        });
      },
      onPhaseComplete: (day, phase, st) => {
        session.currentDay = day;
        session.currentPhase = phase;
        session.latestState = st;
        this.broadcast({
          type: "state_update",
          runId,
          day,
          phase,
          status: session.status,
          isPaused: runner.isPaused(),
          isStopping: runner.isStopping(),
          targetDays: session.targetDays,
          activeRunId: this.getActiveRunId(),
          state: st,
          stats: store.readAllStats(),
          health: rateLimiter.getHealth(),
        });
      },
      onStatusChange: (status, info) => {
        session.status = status;
        session.currentDay = info.day;
        session.currentPhase = info.phase;
        this.broadcast({
          type: "status",
          runId,
          day: info.day,
          phase: info.phase,
          status,
          isPaused: info.isPaused,
          isStopping: info.isStopping,
          targetDays: session.targetDays,
          activeRunId: this.getActiveRunId(),
          health: rateLimiter.getHealth(),
        });
        void this.broadcastRunsUpdated();
      },
    });

    session.runner = runner;
    if (session.queuedPause) {
      runner.pause();
    }

    const startLoop = () => {
      if (session.started || session.stopRequested) return;
      session.started = true;
      session.status = runner.isPaused() ? "paused" : "running";
      void store.updateRunMetadata({ status: session.status });

      session.runPromise = runner
        .runDays(session.targetDays, resumeFrom)
        .then(async (outcome) => {
          const finalStatus: RunMetadata["status"] = outcome.budgetStopped
            ? "budget_stopped"
            : outcome.stopped
              ? "paused"
              : "completed";
          session.status = finalStatus;
          session.currentDay = runner.state.day;
          session.currentPhase = runner.state.phase;
          session.latestState = runner.state;
          await store.updateRunMetadata({ status: finalStatus });
          const finalStats = store.readAllStats();
          const finalHealth = rateLimiter.getHealth();

          if (this.activeSession === session) {
            this.activeSession = null;
          }
          try {
            store.close();
          } catch {
            // already closed
          }

          this.broadcast({
            type: "state_update",
            runId,
            day: runner.state.day,
            phase: runner.state.phase,
            status: finalStatus,
            isPaused: finalStatus === "paused",
            isStopping: false,
            targetDays: session.targetDays,
            activeRunId: null,
            state: runner.state,
            stats: finalStats,
            health: finalHealth,
          });
        })
        .catch(async (err) => {
          console.error(`[Live Sim Error:${runId}]`, err);
          session.status = "failed";
          await store.updateRunMetadata({
            status: "failed",
            endedAt: new Date().toISOString(),
          });
          const finalHealth = rateLimiter.getHealth();

          if (this.activeSession === session) {
            this.activeSession = null;
          }
          try {
            store.close();
          } catch {
            // already closed
          }

          this.broadcast({
            type: "status",
            runId,
            day: runner.state.day,
            phase: runner.state.phase,
            status: "failed",
            isPaused: false,
            isStopping: false,
            targetDays: session.targetDays,
            activeRunId: null,
            health: finalHealth,
          });
        })
        .finally(async () => {
          if (this.activeSession === session) {
            this.activeSession = null;
          }
          await this.broadcastRunsUpdated();
        });
    };

    session.startFn = startLoop;
    if (autoStart) {
      startLoop();
    }
    return runner;
  }

  async createRun(req: CreateRunRequest): Promise<RunSummaryInfo> {
    this.assertLiveMode();

    const seed = req.seed !== undefined ? Math.trunc(Number(req.seed)) : this.baseConfig.SIM_SEED;
    if (!Number.isFinite(seed)) {
      throw new RunManagerError("Seed must be a finite number.", 400);
    }
    const days = req.days !== undefined ? Math.trunc(Number(req.days)) : this.baseConfig.SIM_DAYS;
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      throw new RunManagerError("Days must be between 1 and 365.", 400);
    }
    const language: "en" | "tr" = req.language === "tr" ? "tr" : req.language === "en" ? "en" : this.baseConfig.SIM_LANGUAGE;
    const promptVariant = req.promptVariant?.trim() || this.baseConfig.PROMPT_VARIANT;
    const mockLlm = req.mockLlm !== undefined ? Boolean(req.mockLlm) : this.baseConfig.MOCK_LLM;
    const autoStart = req.autoStart !== false;

    const runConfig: SimConfig = {
      ...this.baseConfig,
      SIM_SEED: seed,
      SIM_DAYS: days,
      SIM_LANGUAGE: language,
      PROMPT_VARIANT: promptVariant,
      MOCK_LLM: mockLlm,
    };

    if (!runConfig.MOCK_LLM && !runConfig.GEMINI_API_KEY) {
      throw new RunManagerError(
        "GEMINI_API_KEY is missing in .env (choose Mock LLM mode or configure GEMINI_API_KEY).",
        400
      );
    }

    const explicitId = req.runId?.trim();
    const runId = explicitId ? this.validateRunId(explicitId) : this.makeUniqueRunId(seed);
    const runDir = this.getRunDir(runId);

    if (explicitId && this.runExists(runId)) {
      throw new RunManagerError(`Run '${runId}' already exists.`, 409);
    }

    if (this.activeSession) {
      if (!req.stopActive) {
        throw new RunManagerError(
          `Simulation '${this.activeSession.runId}' is currently active.`,
          409,
          this.activeSession.runId
        );
      }
      await this.stopActiveRun();
    }

    const store = new RunStore(runDir);
    const rateLimiter = new RateLimiter({
      rpmLimit: runConfig.RPM_LIMIT,
      tpmLimit: runConfig.TPM_LIMIT,
      maxConcurrency: runConfig.MAX_CONCURRENCY,
      maxTotalCalls: runConfig.MAX_TOTAL_CALLS,
      dailyCallBudget: runConfig.DAILY_CALL_BUDGET,
    });
    const llm = this.createLLMClient(runConfig, rateLimiter);
    const prompts = new PromptLoader(language, promptVariant, this.promptsBaseDir);

    const meta: RunMetadata = {
      runId,
      seed,
      modelId: mockLlm ? "mock" : runConfig.MODEL_ID,
      mockLlm,
      language,
      promptVariant,
      gitCommit: getGitCommitHash(),
      specHash: computeSpecHash(),
      config: sanitizeConfig(runConfig),
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: autoStart ? "running" : "initialized",
      lastCompletedDay: -1,
      lastCompletedPhase: null,
    };
    await store.initRun(meta);

    const session: ActiveSession = {
      runId,
      store,
      rateLimiter,
      runner: null,
      targetDays: days,
      initializing: true,
      started: false,
      queuedPause: !autoStart,
      stopRequested: false,
      status: meta.status,
      currentDay: 0,
      currentPhase: "rollover",
      latestState: null,
      initPromise: null,
      runPromise: null,
      startFn: null,
    };
    this.activeSession = session;
    this.lastFocusedRunId = runId;
    await this.broadcastRunsUpdated();

    session.initPromise = (async () => {
      try {
        const state = await initializeWorld({
          config: runConfig,
          world: this.world,
          llm,
          prompts,
          emitEvent: async (ev) => {
            await store.appendEvent(ev);
            this.broadcast({
              type: "event",
              runId,
              day: ev.day,
              phase: ev.phase,
              status: session.status,
              isPaused: session.queuedPause,
              isStopping: session.stopRequested,
              targetDays: session.targetDays,
              activeRunId: this.getActiveRunId(),
              event: ev,
            });
          },
          logLLM: (entry) => store.appendLLMCall(entry),
        });
        await store.saveSnapshot(0, "rollover", state);
        await store.updateRunMetadata({
          lastCompletedDay: 0,
          lastCompletedPhase: "rollover",
        });
        session.latestState = state;
        session.initializing = false;

        if (session.stopRequested) {
          session.status = "paused";
          await store.updateRunMetadata({ status: "paused" });
          this.broadcast({
            type: "state_update",
            runId,
            day: 0,
            phase: "rollover",
            status: "paused",
            isPaused: true,
            isStopping: false,
            targetDays: session.targetDays,
            activeRunId: null,
            state,
            stats: store.readAllStats(),
            health: rateLimiter.getHealth(),
          });
          if (this.activeSession === session) {
            this.activeSession = null;
          }
          store.close();
          await this.broadcastRunsUpdated();
          return;
        }

        const shouldRunImmediately = autoStart || !session.queuedPause;
        this.launchRunnerLoop(
          session,
          state,
          runConfig,
          llm,
          prompts,
          { day: 0, phase: "rollover" },
          shouldRunImmediately
        );

        this.broadcast({
          type: "state_update",
          runId,
          day: 0,
          phase: "rollover",
          status: session.status,
          isPaused: session.runner?.isPaused() ?? session.queuedPause,
          isStopping: session.stopRequested,
          targetDays: session.targetDays,
          activeRunId: this.getActiveRunId(),
          state,
          stats: store.readAllStats(),
          health: rateLimiter.getHealth(),
        });
        await this.broadcastRunsUpdated();
      } catch (err) {
        console.error(`[Live Init Error:${runId}]`, err);
        session.initializing = false;
        session.status = "failed";
        await store.updateRunMetadata({
          status: "failed",
          endedAt: new Date().toISOString(),
        });
        if (this.activeSession === session) {
          this.activeSession = null;
        }
        try {
          store.close();
        } catch {
          // ignore
        }
        this.broadcast({
          type: "status",
          runId,
          day: 0,
          phase: "rollover",
          status: "failed",
          activeRunId: null,
        });
        await this.broadcastRunsUpdated();
      }
    })();

    // Yield one tick if quick mock mode, or return summary immediately
    const summary = this.buildSummaryFromStore(runId, store, meta);
    return summary;
  }

  async resumeRun(runIdInput: string, req: ResumeRunRequest = {}): Promise<RunSummaryInfo> {
    this.assertLiveMode();
    const runId = this.validateRunId(runIdInput);

    // Case 1: Already active in memory
    if (this.activeSession?.runId === runId) {
      const session = this.activeSession;
      session.queuedPause = false;
      if (session.initializing && session.initPromise) {
        session.status = "running";
        await session.store.updateRunMetadata({ status: "running" });
        await this.broadcastRunsUpdated();
      } else if (session.startFn && !session.started) {
        session.runner?.resume();
        session.startFn();
        await this.broadcastRunsUpdated();
      } else if (session.runner) {
        session.runner.resume();
        await this.broadcastRunsUpdated();
      }
      const meta = (await session.store.getRunMetadata())!;
      return this.buildSummaryFromStore(runId, session.store, meta);
    }

    // Case 2: Another active session exists
    if (this.activeSession) {
      if (!req.stopActive) {
        throw new RunManagerError(
          `Simulation '${this.activeSession.runId}' is currently active.`,
          409,
          this.activeSession.runId
        );
      }
      await this.stopActiveRun();
    }

    if (!this.runExists(runId)) {
      throw new RunManagerError(`Run '${runId}' not found`, 404);
    }

    const runDir = this.getRunDir(runId);
    const store = new RunStore(runDir);
    const meta = await store.getRunMetadata();
    const latest = await store.loadLatestSnapshot();
    if (!meta || !latest) {
      store.close();
      throw new RunManagerError(`Run '${runId}' has no checkpoint to resume from.`, 400);
    }

    const requestedDays = req.days !== undefined ? Math.trunc(Number(req.days)) : undefined;
    const targetDays = requestedDays ?? meta.config.SIM_DAYS;
    if (!Number.isFinite(targetDays) || targetDays < 1 || targetDays > 365) {
      store.close();
      throw new RunManagerError("Days must be between 1 and 365.", 400);
    }

    const isAtTargetEnd =
      latest.day >= targetDays - 1 && latest.phase === "end_of_day";
    if (isAtTargetEnd) {
      store.close();
      throw new RunManagerError(
        `Run '${runId}' already completed ${targetDays} days. Increase target days to continue.`,
        400
      );
    }

    const effectiveConfig: SimConfig = {
      ...this.baseConfig,
      ...meta.config,
      SIM_DAYS: targetDays,
      GEMINI_API_KEY: this.baseConfig.GEMINI_API_KEY,
    };

    if (!effectiveConfig.MOCK_LLM && !effectiveConfig.GEMINI_API_KEY) {
      store.close();
      throw new RunManagerError(
        "GEMINI_API_KEY is missing in .env to resume this Gemini simulation.",
        400
      );
    }

    const rateLimiter = new RateLimiter({
      rpmLimit: effectiveConfig.RPM_LIMIT,
      tpmLimit: effectiveConfig.TPM_LIMIT,
      maxConcurrency: effectiveConfig.MAX_CONCURRENCY,
      maxTotalCalls: effectiveConfig.MAX_TOTAL_CALLS,
      dailyCallBudget: effectiveConfig.DAILY_CALL_BUDGET,
    });
    rateLimiter.seedTotals(store.getLLMUsageSummary());

    const llm = this.createLLMClient(effectiveConfig, rateLimiter);
    const prompts = new PromptLoader(
      meta.language ?? effectiveConfig.SIM_LANGUAGE,
      meta.promptVariant ?? effectiveConfig.PROMPT_VARIANT,
      this.promptsBaseDir
    );

    const updatedMeta: RunMetadata = {
      ...meta,
      status: "running",
      endedAt: null,
      config: sanitizeConfig(effectiveConfig),
    };
    await store.updateRunMetadata({
      status: "running",
      endedAt: null,
      config: sanitizeConfig(effectiveConfig),
    });

    const session: ActiveSession = {
      runId,
      store,
      rateLimiter,
      runner: null,
      targetDays,
      initializing: false,
      started: false,
      queuedPause: false,
      stopRequested: false,
      status: "running",
      currentDay: latest.day,
      currentPhase: latest.phase,
      latestState: latest.state,
      initPromise: null,
      runPromise: null,
      startFn: null,
    };
    this.activeSession = session;
    this.lastFocusedRunId = runId;

    this.launchRunnerLoop(
      session,
      latest.state,
      effectiveConfig,
      llm,
      prompts,
      { day: latest.day, phase: latest.phase },
      true
    );

    this.broadcast({
      type: "state_update",
      runId,
      day: latest.day,
      phase: latest.phase,
      status: "running",
      isPaused: false,
      isStopping: false,
      targetDays,
      activeRunId: runId,
      state: latest.state,
      stats: store.readAllStats(),
      health: rateLimiter.getHealth(),
    });
    await this.broadcastRunsUpdated();

    return this.buildSummaryFromStore(runId, store, updatedMeta);
  }

  async startActiveOrRun(runIdInput?: string): Promise<{ ok: boolean; runId: string | null }> {
    this.assertLiveMode();
    const targetId = runIdInput ? this.validateRunId(runIdInput) : this.activeSession?.runId;
    if (!targetId) {
      throw new RunManagerError("No simulation selected to start.", 400);
    }
    await this.resumeRun(targetId);
    return { ok: true, runId: targetId };
  }

  async pauseActiveRun(runIdInput?: string): Promise<{ ok: boolean }> {
    this.assertLiveMode();
    if (!this.activeSession) {
      return { ok: true };
    }
    if (runIdInput && this.validateRunId(runIdInput) !== this.activeSession.runId) {
      throw new RunManagerError(
        `Run '${runIdInput}' is not the currently active live simulation.`,
        409
      );
    }
    this.activeSession.queuedPause = true;
    this.activeSession.runner?.pause();
    await this.broadcastRunsUpdated();
    return { ok: true };
  }

  async stepActiveRun(runIdInput?: string): Promise<{ ok: boolean }> {
    this.assertLiveMode();
    if (!this.activeSession) {
      return { ok: true };
    }
    if (runIdInput && this.validateRunId(runIdInput) !== this.activeSession.runId) {
      throw new RunManagerError(
        `Run '${runIdInput}' is not the currently active live simulation.`,
        409
      );
    }
    if (this.activeSession.initializing && this.activeSession.initPromise) {
      await this.activeSession.initPromise;
    }
    if (this.activeSession.startFn && !this.activeSession.started) {
      this.activeSession.queuedPause = true;
      this.activeSession.runner?.pause();
      this.activeSession.startFn();
    }
    if (this.activeSession.runner) {
      await this.activeSession.runner.stepOnePhase();
    }
    await this.broadcastRunsUpdated();
    return { ok: true };
  }

  async stopActiveRun(runIdInput?: string): Promise<{ ok: boolean; stoppedRunId: string | null }> {
    this.assertLiveMode();
    const session = this.activeSession;
    if (!session) {
      return { ok: true, stoppedRunId: null };
    }
    if (runIdInput && this.validateRunId(runIdInput) !== session.runId) {
      throw new RunManagerError(
        `Run '${runIdInput}' is not the currently active live simulation.`,
        409
      );
    }
    const stoppedRunId = session.runId;
    session.stopRequested = true;
    session.runner?.requestStop();

    if (session.initPromise) {
      await session.initPromise;
    }
    if (session.runPromise) {
      await session.runPromise;
    } else if (this.activeSession === session) {
      // Initialized but never started
      session.status = "paused";
      await session.store.updateRunMetadata({ status: "paused" });
      this.activeSession = null;
      try {
        session.store.close();
      } catch {
        // ignore
      }
      await this.broadcastRunsUpdated();
    }

    return { ok: true, stoppedRunId };
  }

  async waitForActiveInit(): Promise<void> {
    if (this.activeSession?.initPromise) {
      await this.activeSession.initPromise;
    }
  }

  async shutdown(): Promise<void> {
    if (this.activeSession) {
      await this.stopActiveRun().catch(() => {});
    }
  }
}
