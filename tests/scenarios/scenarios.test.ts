import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { WorldState } from "../../contracts/types.ts";
import { loadConfig } from "../../src/config.ts";
import { initializeWorld } from "../../src/engine/genesis.ts";
import { SimulationRunner } from "../../src/engine/loop.ts";
import { PromptLoader } from "../../src/llm/prompt_loader.ts";
import { ScriptedLLMClient, type ScriptedResponseRule } from "../../src/llm/scripted_client.ts";
import { buildAgentFeed } from "../../src/social/social_network.ts";
import { RunStore } from "../../src/storage/run_store.ts";

async function setupScenario(rules: ScriptedResponseRule[]) {
  const { config, world } = loadConfig();
  config.MOCK_LLM = true;
  const llm = new ScriptedLLMClient(rules);
  const prompts = new PromptLoader("en", "default");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ventriana-scen-"));
  const store = new RunStore(tmpDir);

  const state = await initializeWorld({
    config,
    world,
    llm,
    prompts,
    emitEvent: (ev) => store.appendEvent(ev),
    logLLM: (entry) => store.appendLLMCall(entry),
  });

  return { config, world, llm, prompts, store, state, tmpDir };
}

describe("Layer 2 — Scenario Tests (SPEC §18.1 item 2)", () => {
  const yamlData = YAML.parse(
    fs.readFileSync(path.join(process.cwd(), "tests/scenarios/scenarios.yaml"), "utf8")
  ) as { scenarios: Array<{ name: string }> };

  test("scenario list has all 10 required scenarios", () => {
    expect(yamlData.scenarios.length).toBe(10);
  });

  test("1. three Ventrians gather in Teshar and declare independence", async () => {
    const ctx = await setupScenario([]);
    try {
      // Clear teshar, place 3 Ventrian adults + 1 Lyrian adult
      for (const a of Object.values(ctx.state.agents)) {
        if (a.region === "teshar") a.region = "marenth";
      }
      const vents = Object.values(ctx.state.agents).filter((a) => a.nation === "ventrians");
      vents[0]!.region = "teshar"; vents[0]!.age = 12;
      vents[1]!.region = "teshar"; vents[1]!.age = 13;
      vents[2]!.region = "teshar"; vents[2]!.age = 14;
      const lyr = Object.values(ctx.state.agents).find((a) => a.nation === "lyrians")!;
      lyr.region = "teshar"; lyr.age = 12;

      const llm = new ScriptedLLMClient([
        {
          day: 0,
          agentId: vents[0]!.id,
          purpose: "morning",
          response: {
            private_thought: "Time for Ventriana.",
            actions: [{ type: "declare_independence", region: "teshar" }],
          },
        },
      ]);

      const runner = new SimulationRunner({
        state: ctx.state,
        config: ctx.config,
        world: ctx.world,
        llm,
        prompts: ctx.prompts,
        storage: ctx.store,
      });
      await runner.runDays(1);
      expect(runner.state.countries.ventriana.exists).toBe(true);
      expect(runner.state.regions.teshar!.countryId).toBe("ventriana");
    } finally {
      ctx.store.close();
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  test("2. independence fails due to border closure or insufficient share", async () => {
    const ctx = await setupScenario([]);
    try {
      // Put 2 Ventrians and 2 Lyrians in teshar (50% < 67%)
      for (const a of Object.values(ctx.state.agents)) {
        if (a.region === "teshar") a.region = "marenth";
      }
      const vents = Object.values(ctx.state.agents).filter((a) => a.nation === "ventrians");
      const lyrs = Object.values(ctx.state.agents).filter((a) => a.nation === "lyrians");
      vents[0]!.region = "teshar"; vents[0]!.age = 12;
      vents[1]!.region = "teshar"; vents[1]!.age = 13;
      lyrs[0]!.region = "teshar"; lyrs[0]!.age = 12;
      lyrs[1]!.region = "teshar"; lyrs[1]!.age = 13;

      // Close border of teshar for ventrians
      ctx.state.countries.lyria.laws.borders.teshar = ["ventrians"];

      const llm = new ScriptedLLMClient([
        {
          day: 0,
          agentId: vents[2]!.id,
          purpose: "morning",
          response: {
            private_thought: "Try to move to Teshar.",
            actions: [{ type: "move", region: "teshar" }],
          },
        },
        {
          day: 0,
          agentId: vents[0]!.id,
          purpose: "morning",
          response: {
            private_thought: "Declare anyway.",
            actions: [{ type: "declare_independence", region: "teshar" }],
          },
        },
      ]);

      const runner = new SimulationRunner({
        state: ctx.state,
        config: ctx.config,
        world: ctx.world,
        llm,
        prompts: ctx.prompts,
        storage: ctx.store,
      });
      await runner.runDays(1);
      expect(runner.state.countries.ventriana.exists).toBe(false);
      expect(runner.state.regions.teshar!.countryId).toBe("lyria");
      expect(vents[2]!.region).not.toBe("teshar");
    } finally {
      ctx.store.close();
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  test("3. curriculum rewrite appears in next infant worldview prompt while ARCHIVE is unchanged", async () => {
    const ctx = await setupScenario([]);
    try {
      const pres = Object.values(ctx.state.agents).find(
        (a) => ctx.state.regions[a.region]!.countryId === "lyria" && a.age >= ctx.config.EDUCATION_DAYS
      )!;
      ctx.state.countries.lyria.presidentId = pres.id;

      const infant = Object.values(ctx.state.agents).find(
        (a) => ctx.state.regions[a.region]!.countryId === "lyria" && a.age === ctx.config.EDUCATION_DAYS - 1
      )!;

      const newCurriculum = "LYRIA_REVISED_HISTORY_UNIQUE_TOKEN";
      const llm = new ScriptedLLMClient([
        {
          day: 0,
          agentId: pres.id,
          purpose: "morning",
          response: {
            private_thought: "Rewrite history.",
            actions: [{ type: "set_curriculum", text: newCurriculum }],
          },
        },
      ]);

      const runner = new SimulationRunner({
        state: ctx.state,
        config: ctx.config,
        world: ctx.world,
        llm,
        prompts: ctx.prompts,
        storage: ctx.store,
      });
      await runner.runDays(2);

      expect(runner.state.archive).not.toContain(newCurriculum);
      expect(runner.state.countries.lyria.curriculumText).toBe(newCurriculum);
      const wvPrompt = llm.recordedPrompts.find(
        (p) => p.purpose === "worldview" && p.agentId === infant.id
      );
      expect(wvPrompt).toBeDefined();
      expect(wvPrompt!.prompt).toContain(newCurriculum);
    } finally {
      ctx.store.close();
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  test("4. censorship mutes agent and post never reaches feed", async () => {
    const ctx = await setupScenario([]);
    try {
      const pres = Object.values(ctx.state.agents).find(
        (a) => ctx.state.regions[a.region]!.countryId === "lyria" && a.age >= ctx.config.EDUCATION_DAYS
      )!;
      const target = Object.values(ctx.state.agents).find(
        (a) => a.id !== pres.id && ctx.state.regions[a.region]!.countryId === "lyria" && a.age >= ctx.config.EDUCATION_DAYS
      )!;
      ctx.state.countries.lyria.presidentId = pres.id;
      // Ensure pres runs before target by making pres have lower numericId or setting censorship on day 0 and post on day 1
      const llm = new ScriptedLLMClient([
        {
          day: 0,
          agentId: pres.id,
          purpose: "morning",
          response: {
            private_thought: "Mute target.",
            actions: [{ type: "set_censorship", mute_agents: [target.id], banned_phrases: [] }],
          },
        },
        {
          day: 1,
          agentId: target.id,
          purpose: "morning",
          response: {
            private_thought: "Speak out.",
            actions: [{ type: "post", text: "HIDDEN_CENSORED_POST" }],
          },
        },
      ]);

      const runner = new SimulationRunner({
        state: ctx.state,
        config: ctx.config,
        world: ctx.world,
        llm,
        prompts: ctx.prompts,
        storage: ctx.store,
      });
      await runner.runDays(2);
      runner.state.day = 2;
      const feed = buildAgentFeed(runner.state, pres, ctx.config);
      expect(feed.some((p) => p.text.includes("HIDDEN_CENSORED_POST"))).toBe(false);
    } finally {
      ctx.store.close();
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  test("5. disenfranchisement applies from next election only", async () => {
    const ctx = await setupScenario([]);
    try {
      const ventVoter = Object.values(ctx.state.agents).find(
        (a) => a.nation === "ventrians" && ctx.state.regions[a.region]!.countryId === "lyria" && a.age >= ctx.config.EDUCATION_DAYS && a.age < 20
      )!;
      const candId = ctx.state.countries.lyria.frozenCandidates[0]!;
      // Make candId win Day 0 election in Lyria so candId is president on Day 1
      const lyriaVoter = Object.values(ctx.state.agents).find(
        (a) => a.id !== ventVoter.id && ctx.state.regions[a.region]!.countryId === "lyria" && a.age >= ctx.config.EDUCATION_DAYS
      )!;

      const llm = new ScriptedLLMClient([
        {
          day: 0,
          agentId: lyriaVoter.id,
          purpose: "morning",
          response: {
            private_thought: "Elect candId.",
            actions: [{ type: "vote", candidate_id: candId }],
          },
        },
        {
          day: 0,
          agentId: ventVoter.id,
          purpose: "morning",
          response: {
            private_thought: "Vote day 0.",
            actions: [{ type: "vote", candidate_id: candId }],
          },
        },
        {
          day: 1,
          agentId: candId,
          purpose: "morning",
          response: {
            private_thought: "Strip ventrian vote.",
            actions: [{ type: "set_voting_rights", nation: "ventrians", allowed: false }],
          },
        },
        {
          day: 7,
          agentId: ventVoter.id,
          purpose: "morning",
          response: {
            private_thought: "Try vote day 7.",
            actions: [{ type: "vote", candidate_id: candId }],
          },
        },
      ]);

      const runner = new SimulationRunner({
        state: ctx.state,
        config: ctx.config,
        world: ctx.world,
        llm,
        prompts: ctx.prompts,
        storage: ctx.store,
      });
      await runner.runDays(8);
      // Day 0 vote succeeded, Day 7 vote rejected
      expect(ventVoter.votesCast.some((v) => v.day === 0)).toBe(true);
      expect(ventVoter.votesCast.some((v) => v.day === 7)).toBe(false);
    } finally {
      ctx.store.close();
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  test("6. region-count tie goes to total-vote tie-break", async () => {
    const ctx = await setupScenario([]);
    try {
      const cands = ctx.state.countries.lyria.frozenCandidates;
      const c1 = cands[0]!;
      const c2 = cands[1]!;

      // Ensure enough adult voters in marenth and oslen
      for (const a of Object.values(ctx.state.agents)) {
        if (a.region === "marenth" || a.region === "oslen") {
          if (a.age < ctx.config.EDUCATION_DAYS) a.age = 10;
        }
      }
      const marenthVoters = Object.values(ctx.state.agents).filter(
        (a) => a.region === "marenth" && a.age >= ctx.config.EDUCATION_DAYS
      );
      const oslenVoters = Object.values(ctx.state.agents).filter(
        (a) => a.region === "oslen" && a.age >= ctx.config.EDUCATION_DAYS
      );
      expect(marenthVoters.length).toBeGreaterThanOrEqual(1);
      expect(oslenVoters.length).toBeGreaterThanOrEqual(2);

      const rules: ScriptedResponseRule[] = [
        {
          day: 0,
          agentId: marenthVoters[0]!.id,
          purpose: "morning",
          response: { private_thought: "v", actions: [{ type: "vote", candidate_id: c1 }] },
        },
        ...oslenVoters.slice(0, 2).map((v) => ({
          day: 0,
          agentId: v.id,
          purpose: "morning" as const,
          response: { private_thought: "v", actions: [{ type: "vote", candidate_id: c2 }] },
        })),
      ];

      const runner = new SimulationRunner({
        state: ctx.state,
        config: ctx.config,
        world: ctx.world,
        llm: new ScriptedLLMClient(rules),
        prompts: ctx.prompts,
        storage: ctx.store,
      });
      await runner.runDays(1);
      const el = runner.state.elections.find((e) => e.countryId === "lyria" && e.day === 0)!;
      expect(el.winnerId).toBe(c2);
    } finally {
      ctx.store.close();
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  test("7 & 8. president death -> runner-up succession, and will written & inherited by newborn", async () => {
    const ctx = await setupScenario([]);
    try {
      const dyingPres = Object.values(ctx.state.agents).find((a) => a.age === 26)!;
      dyingPres.age = ctx.config.LIFESPAN_DAYS - 1;
      const runnerUp = Object.values(ctx.state.agents).find(
        (a) =>
          a.id !== dyingPres.id &&
          ctx.state.regions[a.region]!.countryId === "lyria" &&
          a.age >= ctx.config.EDUCATION_DAYS
      )!;

      const llm = new ScriptedLLMClient([
        {
          day: 0,
          agentId: dyingPres.id,
          purpose: "evening",
          response: {
            private_thought: "My last night.",
            diary: "Farewell.",
            work: null,
            will: "INHERITED_WILL_TESTAMENT",
          },
        },
      ]);

      const runner = new SimulationRunner({
        state: ctx.state,
        config: ctx.config,
        world: ctx.world,
        llm,
        prompts: ctx.prompts,
        storage: ctx.store,
      });
      await runner.runDays(1);
      // Set president & runner-up right before Day 1 rollover
      runner.state.countries.lyria.presidentId = dyingPres.id;
      runner.state.countries.lyria.lastElectionRunnerUpId = runnerUp.id;
      await runner.runDays(2, { day: 0, phase: "end_of_day" });
      expect(dyingPres.alive).toBe(false);
      expect(runner.state.countries.lyria.presidentId).toBe(runnerUp.id);
      const newborn = Object.values(runner.state.agents).find((a) => a.bornDay === 1)!;
      expect(newborn.will).toBe("INHERITED_WILL_TESTAMENT");
    } finally {
      ctx.store.close();
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  test("9. move rejected during cooldown, moved agent votes where it stood at start of day", async () => {
    const ctx = await setupScenario([]);
    try {
      const mover = Object.values(ctx.state.agents).find(
        (a) => a.region === "marenth" && a.age >= ctx.config.EDUCATION_DAYS
      )!;
      const candId = ctx.state.countries.lyria.frozenCandidates[0]!;

      const llm = new ScriptedLLMClient([
        {
          day: 0,
          agentId: mover.id,
          purpose: "morning",
          response: {
            private_thought: "Vote in Lyria then move to Skalia.",
            actions: [
              { type: "vote", candidate_id: candId },
              { type: "move", region: "brenholt" },
            ],
          },
        },
        {
          day: 1,
          agentId: mover.id,
          purpose: "morning",
          response: {
            private_thought: "Try moving again during cooldown.",
            actions: [{ type: "move", region: "marenth" }],
          },
        },
      ]);

      const runner = new SimulationRunner({
        state: ctx.state,
        config: ctx.config,
        world: ctx.world,
        llm,
        prompts: ctx.prompts,
        storage: ctx.store,
      });
      await runner.runDays(2);
      expect(mover.votesCast.some((v) => v.day === 0 && v.countryId === "lyria")).toBe(true);
      expect(mover.region).toBe("brenholt"); // Day 1 move back to marenth was rejected by cooldown
    } finally {
      ctx.store.close();
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  test("10. party founded, joined, endorses candidate, and dissolves", async () => {
    const ctx = await setupScenario([]);
    try {
      const adults = Object.values(ctx.state.agents).filter(
        (a) => a.age >= ctx.config.EDUCATION_DAYS && a.age <= 20
      );
      const a1 = adults[0]!;
      const a2 = adults[1]!;

      const llm = new ScriptedLLMClient([
        {
          day: 0,
          agentId: a1.id,
          purpose: "morning",
          response: {
            private_thought: "Start party.",
            actions: [{ type: "found_party", name: "Dawn", manifesto: "New day" }],
          },
        },
        {
          day: 1,
          agentId: a1.id,
          purpose: "morning",
          response: {
            private_thought: "Endorse a2.",
            actions: [{ type: "endorse", candidate_id: a2.id }],
          },
        },
        {
          day: 2,
          agentId: a1.id,
          purpose: "morning",
          response: {
            private_thought: "Leave party.",
            actions: [{ type: "leave_party" }],
          },
        },
      ]);

      const runner = new SimulationRunner({
        state: ctx.state,
        config: ctx.config,
        world: ctx.world,
        llm,
        prompts: ctx.prompts,
        storage: ctx.store,
      });
      await runner.runDays(2);
      const party = Object.values(runner.state.parties)[0]!;
      expect(party.name).toBe("Dawn");
      expect(party.endorsedCandidateId).toBe(a2.id);
      await runner.runDays(3, { day: 1, phase: "end_of_day" });
      expect(party.dissolved).toBe(true);
    } finally {
      ctx.store.close();
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });
});
