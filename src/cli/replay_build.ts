import fs from "node:fs";
import path from "node:path";
import type { SimEvent } from "../../contracts/events.ts";
import type { WorldState } from "../../contracts/types.ts";
import { RunStore } from "../storage/run_store.ts";

export interface ReplayBuildOptions {
  runDir: string;
  noPrivate?: boolean;
  webDistIndexHtml?: string;
}

function stripPrivateFromState(state: WorldState): WorldState {
  const cloned = JSON.parse(JSON.stringify(state)) as WorldState;
  cloned.dms = [];
  for (const agent of Object.values(cloned.agents)) {
    agent.privateThoughts = [];
  }
  return cloned;
}

function stripPrivateFromEvents(events: SimEvent[]): SimEvent[] {
  return events.filter(
    (e) => e.type !== "private_thought" && e.type !== "dm_sent"
  );
}

export async function buildStaticReplayHtml(opts: ReplayBuildOptions): Promise<string> {
  const distHtmlPath =
    opts.webDistIndexHtml ?? path.join(process.cwd(), "web", "dist", "index.html");
  if (!fs.existsSync(distHtmlPath)) {
    throw new Error(
      `Web UI bundle not found at ${distHtmlPath}. Run \`bun run build:web\` first.`
    );
  }

  const store = new RunStore(opts.runDir);
  try {
    const metadata = await store.getRunMetadata();
    if (!metadata) {
      throw new Error(`Run metadata not found in ${opts.runDir}`);
    }
    const stats = store.readAllStats();
    let events = await store.readEvents(0);
    const snapshots: Record<number, WorldState> = {};

    const days = stats.length > 0 ? stats.map((s) => s.day) : [0];
    for (const d of days) {
      const snap = await store.loadSnapshotForDay(d);
      if (snap) {
        snapshots[d] = opts.noPrivate ? stripPrivateFromState(snap) : snap;
      }
    }
    if (Object.keys(snapshots).length === 0) {
      const latest = await store.loadLatestSnapshot();
      if (latest) {
        snapshots[latest.day] = opts.noPrivate
          ? stripPrivateFromState(latest.state)
          : latest.state;
      }
    }

    if (opts.noPrivate) {
      events = stripPrivateFromEvents(events);
    }

    const payload = {
      mode: "static" as const,
      metadata,
      snapshots,
      events,
      stats,
      noPrivate: Boolean(opts.noPrivate),
    };

    const templateHtml = fs.readFileSync(distHtmlPath, "utf8");
    const serialized = JSON.stringify(payload).replace(/<\/script>/gi, "<\\/script>");
    const injection = `<script>window.__VENTRIANA_REPLAY_DATA__ = ${serialized};</script>`;
    const outputHtml = templateHtml.replace("</head>", `${injection}\n</head>`);

    const outPath = path.join(opts.runDir, "replay.html");
    fs.writeFileSync(outPath, outputHtml, "utf8");
    return outPath;
  } finally {
    store.close();
  }
}
