import { cors } from "@elysiajs/cors";
import { Elysia, t } from "elysia";
import fs from "node:fs";
import path from "node:path";
import type { SimEvent } from "../../contracts/events.ts";
import type { RunHealthStats, StreamStateMessage } from "../../contracts/stream.ts";
import type { PhaseName, RunMetadata, WorldState } from "../../contracts/types.ts";
import type { RunStore } from "../storage/run_store.ts";

export interface LiveController {
  start: () => void;
  pause: () => void;
  resume: () => void;
  step: () => Promise<void>;
  getHealth: () => RunHealthStats;
}

export interface ServerContext {
  mode: "live" | "replay";
  store: RunStore;
  liveController?: LiveController;
  webDistDir?: string;
}

export function createApp(ctx: ServerContext) {
  const sseClients = new Set<(msg: StreamStateMessage) => void>();

  const broadcast = (msg: StreamStateMessage) => {
    for (const send of sseClients) {
      try {
        send(msg);
      } catch {
        sseClients.delete(send);
      }
    }
  };

  const webDist = ctx.webDistDir ?? path.join(process.cwd(), "web", "dist");

  const app = new Elysia()
    .use(cors())
    .get("/api/health", () => ({ ok: true, mode: ctx.mode }))
    .get("/api/run", async () => {
      const metadata = await ctx.store.getRunMetadata();
      const latest = await ctx.store.loadLatestSnapshot();
      const events = await ctx.store.readEvents(0);
      const stats = ctx.store.readAllStats();
      const health: RunHealthStats = ctx.liveController
        ? ctx.liveController.getHealth()
        : {
            callsLastMinute: 0,
            totalCalls: 0,
            throttledCount: 0,
            rateLimit429Count: 0,
            retryCount: 0,
            invalidOutputCount: 0,
            safetyBlockCount: 0,
            promptTokensTotal: 0,
            completionTokensTotal: 0,
            estimatedSecondsRemaining: null,
          };
      return {
        mode: ctx.mode,
        metadata,
        latestState: latest?.state ?? null,
        events,
        stats,
        health,
      };
    })
    .get(
      "/api/snapshot/:day",
      async ({ params, status }) => {
        const snap = await ctx.store.loadSnapshotForDay(params.day);
        if (!snap) {
          return status(404, { error: `Snapshot for day ${params.day} not found` });
        }
        return snap;
      },
      {
        params: t.Object({ day: t.Numeric() }),
      }
    )
    .get("/api/snapshots", async () => {
      const stats = ctx.store.readAllStats();
      return { days: stats.map((s) => s.day) };
    })
    .post("/api/control/start", () => {
      if (ctx.mode !== "live" || !ctx.liveController) {
        return { ok: false, error: "Not in live mode" };
      }
      ctx.liveController.start();
      return { ok: true };
    })
    .post("/api/control/pause", () => {
      if (ctx.mode !== "live" || !ctx.liveController) {
        return { ok: false, error: "Not in live mode" };
      }
      ctx.liveController.pause();
      return { ok: true };
    })
    .post("/api/control/resume", () => {
      if (ctx.mode !== "live" || !ctx.liveController) {
        return { ok: false, error: "Not in live mode" };
      }
      ctx.liveController.resume();
      return { ok: true };
    })
    .post("/api/control/step", async () => {
      if (ctx.mode !== "live" || !ctx.liveController) {
        return { ok: false, error: "Not in live mode" };
      }
      await ctx.liveController.step();
      return { ok: true };
    })
    .get("/api/stream", ({ request }) => {
      let clientHandler: ((msg: StreamStateMessage) => void) | null = null;
      let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const push = (data: string) => {
            try {
              controller.enqueue(encoder.encode(data));
            } catch {
              // stream closed
            }
          };

          clientHandler = (msg: StreamStateMessage) => {
            push(`data: ${JSON.stringify(msg)}\n\n`);
          };
          sseClients.add(clientHandler);

          const meta = await ctx.store.getRunMetadata();
          const latest = await ctx.store.loadLatestSnapshot();
          const stats = ctx.store.readAllStats();
          if (meta && latest) {
            clientHandler({
              type: "init",
              runId: meta.runId,
              day: latest.day,
              phase: latest.phase,
              status: meta.status,
              state: latest.state,
              stats,
              health: ctx.liveController?.getHealth(),
            });
          }

          keepAliveTimer = setInterval(() => {
            push(`: ping\n\n`);
          }, 15_000);

          request.signal.addEventListener("abort", () => {
            if (keepAliveTimer) clearInterval(keepAliveTimer);
            if (clientHandler) sseClients.delete(clientHandler);
            try {
              controller.close();
            } catch {
              // already closed
            }
          });
        },
        cancel() {
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          if (clientHandler) sseClients.delete(clientHandler);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    })
    .get("/*", ({ path: reqPath, status }) => {
      if (!fs.existsSync(webDist)) {
        return status(
          404,
          "Web UI not built yet. Run `bun run build:web` first."
        );
      }
      const cleanPath = reqPath === "/" ? "/index.html" : reqPath;
      const candidate = path.join(webDist, cleanPath);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return Bun.file(candidate);
      }
      const fallback = path.join(webDist, "index.html");
      if (fs.existsSync(fallback)) {
        return Bun.file(fallback);
      }
      return status(404, "Not found");
    });

  return {
    app,
    broadcastEvent: (
      runId: string,
      status: RunMetadata["status"],
      event: SimEvent
    ) => {
      broadcast({
        type: "event",
        runId,
        day: event.day,
        phase: event.phase,
        status,
        event,
      });
    },
    broadcastState: (
      runId: string,
      day: number,
      phase: PhaseName,
      status: RunMetadata["status"],
      state: WorldState,
      stats: ReturnType<RunStore["readAllStats"]>,
      health?: RunHealthStats
    ) => {
      broadcast({
        type: "state_update",
        runId,
        day,
        phase,
        status,
        state,
        stats,
        health,
      });
    },
  };
}
