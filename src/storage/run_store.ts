import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SimEvent } from "../../contracts/events.ts";
import type { LLMCallLogEntry, StorageAdapter } from "../../contracts/interfaces.ts";
import type {
  DailyMetricsRow,
  PhaseName,
  RunMetadata,
  WorldState,
} from "../../contracts/types.ts";
import { sanitizeConfig } from "../config.ts";

export function computeSpecHash(rootDir: string = process.cwd()): string {
  const specPath = path.join(rootDir, "SPEC.md");
  const fallbackPath = path.join(rootDir, "project-spec.md");
  const target = fs.existsSync(specPath) ? specPath : fallbackPath;
  if (!fs.existsSync(target)) return "missing";
  const content = fs.readFileSync(target);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function getGitCommitHash(rootDir: string = process.cwd()): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: rootDir, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export class RunStore implements StorageAdapter {
  readonly runDir: string;
  private readonly db: Database;
  private readonly eventsPath: string;
  private readonly llmCallsPath: string;
  private readonly statsCsvPath: string;
  private readonly runJsonPath: string;
  private readonly snapshotsDir: string;
  private csvHeaderWritten = false;
  private statsDaysWritten: Set<number> | null = null;

  constructor(runDir: string) {
    this.runDir = runDir;
    this.snapshotsDir = path.join(runDir, "snapshots");
    fs.mkdirSync(this.snapshotsDir, { recursive: true });

    this.eventsPath = path.join(runDir, "events.jsonl");
    this.llmCallsPath = path.join(runDir, "llm_calls.jsonl");
    this.statsCsvPath = path.join(runDir, "stats.csv");
    this.runJsonPath = path.join(runDir, "run.json");
    this.csvHeaderWritten = fs.existsSync(this.statsCsvPath);

    this.db = new Database(path.join(runDir, "state.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS run_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day INTEGER NOT NULL,
        phase TEXT NOT NULL,
        state_json TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        day INTEGER NOT NULL,
        phase TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_stats (
        day INTEGER PRIMARY KEY,
        json TEXT NOT NULL
      );
    `);
  }

  async initRun(metadata: RunMetadata): Promise<void> {
    const sanitized: RunMetadata = {
      ...metadata,
      config: sanitizeConfig(metadata.config),
    };
    const json = JSON.stringify(sanitized, null, 2);
    fs.writeFileSync(this.runJsonPath, json, "utf8");
    this.db
      .prepare(`INSERT OR REPLACE INTO run_meta (id, json) VALUES (1, ?)`)
      .run(json);
  }

  async updateRunMetadata(patch: Partial<RunMetadata>): Promise<void> {
    const existing = await this.getRunMetadata();
    if (!existing) return;
    const merged: RunMetadata = { ...existing, ...patch };
    const sanitized: RunMetadata = {
      ...merged,
      config: sanitizeConfig(merged.config),
    };
    const json = JSON.stringify(sanitized, null, 2);
    fs.writeFileSync(this.runJsonPath, json, "utf8");
    this.db
      .prepare(`INSERT OR REPLACE INTO run_meta (id, json) VALUES (1, ?)`)
      .run(json);
  }

  async getRunMetadata(): Promise<RunMetadata | null> {
    let raw: RunMetadata | null = null;
    if (fs.existsSync(this.runJsonPath)) {
      raw = JSON.parse(fs.readFileSync(this.runJsonPath, "utf8")) as RunMetadata;
    } else {
      const row = this.db
        .prepare(`SELECT json FROM run_meta WHERE id = 1`)
        .get() as { json: string } | null;
      raw = row ? (JSON.parse(row.json) as RunMetadata) : null;
    }
    if (!raw) return null;
    return {
      ...raw,
      config: sanitizeConfig(raw.config),
    };
  }

  async saveSnapshot(day: number, phase: PhaseName, state: WorldState): Promise<void> {
    const stateJson = JSON.stringify(state);
    this.db
      .prepare(
        `INSERT INTO checkpoints (day, phase, state_json, saved_at) VALUES (?, ?, ?, ?)`
      )
      .run(day, phase, stateJson, new Date().toISOString());

    if (phase === "end_of_day" || (day === 0 && phase === "rollover")) {
      const padded = String(day).padStart(3, "0");
      fs.writeFileSync(
        path.join(this.snapshotsDir, `day_${padded}.json`),
        stateJson,
        "utf8"
      );
    }
  }

  async loadLatestSnapshot(): Promise<{
    day: number;
    phase: PhaseName;
    state: WorldState;
  } | null> {
    const row = this.db
      .prepare(`SELECT day, phase, state_json FROM checkpoints ORDER BY id DESC LIMIT 1`)
      .get() as { day: number; phase: PhaseName; state_json: string } | null;
    if (!row) return null;
    return {
      day: row.day,
      phase: row.phase,
      state: JSON.parse(row.state_json) as WorldState,
    };
  }

  getLatestCheckpointInfo(): {
    day: number;
    phase: PhaseName;
    savedAt: string;
  } | null {
    const row = this.db
      .prepare(`SELECT day, phase, saved_at FROM checkpoints ORDER BY id DESC LIMIT 1`)
      .get() as { day: number; phase: PhaseName; saved_at: string } | null;
    if (!row) return null;
    return {
      day: row.day,
      phase: row.phase,
      savedAt: row.saved_at,
    };
  }

  async loadSnapshotForDay(day: number): Promise<WorldState | null> {
    const padded = String(day).padStart(3, "0");
    const filePath = path.join(this.snapshotsDir, `day_${padded}.json`);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as WorldState;
    }
    const row = this.db
      .prepare(
        `SELECT state_json FROM checkpoints WHERE day = ? ORDER BY id DESC LIMIT 1`
      )
      .get(day) as { state_json: string } | null;
    return row ? (JSON.parse(row.state_json) as WorldState) : null;
  }

  async appendEvent(event: SimEvent): Promise<void> {
    const line = JSON.stringify(event);
    fs.appendFileSync(this.eventsPath, line + "\n", "utf8");
    this.db
      .prepare(
        `INSERT INTO events (id, day, phase, type, actor, json) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(event.id, event.day, event.phase, event.type, event.actor, line);
  }

  async readEvents(afterIndex: number = 0): Promise<SimEvent[]> {
    if (!fs.existsSync(this.eventsPath)) return [];
    const lines = fs
      .readFileSync(this.eventsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const parsed: SimEvent[] = [];
    for (const line of lines.slice(afterIndex)) {
      try {
        parsed.push(JSON.parse(line) as SimEvent);
      } catch {
        // Ignore truncated trailing JSONL line from abrupt shutdown
      }
    }
    return parsed;
  }

  async appendLLMCall(entry: LLMCallLogEntry): Promise<void> {
    fs.appendFileSync(this.llmCallsPath, JSON.stringify(entry) + "\n", "utf8");
  }

  getAvailableCheckpointDays(): number[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT day FROM checkpoints ORDER BY day ASC`)
      .all() as Array<{ day: number }>;
    const daySet = new Set<number>(rows.map((r) => r.day));
    for (const s of this.readAllStats()) {
      daySet.add(s.day);
    }
    if (fs.existsSync(this.snapshotsDir)) {
      for (const file of fs.readdirSync(this.snapshotsDir)) {
        const m = file.match(/^day_(\d+)\.json$/);
        if (m?.[1]) daySet.add(Number(m[1]));
      }
    }
    return [...daySet].sort((a, b) => a - b);
  }

  getLLMUsageSummary(nowMs: number = Date.now()): {
    totalCalls: number;
    dailyCalls: number;
    retryCount: number;
    invalidOutputCount: number;
    safetyBlockCount: number;
    promptTokensTotal: number;
    completionTokensTotal: number;
    cachedTokensTotal: number;
  } {
    const summary = {
      totalCalls: 0,
      dailyCalls: 0,
      retryCount: 0,
      invalidOutputCount: 0,
      safetyBlockCount: 0,
      promptTokensTotal: 0,
      completionTokensTotal: 0,
      cachedTokensTotal: 0,
    };
    if (!fs.existsSync(this.llmCallsPath)) return summary;

    const nowDate = new Date(nowMs);
    const todayKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}-${String(nowDate.getDate()).padStart(2, "0")}`;

    for (const line of fs.readFileSync(this.llmCallsPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: LLMCallLogEntry;
      try {
        entry = JSON.parse(trimmed) as LLMCallLogEntry;
      } catch {
        continue;
      }
      summary.totalCalls += 1;
      summary.retryCount += entry.retries ?? 0;
      if (!entry.parsedOk && !entry.safetyBlocked) summary.invalidOutputCount += 1;
      if (entry.safetyBlocked) summary.safetyBlockCount += 1;
      summary.promptTokensTotal += entry.promptTokens ?? 0;
      summary.completionTokensTotal += entry.completionTokens ?? 0;
      summary.cachedTokensTotal += entry.cachedTokens ?? 0;
      if (entry.timestamp) {
        const tsDate = new Date(entry.timestamp);
        if (!Number.isNaN(tsDate.getTime())) {
          const entryKey = `${tsDate.getFullYear()}-${String(tsDate.getMonth() + 1).padStart(2, "0")}-${String(tsDate.getDate()).padStart(2, "0")}`;
          if (entryKey === todayKey) summary.dailyCalls += 1;
        }
      }
    }
    return summary;
  }

  async appendDailyStats(row: DailyMetricsRow): Promise<void> {
    if (!this.statsDaysWritten) {
      this.statsDaysWritten = new Set(this.readAllStats().map((r) => r.day));
    }
    const isOverwrite = this.statsDaysWritten.has(row.day);
    this.db
      .prepare(`INSERT OR REPLACE INTO daily_stats (day, json) VALUES (?, ?)`)
      .run(row.day, JSON.stringify(row));
    this.statsDaysWritten.add(row.day);

    const header = [
      "day",
      "totalAlive",
      "ventrianRegionsCount",
      "largestVentrianCluster",
      "lyriaRegionsCount",
      "skaliaRegionsCount",
      "ventrianaRegionsCount",
      "lyriaPresident",
      "lyriaPresidentNation",
      "skaliaPresident",
      "skaliaPresidentNation",
      "ventrianaPresident",
      "ventrianaPresidentNation",
      "activeParties",
      "postsCount",
      "dmsCount",
      "localChatCount",
      "worksCount",
      "deathsCount",
      "birthsCount",
    ].join(",");

    const formatRow = (r: DailyMetricsRow) =>
      [
        r.day,
        r.totalAlive,
        r.ventrianRegionsCount,
        r.largestVentrianCluster,
        r.lyriaRegionsCount,
        r.skaliaRegionsCount,
        r.ventrianaRegionsCount,
        JSON.stringify(r.lyriaPresident),
        JSON.stringify(r.lyriaPresidentNation),
        JSON.stringify(r.skaliaPresident),
        JSON.stringify(r.skaliaPresidentNation),
        JSON.stringify(r.ventrianaPresident),
        JSON.stringify(r.ventrianaPresidentNation),
        r.activeParties,
        r.postsCount,
        r.dmsCount,
        r.localChatCount,
        r.worksCount,
        r.deathsCount,
        r.birthsCount,
      ].join(",");

    if (!this.csvHeaderWritten || isOverwrite) {
      const allRows = this.readAllStats();
      const csvLines = [header, ...allRows.map(formatRow)];
      fs.writeFileSync(this.statsCsvPath, csvLines.join("\n") + "\n", "utf8");
      this.csvHeaderWritten = true;
    } else {
      fs.appendFileSync(this.statsCsvPath, formatRow(row) + "\n", "utf8");
    }
  }

  readAllStats(): DailyMetricsRow[] {
    const rows = this.db
      .prepare(`SELECT json FROM daily_stats ORDER BY day ASC`)
      .all() as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as DailyMetricsRow);
  }

  readLatestStatsRow(): DailyMetricsRow | null {
    const row = this.db
      .prepare(`SELECT json FROM daily_stats ORDER BY day DESC LIMIT 1`)
      .get() as { json: string } | null;
    return row ? (JSON.parse(row.json) as DailyMetricsRow) : null;
  }

  close(): void {
    this.db.close();
  }
}
