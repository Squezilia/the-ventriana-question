import { cors } from "@elysiajs/cors";
import { Elysia, t } from "elysia";
import fs from "node:fs";
import path from "node:path";
import type { StreamStateMessage } from "../../contracts/stream.ts";
import { RunManagerError, type SimulationManager } from "./run_manager.ts";

export interface ServerContext {
  manager: SimulationManager;
  webDistDir?: string;
}

export function createApp(ctx: ServerContext) {
  const { manager } = ctx;
  const webDist = ctx.webDistDir ?? path.join(process.cwd(), "web", "dist");

  const handleManagerCall = async <T>(
    fn: () => Promise<T>,
    setStatus: (code: number, body: unknown) => unknown
  ): Promise<T | unknown> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RunManagerError) {
        return setStatus(err.statusCode, {
          ok: false,
          error: err.message,
          conflict: err.statusCode === 409,
          activeRunId: err.conflictRunId ?? null,
        });
      }
      throw err;
    }
  };

  const app = new Elysia()
    .use(cors())
    .get("/api/health", () => ({
      ok: true,
      mode: manager.mode,
      activeRunId: manager.getActiveRunId(),
    }))
    .get("/api/config/defaults", () => manager.getConfigDefaults())
    .get("/api/runs", async () => ({
      mode: manager.mode,
      activeRunId: manager.getActiveRunId(),
      runs: await manager.listRuns(),
    }))
    .post(
      "/api/runs",
      async ({ body, status }) => {
        return await handleManagerCall(async () => {
          const run = await manager.createRun(body);
          return status(201, { ok: true, run });
        }, status);
      },
      {
        body: t.Object({
          runId: t.Optional(t.String()),
          seed: t.Optional(t.Number()),
          days: t.Optional(t.Number()),
          language: t.Optional(t.Union([t.Literal("en"), t.Literal("tr")])),
          promptVariant: t.Optional(t.String()),
          mockLlm: t.Optional(t.Boolean()),
          autoStart: t.Optional(t.Boolean()),
          stopActive: t.Optional(t.Boolean()),
        }),
      }
    )
    .get(
      "/api/runs/:runId",
      async ({ params, status }) =>
        handleManagerCall(() => manager.getRunDetails(params.runId), status),
      {
        params: t.Object({ runId: t.String() }),
      }
    )
    .get(
      "/api/runs/:runId/snapshots",
      async ({ params, status }) =>
        handleManagerCall(
          async () => ({ days: await manager.getSnapshotDays(params.runId) }),
          status
        ),
      {
        params: t.Object({ runId: t.String() }),
      }
    )
    .get(
      "/api/runs/:runId/snapshot/:day",
      async ({ params, status }) =>
        handleManagerCall(async () => {
          const snap = await manager.getSnapshotForDay(params.day, params.runId);
          if (!snap) {
            return status(404, {
              error: `Snapshot for run '${params.runId}' day ${params.day} not found`,
            });
          }
          return snap;
        }, status),
      {
        params: t.Object({ runId: t.String(), day: t.Numeric() }),
      }
    )
    .post(
      "/api/runs/:runId/resume",
      async ({ params, body, status }) =>
        handleManagerCall(async () => {
          const run = await manager.resumeRun(params.runId, body ?? {});
          return { ok: true, run };
        }, status),
      {
        params: t.Object({ runId: t.String() }),
        body: t.Optional(
          t.Object({
            days: t.Optional(t.Number()),
            stopActive: t.Optional(t.Boolean()),
          })
        ),
      }
    )
    .post(
      "/api/runs/:runId/pause",
      async ({ params, status }) =>
        handleManagerCall(() => manager.pauseActiveRun(params.runId), status),
      {
        params: t.Object({ runId: t.String() }),
      }
    )
    .post(
      "/api/runs/:runId/step",
      async ({ params, status }) =>
        handleManagerCall(() => manager.stepActiveRun(params.runId), status),
      {
        params: t.Object({ runId: t.String() }),
      }
    )
    .post(
      "/api/runs/:runId/stop",
      async ({ params, status }) =>
        handleManagerCall(() => manager.stopActiveRun(params.runId), status),
      {
        params: t.Object({ runId: t.String() }),
      }
    )
    .get(
      "/api/run",
      async ({ query, status }) =>
        handleManagerCall(() => manager.getRunDetails(query.runId), status),
      {
        query: t.Object({ runId: t.Optional(t.String()) }),
      }
    )
    .get(
      "/api/snapshots",
      async ({ query, status }) =>
        handleManagerCall(
          async () => ({ days: await manager.getSnapshotDays(query.runId) }),
          status
        ),
      {
        query: t.Object({ runId: t.Optional(t.String()) }),
      }
    )
    .get(
      "/api/snapshot/:day",
      async ({ params, query, status }) =>
        handleManagerCall(async () => {
          const snap = await manager.getSnapshotForDay(params.day, query.runId);
          if (!snap) {
            return status(404, { error: `Snapshot for day ${params.day} not found` });
          }
          return snap;
        }, status),
      {
        params: t.Object({ day: t.Numeric() }),
        query: t.Object({ runId: t.Optional(t.String()) }),
      }
    )
    .post(
      "/api/control/start",
      async ({ body, status }) =>
        handleManagerCall(() => manager.startActiveOrRun(body?.runId), status),
      {
        body: t.Optional(t.Object({ runId: t.Optional(t.String()) })),
      }
    )
    .post(
      "/api/control/pause",
      async ({ body, status }) =>
        handleManagerCall(() => manager.pauseActiveRun(body?.runId), status),
      {
        body: t.Optional(t.Object({ runId: t.Optional(t.String()) })),
      }
    )
    .post(
      "/api/control/resume",
      async ({ body, status }) =>
        handleManagerCall(async () => {
          const targetId =
            body?.runId ?? manager.getActiveRunId() ?? manager.getPreferredRunId();
          if (!targetId) {
            throw new RunManagerError("No simulation found to resume.", 404);
          }
          await manager.resumeRun(targetId);
          return { ok: true };
        }, status),
      {
        body: t.Optional(t.Object({ runId: t.Optional(t.String()) })),
      }
    )
    .post(
      "/api/control/step",
      async ({ body, status }) =>
        handleManagerCall(() => manager.stepActiveRun(body?.runId), status),
      {
        body: t.Optional(t.Object({ runId: t.Optional(t.String()) })),
      }
    )
    .post(
      "/api/control/stop",
      async ({ body, status }) =>
        handleManagerCall(() => manager.stopActiveRun(body?.runId), status),
      {
        body: t.Optional(t.Object({ runId: t.Optional(t.String()) })),
      }
    )
    .get(
      "/api/stream",
      ({ request, query }) => {
        const requestedRunId = query.runId;
        let unsubscribe: (() => void) | null = null;
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

            const sendMsg = (msg: StreamStateMessage) => {
              if (
                requestedRunId &&
                msg.type !== "runs_updated" &&
                msg.type !== "status" &&
                msg.runId !== requestedRunId
              ) {
                return;
              }
              push(`data: ${JSON.stringify(msg)}\n\n`);
            };

            unsubscribe = manager.subscribe(sendMsg);

            try {
              const initMsg = await manager.getStreamInitMessage(requestedRunId);
              if (request.signal.aborted) {
                unsubscribe?.();
                try {
                  controller.close();
                } catch {
                  // closed
                }
                return;
              }
              if (initMsg) {
                sendMsg(initMsg);
              }
              const runs = await manager.listRuns();
              if (!request.signal.aborted) {
                push(
                  `data: ${JSON.stringify({
                    type: "runs_updated",
                    runId: manager.getActiveRunId() ?? "",
                    day: initMsg?.day ?? 0,
                    phase: initMsg?.phase ?? "rollover",
                    status: initMsg?.status ?? "completed",
                    activeRunId: manager.getActiveRunId(),
                    runs,
                  } satisfies StreamStateMessage)}\n\n`
                );
              }
            } catch {
              // Run might not exist yet or have no snapshots yet; keep stream open for updates
            }

            keepAliveTimer = setInterval(() => {
              push(`: ping\n\n`);
            }, 15_000);

            request.signal.addEventListener("abort", () => {
              if (keepAliveTimer) clearInterval(keepAliveTimer);
              unsubscribe?.();
              try {
                controller.close();
              } catch {
                // already closed
              }
            });
          },
          cancel() {
            if (keepAliveTimer) clearInterval(keepAliveTimer);
            unsubscribe?.();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },
      {
        query: t.Object({ runId: t.Optional(t.String()) }),
      }
    )
    .get("/*", ({ path: reqPath, status }) => {
      if (!fs.existsSync(webDist)) {
        return status(
          404,
          "Web UI not built yet. Run `bun run build:web` first."
        );
      }
      const rootResolved = path.resolve(webDist);
      let decodedPath = "/";
      try {
        decodedPath = decodeURIComponent(reqPath);
      } catch {
        return status(400, "Bad request path");
      }
      const relPath = (decodedPath === "/" ? "/index.html" : decodedPath).replace(/^\/+/, "");
      const candidate = path.resolve(rootResolved, relPath);
      const isContained =
        candidate === rootResolved || candidate.startsWith(rootResolved + path.sep);
      if (!isContained) {
        return status(403, "Forbidden");
      }
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return Bun.file(candidate);
      }
      const fallback = path.join(rootResolved, "index.html");
      if (fs.existsSync(fallback)) {
        return Bun.file(fallback);
      }
      return status(404, "Not found");
    });

  return { app };
}
