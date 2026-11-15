import crypto from "node:crypto";
import type { SimEvent } from "../../contracts/events.ts";
import type { LLMCallLogEntry, LLMClient } from "../../contracts/interfaces.ts";
import { GenesisOutputSchema } from "../../contracts/schemas.ts";
import type {
  Agent,
  Country,
  CountryId,
  Nation,
  Region,
  SimConfig,
  WorldConfig,
  WorldState,
} from "../../contracts/types.ts";
import { freezeCandidatesForCountry } from "../governance/elections.ts";
import type { PromptLoader } from "../llm/prompt_loader.ts";
import { MBTI_BLURBS, MBTI_TYPES } from "./mbti.ts";
import { generateUniqueName } from "./names.ts";
import { SeededPRNG } from "./prng.ts";

export interface GenesisContext {
  config: SimConfig;
  world: WorldConfig;
  llm: LLMClient;
  prompts: PromptLoader;
  emitEvent: (ev: SimEvent) => Promise<void>;
  logLLM: (entry: LLMCallLogEntry) => Promise<void>;
}

export async function initializeWorld(ctx: GenesisContext): Promise<WorldState> {
  const { config, world, llm, prompts, emitEvent, logLLM } = ctx;
  const prng = new SeededPRNG(config.SIM_SEED);
  const archive = prompts.loadTemplate("canon_history").trim();

  const regions: Record<string, Region> = {};
  for (const r of world.regions) {
    regions[r.id] = {
      id: r.id,
      name: r.name,
      countryId: r.initial_country,
      formerVentriana: r.former_ventriana,
      isCapital: r.is_capital,
    };
  }

  const countries: Record<CountryId, Country> = {
    lyria: buildInitialCountry("lyria", world, archive, config),
    skalia: buildInitialCountry("skalia", world, archive, config),
    ventriana: buildInitialCountry("ventriana", world, archive, config),
  };

  for (const r of world.regions) {
    countries[r.initial_country].regions.push(r.id);
    countries[r.initial_country].laws.borders[r.id] = [];
  }

  // Build 27 agents: 9 per nation, 3 per region, ages 0..26 each once, spread across nations
  const nations: Nation[] = ["lyrians", "skalians", "ventrians"];
  const perNation = Math.floor(config.NUM_AGENTS / 3);
  const agentSpecs: Array<{ nation: Nation; age: number }> = [];

  for (let i = 0; i < perNation; i++) {
    const shuffledNations = prng.shuffle(nations);
    for (let j = 0; j < 3; j++) {
      const age = i * 3 + j;
      agentSpecs.push({ nation: shuffledNations[j]!, age });
    }
  }
  // If NUM_AGENTS is not 27 (e.g. custom config), fill remainder
  while (agentSpecs.length < config.NUM_AGENTS) {
    const idx = agentSpecs.length;
    agentSpecs.push({
      nation: nations[idx % 3]!,
      age: idx % config.LIFESPAN_DAYS,
    });
  }

  // Assign 3 agents per region
  const regionSlots: string[] = [];
  const perRegion = Math.floor(config.NUM_AGENTS / world.regions.length);
  for (const r of world.regions) {
    for (let k = 0; k < perRegion; k++) {
      regionSlots.push(r.id);
    }
  }
  while (regionSlots.length < config.NUM_AGENTS) {
    regionSlots.push(world.regions[regionSlots.length % world.regions.length]!.id);
  }
  const shuffledRegions = prng.shuffle(regionSlots);
  const shuffledSpecs = prng.shuffle(agentSpecs);

  const usedNames = new Set<string>();
  const agents: Record<string, Agent> = {};
  let nextAgentNum = 1;

  const genesisJobs: Array<{ agent: Agent; job: string; family: string; fear: string; hope: string }> = [];

  for (let i = 0; i < config.NUM_AGENTS; i++) {
    const spec = shuffledSpecs[i]!;
    const regionId = shuffledRegions[i]!;
    const numericId = nextAgentNum++;
    const id = `a${numericId}`;
    const name = generateUniqueName(spec.nation, world, usedNames, prng);
    const mbti = prng.pick(MBTI_TYPES);

    const agent: Agent = {
      id,
      numericId,
      name,
      nation: spec.nation,
      mbti,
      mbtiBlurb: MBTI_BLURBS[mbti],
      bornDay: -spec.age,
      age: spec.age,
      region: regionId,
      lastMoveDay: null,
      backstory: null,
      worldview: null,
      diary: [],
      will: null,
      infancyTranscript: [],
      partyId: null,
      lastPartyFoundedDay: null,
      works: [],
      alive: true,
      deathDay: null,
      regionHistory: [{ day: 0, region: regionId }],
      votesCast: [],
      privateThoughts: [],
      dailyCounters: { messagesSent: 0, likesGiven: 0, workPublished: false },
      pendingNotices: [],
    };
    agents[id] = agent;

    if (agent.age >= config.EDUCATION_DAYS) {
      genesisJobs.push({
        agent,
        job: prng.pick(world.seed_traits.jobs),
        family: prng.pick(world.seed_traits.family_details),
        fear: prng.pick(world.seed_traits.fears),
        hope: prng.pick(world.seed_traits.hopes),
      });
    }
  }

  const genesisSystemPrompt =
    config.SIM_LANGUAGE === "tr"
      ? `Aldoria dünyasının bir vatandaşısın. Asla rolden çıkma. Yalnızca istenen şemaya uygun geçerli JSON ile yanıt ver.\n\nAldoria'nın resmi tarihi:\n${archive}`
      : `You are a citizen of the world of Aldoria. Never break character. Reply ONLY with valid JSON matching the required schema.\n\nCanon history of Aldoria:\n${archive}`;

  // Run genesis LLM calls in parallel (bounded by RateLimiter inside GeminiClient)
  await Promise.all(
    genesisJobs.map(async (item) => {
      const { agent } = item;
      const reg = regions[agent.region]!;
      const country = countries[reg.countryId]!;
      const prompt = prompts.render("genesis", {
        nation: agent.nation,
        region: reg.name,
        country: country.name,
        mbti_blurb: agent.mbtiBlurb,
        canon_history: archive,
        job: item.job,
        family: item.family,
        fear: item.fear,
        hope: item.hope,
        worldview_words: config.WORLDVIEW_WORDS,
      });

      const fullPromptForLog = `[SYSTEM]\n${genesisSystemPrompt}\n\n[USER]\n${prompt}`;
      const callId = `d0_genesis_${agent.id}`;
      const res = await llm.generate({
        callId,
        day: 0,
        phase: "rollover",
        agentId: agent.id,
        purpose: "genesis",
        systemPrompt: genesisSystemPrompt,
        prompt,
        schema: GenesisOutputSchema,
      });

      await logLLM({
        callId,
        timestamp: new Date().toISOString(),
        day: 0,
        phase: "rollover",
        agentId: agent.id,
        purpose: "genesis",
        promptHash: crypto.createHash("sha256").update(fullPromptForLog).digest("hex"),
        ...(config.LOG_FULL_PROMPTS ? { prompt: fullPromptForLog } : {}),
        rawResponse: res.rawText,
        parsedOk: res.success,
        retries: res.retries,
        safetyBlocked: res.safetyBlocked,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
        ...(res.cachedTokens ? { cachedTokens: res.cachedTokens } : {}),
        latencyMs: res.latencyMs,
        error: res.error,
      });

      if (res.success && res.data) {
        agent.backstory = res.data.backstory;
        agent.worldview = truncateWords(res.data.worldview, config.WORLDVIEW_WORDS);
      } else {
        agent.backstory = `A ${agent.nation} ${item.job} living in ${reg.name}, ${country.name}.`;
        agent.worldview = `Hopes for ${item.hope} while fearing ${item.fear}.`;
      }
    })
  );

  const state: WorldState = {
    day: 0,
    phase: "rollover",
    archive,
    nextIds: {
      agent: nextAgentNum,
      post: 1,
      dm: 1,
      party: 1,
      work: 1,
      news: 1,
    },
    prngState: prng.getState(),
    regions,
    countries,
    agents,
    parties: {},
    posts: [],
    dms: [],
    works: [],
    news: [],
    localChat: [],
    elections: [],
    pendingMoves: [],
    pendingIndependence: [],
    pendingVotes: [],
  };

  // Freeze day 0 candidates for existing countries
  for (const cid of ["lyria", "skalia"] as CountryId[]) {
    if (state.countries[cid].exists) {
      freezeCandidatesForCountry(state, cid, config, 0);
    }
  }

  for (const agent of Object.values(state.agents).sort((a, b) => a.numericId - b.numericId)) {
    await emitEvent({
      id: `ev_genesis_${agent.id}`,
      timestamp: new Date().toISOString(),
      day: 0,
      phase: "rollover",
      actor: agent.id,
      type: "agent_born",
      payload: {
        agentId: agent.id,
        name: agent.name,
        nation: agent.nation,
        region: agent.region,
        inheritedWill: null,
      },
    });
  }

  return state;
}

function buildInitialCountry(
  id: CountryId,
  world: WorldConfig,
  archive: string,
  config: SimConfig
): Country {
  const def = world.countries[id];
  return {
    id,
    name: def.name,
    exists: def.exists_at_start,
    regions: [],
    presidentId: null,
    curriculumText: archive,
    curriculumHistory: def.exists_at_start
      ? [{ day: 0, presidentId: null, text: archive }]
      : [],
    anthemWorkId: null,
    laws: {
      borders: {},
      censorship: { muteAgents: [], bannedPhrases: [] },
      votingRights: { lyrians: true, skalians: true, ventrians: true },
    },
    decisionsLeft: config.PRESIDENT_DECISIONS_PER_TERM,
    frozenCandidates: [],
    lastElectionRunnerUpId: null,
  };
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ");
}
