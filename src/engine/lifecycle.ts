import crypto from "node:crypto";
import type { SimEvent } from "../../contracts/events.ts";
import type { LLMCallLogEntry, LLMClient } from "../../contracts/interfaces.ts";
import { WorldviewOutputSchema } from "../../contracts/schemas.ts";
import type {
  Agent,
  CountryId,
  SimConfig,
  WorldConfig,
  WorldState,
} from "../../contracts/types.ts";
import { handlePresidentDeath } from "../governance/elections.ts";
import type { PromptLoader } from "../llm/prompt_loader.ts";
import { removeAgentFromParty } from "../social/parties.ts";
import { generateUniqueName } from "./names.ts";
import { addNewsItem } from "./news.ts";
import { SeededPRNG } from "./prng.ts";

export interface RolloverContext {
  state: WorldState;
  config: SimConfig;
  world: WorldConfig;
  llm: LLMClient;
  prompts: PromptLoader;
  emitEvent: (ev: SimEvent) => Promise<void>;
  logLLM: (entry: LLMCallLogEntry) => Promise<void>;
}

export async function runRolloverPhase(ctx: RolloverContext): Promise<{
  deaths: number;
  births: number;
}> {
  const { state, config, world, llm, prompts, emitEvent, logLLM } = ctx;
  const prng = new SeededPRNG(state.prngState);
  let deaths = 0;
  let births = 0;

  if (state.day > 0) {
    const usedNames = new Set(Object.values(state.agents).map((a) => a.name));

    // 1. Increment ages & reset daily counters
    const livingAtStart = Object.values(state.agents).filter((a) => a.alive);
    for (const agent of livingAtStart) {
      agent.age += 1;
      agent.dailyCounters = {
        messagesSent: 0,
        likesGiven: 0,
        workPublished: false,
      };
    }

    // 2. Process deaths & same-day replacement births
    for (const agent of livingAtStart) {
      if (agent.age >= config.LIFESPAN_DAYS) {
        agent.alive = false;
        agent.deathDay = state.day;
        deaths += 1;

        const reg = state.regions[agent.region]!;
        let wasPresidentOf: CountryId | null = null;

        for (const cid of ["lyria", "skalia", "ventriana"] as CountryId[]) {
          const country = state.countries[cid];
          if (country.exists && country.presidentId === agent.id) {
            wasPresidentOf = cid;
            const newPresId = handlePresidentDeath(state, cid, agent.id, config);
            await emitEvent({
              id: `ev_succ_${state.day}_${cid}`,
              timestamp: new Date().toISOString(),
              day: state.day,
              phase: "rollover",
              actor: agent.id,
              type: "president_succession",
              payload: {
                countryId: cid,
                oldPresidentId: agent.id,
                newPresidentId: newPresId,
                reason: "death",
              },
            });
            addNewsItem(
              state,
              "world",
              null,
              `President ${agent.name} of ${country.name} has died. ${newPresId ? `${state.agents[newPresId]?.name} assumes the presidency.` : "No successor was available."}`
            );
          }
        }

        const partyRes = removeAgentFromParty(state, agent);
        if (partyRes.dissolvedPartyId) {
          await emitEvent({
            id: `ev_ptdiss_${state.day}_${partyRes.dissolvedPartyId}`,
            timestamp: new Date().toISOString(),
            day: state.day,
            phase: "rollover",
            actor: agent.id,
            type: "party_dissolved",
            payload: { partyId: partyRes.dissolvedPartyId },
          });
        } else if (partyRes.newLeaderId) {
          await emitEvent({
            id: `ev_ptlead_${state.day}_${partyRes.leftPartyId}`,
            timestamp: new Date().toISOString(),
            day: state.day,
            phase: "rollover",
            actor: partyRes.newLeaderId,
            type: "party_leader_changed",
            payload: { partyId: partyRes.leftPartyId, newLeaderId: partyRes.newLeaderId },
          });
        }

        await emitEvent({
          id: `ev_die_${state.day}_${agent.id}`,
          timestamp: new Date().toISOString(),
          day: state.day,
          phase: "rollover",
          actor: agent.id,
          type: "agent_died",
          payload: {
            agentId: agent.id,
            name: agent.name,
            nation: agent.nation,
            region: agent.region,
            age: agent.age,
            wasPresidentOf,
          },
        });
        addNewsItem(state, "region", agent.region, `${agent.name} passed away at age ${agent.age}.`);

        // Spawn replacement infant
        const numericId = state.nextIds.agent++;
        const newId = `a${numericId}`;
        const newName = generateUniqueName(agent.nation, world, usedNames, prng);
        const mbti = prng.pick(
          Object.keys(
            (await import("./mbti.ts")).MBTI_BLURBS
          ) as Array<Agent["mbti"]>
        );
        const { MBTI_BLURBS } = await import("./mbti.ts");

        const newborn: Agent = {
          id: newId,
          numericId,
          name: newName,
          nation: agent.nation,
          mbti,
          mbtiBlurb: MBTI_BLURBS[mbti],
          bornDay: state.day,
          age: 0,
          region: agent.region,
          lastMoveDay: null,
          backstory: `Born in ${reg.name} on Day ${state.day}, inheriting the memory of ${agent.name}.`,
          worldview: null,
          diary: [],
          will: agent.will,
          infancyTranscript: [],
          partyId: null,
          lastPartyFoundedDay: null,
          works: [],
          alive: true,
          deathDay: null,
          regionHistory: [{ day: state.day, region: agent.region }],
          votesCast: [],
          privateThoughts: [],
          dailyCounters: { messagesSent: 0, likesGiven: 0, workPublished: false },
          pendingNotices: [],
        };
        state.agents[newId] = newborn;
        births += 1;

        await emitEvent({
          id: `ev_born_${state.day}_${newId}`,
          timestamp: new Date().toISOString(),
          day: state.day,
          phase: "rollover",
          actor: newId,
          type: "agent_born",
          payload: {
            agentId: newId,
            name: newName,
            nation: newborn.nation,
            region: newborn.region,
            inheritedWill: newborn.will,
          },
        });
        addNewsItem(state, "region", newborn.region, `${newName} was born in ${reg.name}.`);
      }
    }
  }

  // 3. Education -> Worldview formation for agents reaching EDUCATION_DAYS
  const graduating = Object.values(state.agents).filter(
    (a) => a.alive && a.age === config.EDUCATION_DAYS && a.worldview === null
  );

  await Promise.all(
    graduating.map(async (agent) => {
      const reg = state.regions[agent.region]!;
      const country = state.countries[reg.countryId]!;
      const anthemWork = country.anthemWorkId
        ? state.works.find((w) => w.id === country.anthemWorkId)
        : null;

      const prompt = prompts.render("worldview", {
        name: agent.name,
        nation: agent.nation,
        region: reg.name,
        country: country.name,
        age: agent.age,
        mbti_blurb: agent.mbtiBlurb,
        curriculum: country.curriculumText,
        anthem_block: anthemWork
          ? `National anthem (${anthemWork.kind}): "${anthemWork.text}"\n`
          : "",
        infancy_heard:
          agent.infancyTranscript.length > 0
            ? agent.infancyTranscript.slice(-20).join("\n")
            : "(quiet childhood)",
        will_block: agent.will
          ? `Your predecessor's will left to you:\n"${agent.will}"`
          : "You received no predecessor's will.",
        worldview_words: config.WORLDVIEW_WORDS,
      });

      const callId = `d${state.day}_worldview_${agent.id}`;
      const res = await llm.generate({
        callId,
        day: state.day,
        phase: "rollover",
        agentId: agent.id,
        purpose: "worldview",
        prompt,
        schema: WorldviewOutputSchema,
      });

      await logLLM({
        callId,
        timestamp: new Date().toISOString(),
        day: state.day,
        phase: "rollover",
        agentId: agent.id,
        purpose: "worldview",
        promptHash: crypto.createHash("sha256").update(prompt).digest("hex"),
        ...(config.LOG_FULL_PROMPTS ? { prompt } : {}),
        rawResponse: res.rawText,
        parsedOk: res.success,
        retries: res.retries,
        safetyBlocked: res.safetyBlocked,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
        latencyMs: res.latencyMs,
        error: res.error,
      });

      const words = res.success && res.data
        ? res.data.worldview.trim().split(/\s+/).slice(0, config.WORLDVIEW_WORDS).join(" ")
        : "I will observe carefully and judge leaders by their deeds.";
      agent.worldview = words;

      await emitEvent({
        id: `ev_wv_${state.day}_${agent.id}`,
        timestamp: new Date().toISOString(),
        day: state.day,
        phase: "rollover",
        actor: agent.id,
        type: "worldview_formed",
        payload: { agentId: agent.id, name: agent.name, worldview: words },
      });
    })
  );

  state.prngState = prng.getState();
  return { deaths, births };
}
