import { describe, expect, test } from "bun:test";
import type { Agent, SimConfig, WorldState } from "../../contracts/types.ts";
import { loadConfig } from "../../src/config.ts";
import { initializeWorld } from "../../src/engine/genesis.ts";
import {
  freezeCandidatesForCountry,
  handlePresidentDeath,
  isEligibleCandidateAge,
  isEligibleVoter,
  resolveCountryElection,
} from "../../src/governance/elections.ts";
import { resolveIndependenceDeclarations } from "../../src/governance/independence.ts";
import { executePresidentAction } from "../../src/governance/president.ts";
import { MockLLMClient } from "../../src/llm/mock_client.ts";
import { PromptLoader } from "../../src/llm/prompt_loader.ts";
import {
  endorseCandidate,
  foundParty,
  joinParty,
  removeAgentFromParty,
} from "../../src/social/parties.ts";
import {
  addLike,
  createPostOrReply,
  sendDirectMessage,
} from "../../src/social/social_network.ts";

async function makeTestWorld(seed = 42): Promise<{
  state: WorldState;
  config: SimConfig;
}> {
  const { config, world } = loadConfig();
  config.MOCK_LLM = true;
  config.SIM_SEED = seed;
  const llm = new MockLLMClient(seed);
  const prompts = new PromptLoader("en", "default");
  const state = await initializeWorld({
    config,
    world,
    llm,
    prompts,
    emitEvent: async () => {},
    logLLM: async () => {},
  });
  return { state, config };
}

describe("Unit Tests — Genesis & Age Distribution", () => {
  test("initializes 27 agents, 9 per nation, 3 per region, ages 0..26 each once", async () => {
    const { state } = await makeTestWorld(42);
    const agents = Object.values(state.agents);
    expect(agents.length).toBe(27);

    const nationCounts = { lyrians: 0, skalians: 0, ventrians: 0 };
    const regionCounts: Record<string, number> = {};
    const ages = new Set<number>();

    for (const a of agents) {
      nationCounts[a.nation] += 1;
      regionCounts[a.region] = (regionCounts[a.region] ?? 0) + 1;
      ages.add(a.age);
    }

    expect(nationCounts).toEqual({ lyrians: 9, skalians: 9, ventrians: 9 });
    expect(Object.values(regionCounts).every((c) => c === 3)).toBe(true);
    expect(ages.size).toBe(27);
    for (let i = 0; i <= 26; i++) {
      expect(ages.has(i)).toBe(true);
    }
  });
});

describe("Unit Tests — Eligibility & Candidate Selection", () => {
  test("candidate eligibility respects CANDIDACY_MIN_AGE and TERM_DAYS <= LIFESPAN_DAYS - 1", async () => {
    const { config } = await makeTestWorld();
    expect(isEligibleCandidateAge(9, config)).toBe(false);
    expect(isEligibleCandidateAge(10, config)).toBe(true);
    expect(isEligibleCandidateAge(20, config)).toBe(true);
    expect(isEligibleCandidateAge(21, config)).toBe(false);
  });

  test("freezeCandidatesForCountry picks oldest MAX_CANDIDATES_PER_NATION per nation with lower id tie-break", async () => {
    const { state, config } = await makeTestWorld();
    // Place 3 lyrians in marenth with ages 15, 15, 12
    const lyrians = Object.values(state.agents).filter((a) => a.nation === "lyrians");
    lyrians[0]!.region = "marenth";
    lyrians[0]!.age = 15;
    lyrians[1]!.region = "marenth";
    lyrians[1]!.age = 15;
    lyrians[2]!.region = "marenth";
    lyrians[2]!.age = 12;

    const frozen = freezeCandidatesForCountry(state, "lyria", config, 0);
    const frozenLyrians = frozen.filter((id) => state.agents[id]!.nation === "lyrians");
    expect(frozenLyrians.length).toBeLessThanOrEqual(config.MAX_CANDIDATES_PER_NATION);
  });

  test("voter eligibility respects EDUCATION_DAYS and disenfranchisement", async () => {
    const { state, config } = await makeTestWorld();
    const agent = Object.values(state.agents).find(
      (a) => state.regions[a.region]!.countryId === "lyria"
    )!;
    agent.age = config.EDUCATION_DAYS - 1;
    expect(isEligibleVoter(agent, "lyria", state, config)).toBe(false);

    agent.age = config.EDUCATION_DAYS;
    expect(isEligibleVoter(agent, "lyria", state, config)).toBe(true);

    state.countries.lyria.laws.votingRights[agent.nation] = false;
    expect(isEligibleVoter(agent, "lyria", state, config)).toBe(false);
  });
});

