import type { SimEvent } from "./events.ts";
import type { DailyMetricsRow, PhaseName, RunMetadata, WorldState } from "./types.ts";

export interface RunHealthStats {
  callsLastMinute: number;
  totalCalls: number;
  throttledCount: number;
  rateLimit429Count: number;
  retryCount: number;
  invalidOutputCount: number;
  safetyBlockCount: number;
  promptTokensTotal: number;
  completionTokensTotal: number;
  cachedTokensTotal?: number;
  estimatedSecondsRemaining: number | null;
}

export interface RunSummaryInfo {
  runId: string;
  status: RunMetadata["status"];
  isActiveLive: boolean;
  isPausedInMemory: boolean;
  isStopping: boolean;
  seed: number;
  modelId: string;
  mockLlm: boolean;
  language: "en" | "tr";
  promptVariant: string;
  startedAt: string;
  endedAt: string | null;
  currentDay: number;
  currentPhase: PhaseName | null;
  targetDays: number;
  livingAgents: number | null;
  ventrianaExists: boolean;
  lastUpdatedAt: string;
}

export interface ConfigDefaultsResponse {
  seed: number;
  days: number;
  language: "en" | "tr";
  promptVariant: string;
  mockLlm: boolean;
  modelId: string;
  hasGeminiKey: boolean;
  availableVariants: Record<"en" | "tr", string[]>;
}

export interface CreateRunRequest {
  runId?: string;
  seed?: number;
  days?: number;
  language?: "en" | "tr";
  promptVariant?: string;
  mockLlm?: boolean;
  autoStart?: boolean;
  stopActive?: boolean;
}

export interface ResumeRunRequest {
  days?: number;
  stopActive?: boolean;
}

export interface StreamStateMessage {
  type: "init" | "state_update" | "event" | "health" | "status" | "runs_updated";
  runId: string;
  day: number;
  phase: PhaseName;
  status: RunMetadata["status"];
  isPaused?: boolean;
  isStopping?: boolean;
  targetDays?: number;
  activeRunId?: string | null;
  runs?: RunSummaryInfo[];
  state?: WorldState;
  event?: SimEvent;
  health?: RunHealthStats;
  stats?: DailyMetricsRow[];
}

export interface RunSummaryResponse {
  mode?: "live" | "replay";
  metadata: RunMetadata | null;
  latestState: WorldState | null;
  events: SimEvent[];
  stats: DailyMetricsRow[];
  health: RunHealthStats;
  availableDays?: number[];
  isActiveLive?: boolean;
  isPaused?: boolean;
  isStopping?: boolean;
  activeRunId?: string | null;
}
