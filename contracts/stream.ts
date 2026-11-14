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
  estimatedSecondsRemaining: number | null;
}

export interface StreamStateMessage {
  type: "init" | "state_update" | "event" | "health" | "status";
  runId: string;
  day: number;
  phase: PhaseName;
  status: RunMetadata["status"];
  state?: WorldState;
  event?: SimEvent;
  health?: RunHealthStats;
  stats?: DailyMetricsRow[];
}

export interface RunSummaryResponse {
  metadata: RunMetadata;
  latestState: WorldState;
  events: SimEvent[];
  stats: DailyMetricsRow[];
  health: RunHealthStats;
}