describe("Unit Tests — Elections, Tie-breakers & Succession", () => {
  test("regional plurality winner, total-votes tie-breaker, and succession on death", async () => {
    const { state, config } = await makeTestWorld();
    const cands = state.countries.lyria.frozenCandidates;
    expect(cands.length).toBeGreaterThanOrEqual(2);
    const c1 = cands[0]!;
    const c2 = cands[1]!;

    // c1 wins marenth (2 votes), c2 wins oslen (3 votes) -> 1 region each, c2 wins on total votes!
    state.pendingVotes = [
      { voterId: "v1", countryId: "lyria", regionId: "marenth", candidateId: c1 },
      { voterId: "v2", countryId: "lyria", regionId: "marenth", candidateId: c1 },
      { voterId: "v3", countryId: "lyria", regionId: "oslen", candidateId: c2 },
      { voterId: "v4", countryId: "lyria", regionId: "oslen", candidateId: c2 },
      { voterId: "v5", countryId: "lyria", regionId: "oslen", candidateId: c2 },
    ];

    const rec = resolveCountryElection(state, "lyria", config);
    expect(rec.winnerId).toBe(c2);
    expect(state.countries.lyria.presidentId).toBe(c2);
    expect(state.countries.lyria.lastElectionRunnerUpId).toBe(c1);

    // President dies -> runner-up c1 takes over
    state.agents[c2]!.alive = false;
    const successor = handlePresidentDeath(state, "lyria", c2, config);
    expect(successor).toBe(c1);
    expect(state.countries.lyria.presidentId).toBe(c1);
  });
});

