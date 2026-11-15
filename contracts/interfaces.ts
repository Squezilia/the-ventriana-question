import type { z } from "zod";
import type { SimEvent } from "./events.ts";
import type { DailyMetricsRow, PhaseName, RunMetadata, WorldState } from "./types.ts";

export interface LLMGenerateOptions<T> {
  callId: string;
  day: number;
  phase: PhaseName;
  agentId: string | null;
  purpose: "genesis" | "worldview" | "morning" | "local_chat" | "evening";
  prompt: string;
  schema: z.ZodType<T>;
  systemPrompt?: string;
}

export interface LLMGenerateResult<T> {
  success: boolean;
  data: T | null;
  rawText: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  latencyMs: number;
  retries: number;
  safetyBlocked: boolean;
  error?: string;
}

export interface LLMClient {
  readonly name: string;
  generate<T>(options: LLMGenerateOptions<T>): Promise<LLMGenerateResult<T>>;
}

export interface LLMCallLogEntry {
  callId: string;
  timestamp: string;
  day: number;
  phase: PhaseName;
  agentId: string | null;
  purpose: string;
  promptHash: string;
  prompt?: string;
  rawResponse: string;
  parsedOk: boolean;
  retries: number;
  safetyBlocked: boolean;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  latencyMs: number;
  error?: string;
}

export interface StorageAdapter {
  readonly runDir: string;
  initRun(metadata: RunMetadata): Promise<void>;
  updateRunMetadata(patch: Partial<RunMetadata>): Promise<void>;
  getRunMetadata(): Promise<RunMetadata | null>;
  saveSnapshot(day: number, phase: PhaseName, state: WorldState): Promise<void>;
  loadLatestSnapshot(): Promise<{ day: number; phase: PhaseName; state: WorldState } | null>;
  loadSnapshotForDay(day: number): Promise<WorldState | null>;
  appendEvent(event: SimEvent): Promise<void>;
  readEvents(afterIndex?: number): Promise<SimEvent[]>;
  appendLLMCall(entry: LLMCallLogEntry): Promise<void>;
  appendDailyStats(row: DailyMetricsRow): Promise<void>;
  close(): void;
}
