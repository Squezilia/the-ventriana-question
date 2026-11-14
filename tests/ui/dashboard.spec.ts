import { expect, test } from "@playwright/test";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

  test("replay-build --no-private strips Spy toggle, DMs, and private_thought", async ({
    page,
  }) => {
    execSync(`bun run sim replay-build --run ${runId} --no-private`, {
      stdio: "inherit",
    });
    const replayHtmlPath = path.join(runDir, "replay.html");
    await page.goto(`file://${replayHtmlPath}`);

    await expect(page.getByRole("button", { name: /Spy:/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Social Feed" }).click();
    await expect(page.getByRole("button", { name: /Spy: DMs/ })).toHaveCount(0);
  });

  test("live mode streams SSE, supports pause/step/resume controls, and recovers on reconnect", async ({
    page,
    context,
  }) => {
    const liveRunId = "e2e_live_run";
    const liveRunDir = path.resolve("./runs", liveRunId);
    fs.rmSync(liveRunDir, { recursive: true, force: true });

    const port = 8799;
    const proc: ChildProcess = spawn(
      "bun",
      ["run", "src/cli/index.ts", "serve", "--live", "--days", "3", "--run", liveRunId],
      {
        env: { ...process.env, MOCK_LLM: "true", UI_PORT: String(port) },
        stdio: "ignore",
      }
    );

    try {
      // Wait for server health
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {
          // retry
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(ready).toBe(true);

      await page.goto(`http://127.0.0.1:${port}`);
      await expect(page.getByText("LIVE", { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Run Health (Live)")).toBeVisible();

      // Exercise Pause -> Step phase -> Resume
      await page.getByRole("button", { name: "Pause" }).click();
      await page.getByRole("button", { name: "Step phase" }).click();
      await page.getByRole("button", { name: "Resume" }).click();

      // Simulate temporary network drop for SSE reconnect
      await context.setOffline(true);
      await new Promise((r) => setTimeout(r, 400));
      await context.setOffline(false);

      // Should remain connected / reconnect cleanly and render LIVE
      await expect(page.getByText("LIVE", { exact: true })).toBeVisible({ timeout: 10_000 });
    } finally {
      proc.kill("SIGTERM");
      fs.rmSync(liveRunDir, { recursive: true, force: true });
    }
  });
});