describe("Unit Tests — President Powers, Budgets, Censorship & Independence", () => {
  test("decision budget decrements even on no-op, cede_region blocks last region", async () => {
    const { state, config } = await makeTestWorld();
    const lyria = state.countries.lyria;
    const pres = Object.values(state.agents).find(
      (a) => state.regions[a.region]!.countryId === "lyria" && a.age >= config.EDUCATION_DAYS
    )!;
    lyria.presidentId = pres.id;
    lyria.decisionsLeft = 3;

    // Leave only 1 region in lyria
    lyria.regions = [pres.region];
    for (const r of Object.values(state.regions)) {
      if (r.countryId === "lyria" && r.id !== pres.region) {
        r.countryId = "skalia";
        state.countries.skalia.regions.push(r.id);
      }
    }

    const res = executePresidentAction(
      state,
      pres,
      { type: "cede_region", region: pres.region, to_nation: "ventrians" },
      config
    );
    expect(res.succeeded).toBe(false);
    expect(lyria.decisionsLeft).toBe(2); // Consumed even on failed/no-op
  });

  test("censorship drops public posts by muted agent or banned phrase, DMs unaffected", async () => {
    const { state, config } = await makeTestWorld();
    const author = Object.values(state.agents).find(
      (a) => state.regions[a.region]!.countryId === "lyria" && a.age >= config.EDUCATION_DAYS
    )!;
    const target = Object.values(state.agents).find(
      (a) => a.id !== author.id && a.alive
    )!;

    state.countries.lyria.laws.censorship = {
      muteAgents: [],
      bannedPhrases: ["freedom"],
    };

    const p1 = createPostOrReply(state, author, "We demand freedom now!", null, config);
    expect(p1.accepted).toBe(true);
    expect(p1.censored).toBe(true);
    expect(author.pendingNotices.length).toBeGreaterThan(0);

    const dm1 = sendDirectMessage(state, author, target.name, "Secret freedom plan", config);
    expect(dm1.accepted).toBe(true);
  });

  test("social message budget, char limit truncation, and like budget", async () => {
    const { state, config } = await makeTestWorld();
    const author = Object.values(state.agents).find((a) => a.age >= config.EDUCATION_DAYS)!;
    const longText = "x".repeat(config.SOCIAL_CHAR_LIMIT + 50);

    for (let i = 0; i < config.SOCIAL_MSG_BUDGET; i++) {
      const res = createPostOrReply(state, author, longText, null, config);
      expect(res.accepted).toBe(true);
      expect(res.truncated).toBe(true);
      expect(res.post!.text.length).toBe(config.SOCIAL_CHAR_LIMIT);
    }
    const over = createPostOrReply(state, author, "extra", null, config);
    expect(over.accepted).toBe(false);

    // Like budget
    state.posts.forEach((p) => (p.deliveredDay = state.day));
    for (let i = 0; i < config.LIKE_BUDGET; i++) {
      const l = addLike(state, author, state.posts[i]!.id, config);
      expect(l.accepted).toBe(true);
    }
    const overLike = addLike(state, author, state.posts[config.LIKE_BUDGET]!.id, config);
    expect(overLike.accepted).toBe(false);
  });

  test("independence succeeds with >=3 Ventrians and >=0.67 share, fails otherwise", async () => {
    const { state, config } = await makeTestWorld();
    // Clear teshar and place 3 Ventrian adults + 1 Lyrian adult (3/4 = 0.75 >= 0.67)
    for (const a of Object.values(state.agents)) {
      if (a.region === "teshar") a.region = "marenth";
    }
    const vents = Object.values(state.agents).filter((a) => a.nation === "ventrians");
    vents[0]!.region = "teshar";
    vents[0]!.age = 10;
    vents[1]!.region = "teshar";
    vents[1]!.age = 11;
    vents[2]!.region = "teshar";
    vents[2]!.age = 12;

    const lyr = Object.values(state.agents).find((a) => a.nation === "lyrians")!;
    lyr.region = "teshar";
    lyr.age = 10;

    state.pendingIndependence = [{ agentId: vents[0]!.id, regionId: "teshar" }];
    const res = resolveIndependenceDeclarations(state, config);
    expect(res[0]!.succeeded).toBe(true);
    expect(state.countries.ventriana.exists).toBe(true);
    expect(state.regions.teshar!.countryId).toBe("ventriana");
    expect(state.countries.ventriana.curriculumText).toBe(state.archive);
  });

  test("party founding, joining, endorsement, leader succession, and dissolution", async () => {
    const { state, config } = await makeTestWorld();
    const adults = Object.values(state.agents).filter((a) => a.age >= config.EDUCATION_DAYS);
    const a1 = adults[0]!;
    const a2 = adults[1]!;

    const fp = foundParty(state, a1, "Unity", "For all", config);
    expect(fp.succeeded).toBe(true);
    const party = fp.party!;
    expect(party.leaderId).toBe(a1.id);

    const jp = joinParty(state, a2, party.id, config);
    expect(jp.succeeded).toBe(true);

    const end = endorseCandidate(state, a1, a2.id, config);
    expect(end.succeeded).toBe(true);
    expect(party.endorsedCandidateId).toBe(a2.id);

    // Leader leaves -> a2 becomes leader
    const rem1 = removeAgentFromParty(state, a1);
    expect(rem1.newLeaderId).toBe(a2.id);

    // Last member leaves -> party dissolves
    const rem2 = removeAgentFromParty(state, a2);
    expect(rem2.dissolvedPartyId).toBe(party.id);
    expect(party.dissolved).toBe(true);
  });
});
