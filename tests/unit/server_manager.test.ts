import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/server/app.ts";
import { SimulationManager } from "../../src/server/run_manager.ts";

describe("SimulationManager & Control Center API", () => {
  test("creates, pauses, steps, resumes, stops, switches, and resumes from disk cleanly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ventriana-mgr-"));
    const { config, world } = loadConfig();
    config.OUTPUT_DIR = tmpDir;
    config.MOCK_LLM = true;
    config.GEMINI_API_KEY = "test-secret-should-not-leak";

    const manager = new SimulationManager({
      mode: "live",
      baseConfig: config,
      world,
      phaseDelayMs: 60,
    });
    const { app } = createApp({ manager });

    try {
      // 1. Empty state & config defaults (must never expose GEMINI_API_KEY)
      const defRes = await app.handle(new Request("http://localhost/api/config/defaults"));
      expect(defRes.status).toBe(200);
      const defJson = (await defRes.json()) as Record<string, unknown>;
      expect(defJson.hasGeminiKey).toBe(true);
      expect(JSON.stringify(defJson)).not.toContain("test-secret-should-not-leak");

      const emptyRunsRes = await app.handle(new Request("http://localhost/api/runs"));
      expect(emptyRunsRes.status).toBe(200);
      const emptyRunsJson = (await emptyRunsRes.json()) as { runs: unknown[]; activeRunId: string | null };
      expect(emptyRunsJson.runs).toEqual([]);
      expect(emptyRunsJson.activeRunId).toBeNull();

      // 2. Reject invalid runId
      const badCreate = await app.handle(
        new Request("http://localhost/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: "../escape", mockLlm: true, days: 2 }),
        })
      );
      expect(badCreate.status).toBe(400);

      // 3. Create first run paused at initialization (autoStart: false)
      const create1 = await app.handle(
        new Request("http://localhost/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: "alpha_run",
            seed: 11,
            days: 3,
            language: "en",
            promptVariant: "default",
            mockLlm: true,
            autoStart: false,
          }),
        })
      );
      expect(create1.status).toBe(201);
      await manager.waitForActiveInit();

      // Step one phase -> day 0 morning
      const stepRes = await app.handle(
        new Request("http://localhost/api/runs/alpha_run/step", { method: "POST" })
      );
      expect(stepRes.status).toBe(200);

      const alphaAfterStep = await app.handle(new Request("http://localhost/api/runs/alpha_run"));
      expect(alphaAfterStep.status).toBe(200);
      const alphaJson = (await alphaAfterStep.json()) as {
        metadata: { status: string; lastCompletedPhase: string };
        latestState: { day: number; phase: string };
        isActiveLive: boolean;
      };
      expect(alphaJson.isActiveLive).toBe(true);
      expect(alphaJson.latestState.day).toBe(0);
      expect(alphaJson.latestState.phase).toBe("morning");

      // 4. Attempting to create a second run without stopActive returns 409 Conflict
      const conflictRes = await app.handle(
        new Request("http://localhost/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: "beta_run",
            seed: 22,
            days: 2,
            mockLlm: true,
          }),
        })
      );
      expect(conflictRes.status).toBe(409);
      const conflictBody = (await conflictRes.json()) as { conflict: boolean; activeRunId: string };
      expect(conflictBody.conflict).toBe(true);
      expect(conflictBody.activeRunId).toBe("alpha_run");

      // 5. Stop alpha_run cleanly
      const stopRes = await app.handle(
        new Request("http://localhost/api/runs/alpha_run/stop", { method: "POST" })
      );
      expect(stopRes.status).toBe(200);
      expect(manager.getActiveRunId()).toBeNull();

      // Verify alpha_run persisted as paused on disk
      const alphaPausedRes = await app.handle(new Request("http://localhost/api/runs/alpha_run"));
      const alphaPaused = (await alphaPausedRes.json()) as {
        metadata: { status: string };
        isActiveLive: boolean;
      };
      expect(alphaPaused.isActiveLive).toBe(false);
      expect(alphaPaused.metadata.status).toBe("paused");

      // 6. Start beta_run (autoStart: true, fast)
      const create2 = await app.handle(
        new Request("http://localhost/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: "beta_run",
            seed: 22,
            days: 2,
            mockLlm: true,
            autoStart: true,
          }),
        })
      );
      expect(create2.status).toBe(201);

      // Pause beta_run while running, then stop it
      await manager.waitForActiveInit();
      const pauseBeta = await app.handle(
        new Request("http://localhost/api/runs/beta_run/pause", { method: "POST" })
      );
      expect(pauseBeta.status).toBe(200);
      await manager.stopActiveRun("beta_run");

      // 7. Resume alpha_run from disk and let it finish cleanly
      const resumeAlpha = await app.handle(
        new Request("http://localhost/api/runs/alpha_run/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
      );
      expect(resumeAlpha.status).toBe(200);

      // Wait until alpha_run finishes
      for (let i = 0; i < 60; i++) {
        if (!manager.getActiveRunId()) break;
        await new Promise((r) => setTimeout(r, 80));
      }
      expect(manager.getActiveRunId()).toBeNull();

      const runsListRes = await app.handle(new Request("http://localhost/api/runs"));
      const runsList = (await runsListRes.json()) as {
        runs: Array<{ runId: string; status: string; currentDay: number }>;
      };
      expect(runsList.runs.length).toBe(2);
      const alphaSummary = runsList.runs.find((r) => r.runId === "alpha_run");
      expect(alphaSummary?.status).toBe("completed");
      expect(alphaSummary?.currentDay).toBe(2);

      // 8. Snapshot lookup + 404 handling
      const snapRes = await app.handle(
        new Request("http://localhost/api/runs/alpha_run/snapshot/0")
      );
      expect(snapRes.status).toBe(200);
      const missingSnap = await app.handle(
        new Request("http://localhost/api/runs/alpha_run/snapshot/999")
      );
      expect(missingSnap.status).toBe(404);
      const missingRun = await app.handle(
        new Request("http://localhost/api/runs/nonexistent_run")
      );
      expect(missingRun.status).toBe(404);
    } finally {
      await manager.shutdown();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("replay-only mode rejects live mutation endpoints", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ventriana-replay-mgr-"));
    const { config, world } = loadConfig();
    config.OUTPUT_DIR = tmpDir;
    config.MOCK_LLM = true;

    const manager = new SimulationManager({
      mode: "replay",
      baseConfig: config,
      world,
    });
    const { app } = createApp({ manager });

    try {
      const res = await app.handle(
        new Request("http://localhost/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mockLlm: true, days: 1 }),
        })
      );
      expect(res.status).toBe(400);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
