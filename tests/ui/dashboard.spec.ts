import { expect, test } from "@playwright/test";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function waitForServer(port: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test.describe("Layer 6 — UI & Static Replay E2E", () => {
  const runId = "e2e_mock_run";
  const runDir = path.resolve("./runs", runId);

  test.beforeAll(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
    execSync(`MOCK_LLM=true bun run sim run --days 3 --run ${runId}`, {
      stdio: "inherit",
    });
    execSync(`bun run sim replay-build --run ${runId}`, {
      stdio: "inherit",
    });
  });

  test.afterAll(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test("static replay.html opens from file:// with no network and renders all panels, day slider, and spy toggle", async ({
    page,
  }) => {
    const replayHtmlPath = path.join(runDir, "replay.html");
    expect(fs.existsSync(replayHtmlPath)).toBe(true);

    await page.goto(`file://${replayHtmlPath}`);

    // Header
    await expect(
      page.getByText("Ventriana Sorunu · The Ventrian Question")
    ).toBeVisible();
    await expect(page.getByText("STATIC REPLAY")).toBeVisible();

    // Map
    await expect(page.getByRole("img", { name: "Map of Aldoria" })).toBeVisible();

    // Day slider changes day
    const slider = page.getByLabel("Replay day slider");
    await expect(slider).toBeVisible();
    await slider.fill("0");
    await slider.dispatchEvent("change");
    await expect(page.getByText("D0")).toBeVisible();

    // Click an agent in roster -> Agent panel renders
    await page.locator("button", { hasText: /\(\d+d/ }).first().click();
    await expect(page.getByText(/Diary \(\d+ entries\)/)).toBeVisible();

    // Spy toggle shows/hides private thoughts
    const spyBtn = page.getByRole("button", { name: /Spy:/ });
    await expect(spyBtn).toHaveText("Spy: OFF");
    await spyBtn.click();
    await expect(spyBtn).toHaveText("Spy: ON");
    await expect(page.getByText(/Spy: Private thoughts/)).toBeVisible();

    // Navigate through all tabs to verify every panel renders
    await page.getByRole("button", { name: "Social Feed" }).click();
    await expect(page.getByRole("button", { name: /Public feed/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Spy: DMs/ })).toBeVisible();

    await page.getByRole("button", { name: "Elections" }).click();
    await expect(page.getByRole("heading", { name: /Election history/ })).toBeVisible();

    await page.getByRole("button", { name: "Government & Curriculum" }).click();
    await expect(page.getByText("Governments, Laws & Curriculum Timeline")).toBeVisible();

    await page.getByRole("button", { name: "Charts" }).click();
    await expect(page.getByText("Ventrian dispersion & largest cluster")).toBeVisible();

    await page.getByRole("button", { name: "Culture Hall" }).click();
    await expect(page.getByText("Culture Hall of Fame")).toBeVisible();

    await page.getByRole("button", { name: "Event Log" }).click();
    await expect(page.getByText(/Event log \(\d+\)/)).toBeVisible();
  });

  test("static replay displays non-blocking Archive Briefing, 4-step Guided Tour, persists dismissal, and reopens via Guide button", async ({
    page,
  }) => {
    const replayHtmlPath = path.join(runDir, "replay.html");
    await page.goto(`file://${replayHtmlPath}`);

    const briefing = page.getByRole("region", { name: "Replay archive briefing" });
    await expect(briefing).toBeVisible();
    await expect(briefing.getByText("Archive Briefing")).toBeVisible();

    // Non-blocking: tabs and timeline controls remain immediately interactive
    await page.getByRole("button", { name: "Social Feed" }).click();
    await expect(page.getByText(/Public feed \(/)).toBeVisible();
    await page.getByRole("button", { name: "Map & Citizens" }).click();

    // Keyboard shortcut ArrowLeft / ArrowRight scrubs replay day cleanly
    const slider = page.getByRole("slider", { name: "Replay day slider" });
    const initialVal = Number(await slider.inputValue());
    const expectedPrev = Math.max(0, initialVal - 1);
    await page.locator("body").press("ArrowLeft");
    await expect(slider).toHaveValue(String(expectedPrev));
    await page.locator("body").press("ArrowRight");
    await expect(slider).toHaveValue(String(initialVal));

    // Launch 4-step Guided Tour and step through all 4 steps
    await page.getByRole("button", { name: "Start Guided Tour" }).click();
    const tourDialog = page.getByRole("dialog", { name: "Replay guided tour" });
    await expect(tourDialog).toBeVisible();
    await expect(briefing).toHaveCount(0);
    await expect(tourDialog.getByText("Step 1 of 4")).toBeVisible();

    await tourDialog.getByRole("button", { name: "Next step" }).click();
    await expect(tourDialog.getByText("Step 2 of 4")).toBeVisible();

    await tourDialog.getByRole("button", { name: "Next step" }).click();
    await expect(tourDialog.getByText("Step 3 of 4")).toBeVisible();

    await tourDialog.getByRole("button", { name: "Next step" }).click();
    await expect(tourDialog.getByText("Step 4 of 4")).toBeVisible();

    await tourDialog.getByRole("button", { name: "Finish tour" }).click();
    await expect(tourDialog).toHaveCount(0);

    // Reloading persists dismissal in localStorage
    await page.reload();
    await expect(page.getByRole("region", { name: "Replay archive briefing" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Replay guided tour" })).toHaveCount(0);

    // Header Guide button reopens Archive Briefing, and a second click opens the Tour
    const guideBtn = page.getByRole("button", { name: "Open archive guide" });
    await guideBtn.click();
    await expect(page.getByRole("region", { name: "Replay archive briefing" })).toBeVisible();
    await guideBtn.click();
    await expect(page.getByRole("dialog", { name: "Replay guided tour" })).toBeVisible();
  });

  test("replay-build --no-private strips Spy toggle, DMs, and private_thought", async ({
    page,
  }) => {
    execSync(`bun run sim replay-build --run ${runId} --no-private`, {
      stdio: "inherit",
    });
    const replayHtmlPath = path.join(runDir, "replay.html");
    await page.goto(`file://${replayHtmlPath}`);

    await expect(page.getByText("Privacy Redacted Export")).toBeVisible();
    await expect(page.getByRole("button", { name: /Spy:/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Social Feed" }).click();
    await expect(page.getByRole("button", { name: /Spy: DMs/ })).toHaveCount(0);
  });

  test("live mode streams SSE, supports pause/step/resume/stop controls, and recovers on reconnect", async ({
    page,
    context,
  }) => {
    const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "ventriana-e2e-live-"));
    const liveRunId = "e2e_live_run";
    const port = 8799;
    const proc: ChildProcess = spawn(
      "bun",
      ["run", "src/cli/index.ts", "serve", "--live", "--days", "8", "--run", liveRunId],
      {
        env: {
          ...process.env,
          MOCK_LLM: "true",
          UI_PORT: String(port),
          OUTPUT_DIR: tmpOut,
          LIVE_PHASE_DELAY_MS: "160",
        },
        stdio: "ignore",
      }
    );

    try {
      expect(await waitForServer(port)).toBe(true);

      await page.goto(`http://127.0.0.1:${port}`);
      await expect(page.getByText("LIVE", { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Run Health (Live)")).toBeVisible();
      await expect(page.getByText("Running", { exact: true }).first()).toBeVisible({ timeout: 5_000 });

      // Exercise Pause -> Step phase -> Resume
      await page.getByRole("button", { name: "Pause" }).click();
      await expect(page.getByRole("button", { name: "Resume" })).toBeVisible({ timeout: 5_000 });
      await page.getByRole("button", { name: "Step phase" }).click();
      await page.getByRole("button", { name: "Resume" }).click();
      await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 5_000 });

      // Simulate temporary network drop for SSE reconnect
      await context.setOffline(true);
      await new Promise((r) => setTimeout(r, 400));
      await context.setOffline(false);

      // Should remain connected / reconnect cleanly and render LIVE
      await expect(page.getByText("LIVE", { exact: true })).toBeVisible({ timeout: 10_000 });

      // Clean Stop frees slot and marks run paused
      await page.getByRole("button", { name: "Stop" }).click();
      await expect(page.getByRole("button", { name: "Resume" })).toBeVisible({ timeout: 5_000 });
    } finally {
      proc.kill("SIGTERM");
      fs.rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test("live control center onboarding, run creation modal, run switching, background status, resume conflict guard, and EN/TR toggle", async ({
    page,
  }) => {
    const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "ventriana-e2e-cc-"));
    const port = 8801;
    const proc: ChildProcess = spawn(
      "bun",
      ["run", "src/cli/index.ts", "serve", "--live"],
      {
        env: {
          ...process.env,
          MOCK_LLM: "true",
          UI_PORT: String(port),
          OUTPUT_DIR: tmpOut,
          LIVE_PHASE_DELAY_MS: "160",
        },
        stdio: "ignore",
      }
    );

    try {
      expect(await waitForServer(port)).toBe(true);
      await page.goto(`http://127.0.0.1:${port}`);

      // Empty Control Center + Live Onboarding Briefing & 5-step Guided Tour
      await expect(page.getByText("Welcome to the Aldoria Control Center")).toBeVisible({
        timeout: 10_000,
      });
      const briefing = page.getByRole("region", { name: "Live dashboard briefing" });
      await expect(briefing).toBeVisible();
      await briefing.getByRole("button", { name: "Start Guided Tour" }).click();

      const tour = page.getByRole("dialog", { name: "Live dashboard guided tour" });
      await expect(tour).toBeVisible();
      await expect(tour.getByText("Step 1 of 5")).toBeVisible();
      await tour.getByRole("button", { name: "Next step" }).click();
      await expect(tour.getByText("Step 2 of 5")).toBeVisible();
      await tour.getByRole("button", { name: "Next step" }).click();
      await expect(tour.getByText("Step 3 of 5")).toBeVisible();
      await tour.getByRole("button", { name: "Next step" }).click();
      await expect(tour.getByText("Step 4 of 5")).toBeVisible();
      await tour.getByRole("button", { name: "Next step" }).click();
      await expect(tour.getByText("Step 5 of 5")).toBeVisible();
      await tour.getByRole("button", { name: "Finish tour" }).click();
      await expect(tour).toHaveCount(0);

      // Persistence on reload + reopen via header Guide button
      await page.reload();
      await expect(page.getByRole("region", { name: "Live dashboard briefing" })).toHaveCount(0);
      await page.getByRole("button", { name: "Open dashboard guide" }).click();
      await expect(page.getByRole("region", { name: "Live dashboard briefing" })).toBeVisible();
      await page.getByRole("button", { name: "Dismiss briefing" }).click();

      // Launch sim_one via New Simulation modal
      await page.getByRole("button", { name: "Start first simulation" }).click();
      const modal = page.getByRole("dialog", { name: "Start a new simulation" });
      await expect(modal).toBeVisible();
      await modal.getByPlaceholder(/Auto-generated/).fill("sim_one");
      await modal.getByRole("button", { name: "Launch simulation" }).click();

      await expect(page.getByRole("img", { name: "Map of Aldoria" })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole("button", { name: "Switch simulation" })).toContainText(
        "sim_one"
      );

      // Pause then Stop sim_one cleanly
      await page.getByRole("button", { name: "Pause" }).click();
      await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
      await page.getByRole("button", { name: "Stop" }).click();
      await expect(page.getByRole("button", { name: "Resume" })).toBeVisible({ timeout: 5_000 });

      // Launch sim_two
      await page.getByRole("button", { name: "New simulation" }).click();
      const modal2 = page.getByRole("dialog", { name: "Start a new simulation" });
      await modal2.getByPlaceholder(/Auto-generated/).fill("sim_two");
      await modal2.getByRole("button", { name: "3d" }).click();
      await modal2.getByRole("button", { name: "14d" }).click();
      await modal2.getByRole("button", { name: "Launch simulation" }).click();

      await expect(page.getByRole("button", { name: "Switch simulation" })).toContainText(
        "sim_two",
        { timeout: 10_000 }
      );
      await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 5_000 });

      // Switch to sim_one while sim_two continues running in background
      await page.getByRole("button", { name: "Switch simulation" }).click();
      const switcher = page.getByRole("dialog", { name: "Switch simulation" });
      await expect(switcher).toBeVisible();
      await switcher.getByText("sim_one").click();

      await expect(page.getByText(/Live running in background:/)).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("sim_two")).toBeVisible();

      // Return to active live run button works
      await page.getByRole("button", { name: "Return to active live run" }).click();
      await expect(page.getByRole("button", { name: "Switch simulation" })).toContainText(
        "sim_two"
      );

      // Switch back to sim_one and test Resume conflict confirmation
      await page.getByRole("button", { name: "Switch simulation" }).click();
      await page.getByRole("dialog", { name: "Switch simulation" }).getByText("sim_one").click();
      await page.getByRole("button", { name: "Resume" }).click();
      await expect(page.getByText("Stop active simulation to resume?")).toBeVisible();
      await page.getByRole("button", { name: "Stop active & resume" }).click();
      await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 5_000 });

      // Toggle UI language to Turkish and back to English
      await page.getByRole("button", { name: "Switch dashboard language" }).click();
      await expect(page.getByRole("button", { name: "Duraklat" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Yeni Simülasyon" })).toBeVisible();
      await page.getByRole("button", { name: "Switch dashboard language" }).click();
      await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    } finally {
      proc.kill("SIGTERM");
      fs.rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test("follow live and historical day inspection work cleanly during an active run", async ({
    page,
  }) => {
    const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "ventriana-e2e-follow-"));
    const port = 8802;
    const proc: ChildProcess = spawn(
      "bun",
      ["run", "src/cli/index.ts", "serve", "--live", "--days", "6", "--run", "follow_sim"],
      {
        env: {
          ...process.env,
          MOCK_LLM: "true",
          UI_PORT: String(port),
          OUTPUT_DIR: tmpOut,
          LIVE_PHASE_DELAY_MS: "90",
        },
        stdio: "ignore",
      }
    );

    try {
      expect(await waitForServer(port)).toBe(true);
      await page.goto(`http://127.0.0.1:${port}`);

      // Wait until at least Day 1 completes so day slider appears with range >= 1
      const slider = page.getByLabel("Replay day slider");
      await expect(slider).toBeVisible({ timeout: 15_000 });
      await expect(async () => {
        const max = Number(await slider.getAttribute("max"));
        expect(max).toBeGreaterThanOrEqual(1);
      }).toPass({ timeout: 15_000 });

      // Scrub to Day 0 -> shows Follow Live button
      await slider.fill("0");
      await slider.dispatchEvent("change");
      await expect(page.getByRole("button", { name: /Follow Live/ })).toBeVisible({
        timeout: 5_000,
      });

      // Click Follow Live -> snaps back to live stream
      await page.getByRole("button", { name: /Follow Live/ }).click();
      await expect(page.getByRole("button", { name: /Follow Live/ })).toHaveCount(0);
    } finally {
      proc.kill("SIGTERM");
      fs.rmSync(tmpOut, { recursive: true, force: true });
    }
  });
});
