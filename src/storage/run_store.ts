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
    const json = JSON.stringify(metadata, null, 2);
    fs.writeFileSync(this.runJsonPath, json, "utf8");
    this.db
      .prepare(`INSERT OR REPLACE INTO run_meta (id, json) VALUES (1, ?)`)
      .run(json);
  }

  async updateRunMetadata(patch: Partial<RunMetadata>): Promise<void> {
    const existing = await this.getRunMetadata();
    if (!existing) return;
    const updated = { ...existing, ...patch };
    const json = JSON.stringify(updated, null, 2);
    fs.writeFileSync(this.runJsonPath, json, "utf8");
    this.db
      .prepare(`INSERT OR REPLACE INTO run_meta (id, json) VALUES (1, ?)`)
      .run(json);
  }

  async getRunMetadata(): Promise<RunMetadata | null> {
    if (fs.existsSync(this.runJsonPath)) {
      return JSON.parse(fs.readFileSync(this.runJsonPath, "utf8")) as RunMetadata;
    }
    const row = this.db
      .prepare(`SELECT json FROM run_meta WHERE id = 1`)
      .get() as { json: string } | null;
    return row ? (JSON.parse(row.json) as RunMetadata) : null;
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
    return lines.slice(afterIndex).map((l) => JSON.parse(l) as SimEvent);
  }

  async appendLLMCall(entry: LLMCallLogEntry): Promise<void> {
    fs.appendFileSync(this.llmCallsPath, JSON.stringify(entry) + "\n", "utf8");
  }

  async appendDailyStats(row: DailyMetricsRow): Promise<void> {
    this.db
      .prepare(`INSERT OR REPLACE INTO daily_stats (day, json) VALUES (?, ?)`)
      .run(row.day, JSON.stringify(row));

    if (!this.csvHeaderWritten) {
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
      fs.writeFileSync(this.statsCsvPath, header + "\n", "utf8");
      this.csvHeaderWritten = true;
    }

    const values = [
      row.day,
      row.totalAlive,
      row.ventrianRegionsCount,
      row.largestVentrianCluster,
      row.lyriaRegionsCount,
      row.skaliaRegionsCount,
      row.ventrianaRegionsCount,
      JSON.stringify(row.lyriaPresident),
      JSON.stringify(row.lyriaPresidentNation),
      JSON.stringify(row.skaliaPresident),
      JSON.stringify(row.skaliaPresidentNation),
      JSON.stringify(row.ventrianaPresident),
      JSON.stringify(row.ventrianaPresidentNation),
      row.activeParties,
      row.postsCount,
      row.dmsCount,
      row.localChatCount,
      row.worksCount,
      row.deathsCount,
      row.birthsCount,
    ].join(",");
    fs.appendFileSync(this.statsCsvPath, values + "\n", "utf8");
  }

  readAllStats(): DailyMetricsRow[] {
    const rows = this.db
      .prepare(`SELECT json FROM daily_stats ORDER BY day ASC`)
      .all() as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as DailyMetricsRow);
  }

  close(): void {
    this.db.close();
  }
}
