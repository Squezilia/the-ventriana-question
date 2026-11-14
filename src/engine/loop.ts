import crypto from "node:crypto";
import type { SimEvent } from "../../contracts/events.ts";
import type { LLMCallLogEntry, LLMClient, StorageAdapter } from "../../contracts/interfaces.ts";
import {
  buildAllowedMorningSchema,
  EveningOutputSchema,
  LocalChatOutputSchema,
} from "../../contracts/schemas.ts";
import type {
  Agent,
  CountryId,
  DailyMetricsRow,
  Nation,
  PhaseName,
  RegionId,
  SimConfig,
  WorldConfig,
  WorldState,
} from "../../contracts/types.ts";
import {
  buildCandidateCards,
  freezeCandidatesForCountry,
  isEligibleVoter,
  resolveCountryElection,
} from "../governance/elections.ts";
import { canQueueIndependence, resolveIndependenceDeclarations } from "../governance/independence.ts";
import { executePresidentAction, isPresidentAction } from "../governance/president.ts";
import type { PromptLoader } from "../llm/prompt_loader.ts";
import type { RateLimiter } from "../llm/rate_limiter.ts";
import { publishWork } from "../social/culture.ts";
import {
  endorseCandidate,
  foundParty,
  getActivePartiesDirectory,
  joinParty,
  removeAgentFromParty,
} from "../social/parties.ts";
import {
  addLike,
  buildAgentFeed,
  createPostOrReply,
  getAgentDeliveredDms,
  sendDirectMessage,
} from "../social/social_network.ts";
import { runRolloverPhase } from "./lifecycle.ts";
import { addNewsItem, generateEndOfDayNews, getNewsForAgent } from "./news.ts";
import { SeededPRNG } from "./prng.ts";

export interface SimulationRunnerOptions {
  state: WorldState;
  config: SimConfig;
  world: WorldConfig;
  llm: LLMClient;
  prompts: PromptLoader;
  storage: StorageAdapter;
  rateLimiter?: RateLimiter;
  onEvent?: (event: SimEvent) => void;
  onPhaseComplete?: (day: number, phase: PhaseName, state: WorldState) => void;
}

const PHASE_ORDER: readonly PhaseName[] = [
  "rollover",
  "morning",
  "local_chat",
  "evening",
  "end_of_day",
];

export class SimulationRunner {
  public state: WorldState;
  private readonly config: SimConfig;
  private readonly world: WorldConfig;
  private readonly llm: LLMClient;
  private readonly prompts: PromptLoader;
  private readonly storage: StorageAdapter;
  private readonly rateLimiter?: RateLimiter;
  private readonly onEvent?: (event: SimEvent) => void;
  private readonly onPhaseComplete?: (day: number, phase: PhaseName, state: WorldState) => void;

  private eventSeq = 1;
  private dayDeaths = 0;
  private dayBirths = 0;
  private paused = false;
  private pauseResolvers: Array<() => void> = [];
  private stepBudget = 0;
  private stepDoneResolvers: Array<() => void> = [];
  private isRunningLoop = false;

  constructor(opts: SimulationRunnerOptions) {
    this.state = opts.state;
    this.config = opts.config;
    this.world = opts.world;
    this.llm = opts.llm;
    this.prompts = opts.prompts;
    this.storage = opts.storage;
    this.rateLimiter = opts.rateLimiter;
    this.onEvent = opts.onEvent;
    this.onPhaseComplete = opts.onPhaseComplete;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.stepBudget = 0;
    const resolvers = this.pauseResolvers.splice(0);
    for (const r of resolvers) r();
  }

  isPaused(): boolean {
    return this.paused;
  }

  async stepOnePhase(): Promise<void> {
    if (!this.isRunningLoop) return;
    this.paused = true;
    const donePromise = new Promise<void>((resolve) => {
      this.stepDoneResolvers.push(resolve);
    });
    if (this.pauseResolvers.length > 0) {
      this.stepBudget += 1;
      const resolvers = this.pauseResolvers.splice(0);
      for (const r of resolvers) r();
    } else {
      // A phase is currently in-flight; wait for it to finish
    }
    await donePromise;
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    if (this.stepBudget > 0) {
      this.stepBudget -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.pauseResolvers.push(resolve);
    });
    if (this.paused && this.stepBudget > 0) {
      this.stepBudget -= 1;
    }
  }

  private async emit(event: Omit<SimEvent, "id" | "timestamp">): Promise<void> {
    const full = {
      ...event,
      id: `ev_${this.state.day}_${this.state.phase}_${this.eventSeq++}`,
      timestamp: new Date().toISOString(),
    } as SimEvent;
    await this.storage.appendEvent(full);
    this.onEvent?.(full);
  }

  private async logLLM(entry: LLMCallLogEntry): Promise<void> {
    await this.storage.appendLLMCall(entry);
  }

  async runDays(targetEndDayExclusive: number, resumeFromLastCompleted?: { day: number; phase: PhaseName }): Promise<{
    completed: boolean;
    budgetStopped: boolean;
    reason?: string;
  }> {
    let startDay = this.state.day;
    let startPhaseIdx = 0;

    if (resumeFromLastCompleted) {
      const idx = PHASE_ORDER.indexOf(resumeFromLastCompleted.phase);
      if (idx >= 0 && idx < PHASE_ORDER.length - 1) {
        startDay = resumeFromLastCompleted.day;
        startPhaseIdx = idx + 1;
      } else {
        startDay = resumeFromLastCompleted.day + 1;
        startPhaseIdx = 0;
      }
    }

    this.isRunningLoop = true;
    try {
      for (let day = startDay; day < targetEndDayExclusive; day++) {
        this.state.day = day;
        if (day > startDay) {
          this.rateLimiter?.resetDailyCounter();
        }
        const firstIdx = day === startDay ? startPhaseIdx : 0;

        for (let pIdx = firstIdx; pIdx < PHASE_ORDER.length; pIdx++) {
          await this.waitIfPaused();
          const phase = PHASE_ORDER[pIdx]!;
          await this.runSinglePhase(phase);
          const stepResolvers = this.stepDoneResolvers.splice(0);
          for (const r of stepResolvers) r();

          if (this.rateLimiter) {
            const budget = this.rateLimiter.isBudgetExhausted();
            if (budget.exhausted) {
              await this.storage.updateRunMetadata({
                status: "budget_stopped",
                lastCompletedDay: day,
                lastCompletedPhase: phase,
              });
              return { completed: false, budgetStopped: true, reason: budget.reason };
            }
          }
        }
      }

      await this.storage.updateRunMetadata({
        status: "completed",
        endedAt: new Date().toISOString(),
        lastCompletedDay: targetEndDayExclusive - 1,
        lastCompletedPhase: "end_of_day",
      });
      return { completed: true, budgetStopped: false };
    } finally {
      this.isRunningLoop = false;
      const stepResolvers = this.stepDoneResolvers.splice(0);
      for (const r of stepResolvers) r();
    }
  }

  async runSinglePhase(phase: PhaseName): Promise<void> {
    this.state.phase = phase;
    await this.emit({
      day: this.state.day,
      phase,
      actor: null,
      type: "phase_started",
      payload: { phase },
    });

    switch (phase) {
      case "rollover": {
        this.dayDeaths = 0;
        this.dayBirths = 0;
        const res = await runRolloverPhase({
          state: this.state,
          config: this.config,
          world: this.world,
          llm: this.llm,
          prompts: this.prompts,
          emitEvent: async (ev) => {
            await this.storage.appendEvent(ev);
            this.onEvent?.(ev);
          },
          logLLM: (entry) => this.logLLM(entry),
        });
        this.dayDeaths = res.deaths;
        this.dayBirths = res.births;
        break;
      }
      case "morning":
        await this.runMorningPhase();
        break;
      case "local_chat":
        await this.runLocalChatPhase();
        break;
      case "evening":
        await this.runEveningPhase();
        break;
      case "end_of_day":
        await this.runEndOfDayPhase();
        break;
    }

    await this.storage.saveSnapshot(this.state.day, phase, this.state);
    await this.storage.updateRunMetadata({
      lastCompletedDay: this.state.day,
      lastCompletedPhase: phase,
    });
    await this.emit({
      day: this.state.day,
      phase,
      actor: null,
      type: "phase_completed",
      payload: { phase },
    });
    this.onPhaseComplete?.(this.state.day, phase, this.state);
  }

  private async runMorningPhase(): Promise<void> {
    const adults = Object.values(this.state.agents).filter(
      (a) => a.alive && a.age >= this.config.EDUCATION_DAYS
    );
    const isElectionDay = this.state.day % this.config.TERM_DAYS === 0;

    // 1. Parallel LLM calls for all living adults
    const results = await Promise.all(
      adults.map(async (agent) => {
        const reg = this.state.regions[agent.region]!;
        const country = this.state.countries[reg.countryId]!;
        const canMove =
          agent.lastMoveDay === null ||
          this.state.day - agent.lastMoveDay >= this.config.MOVE_COOLDOWN_DAYS;
        const canVote =
          isElectionDay && isEligibleVoter(agent, country.id, this.state, this.config);
        const party = agent.partyId ? this.state.parties[agent.partyId] : null;
        const isPartyLeader = Boolean(party && !party.dissolved && party.leaderId === agent.id);
        const isPresident = country.exists && country.presidentId === agent.id;
        const canDeclareIndependence =
          this.config.ENABLE_INDEPENDENCE &&
          agent.nation === "ventrians" &&
          reg.countryId !== "ventriana";

        const schema = buildAllowedMorningSchema({
          canMove,
          canVote,
          isPartyLeader,
          canDeclareIndependence,
          isPresident,
        });

        const allowedList = ["post", "reply", "dm", "like", "found_party", "join_party", "leave_party"];
        if (canMove) allowedList.push("move");
        if (canVote) allowedList.push("vote");
        if (isPartyLeader) allowedList.push("endorse");
        if (canDeclareIndependence) allowedList.push("declare_independence");
        if (isPresident) {
          allowedList.push(
            "set_curriculum",
            "set_border",
            "set_censorship",
            "set_voting_rights",
            "cede_region",
            "adopt_anthem",
            "decree"
          );
        }

        const roster = Object.values(this.state.agents)
          .filter((a) => a.alive && a.region === agent.region)
          .map((a) => {
            const pName = a.partyId && this.state.parties[a.partyId] ? this.state.parties[a.partyId]!.name : "none";
            const presFlag = country.presidentId === a.id ? ", PRESIDENT" : "";
            const stage = a.age < this.config.EDUCATION_DAYS ? "infant" : "adult";
            return `- ${a.name} (${a.id}, ${a.nation}, age ${a.age}, ${stage}, party: ${pName}${presFlag})`;
          })
          .join("\n");

        const yesterdayChat = this.state.localChat
          .filter((c) => c.regionId === agent.region && c.day === this.state.day - 1)
          .slice(-20)
          .map((c) => `[R${c.round}] ${c.agentName}: ${c.text}`)
          .join("\n") || "(none)";

        const newsItems = getNewsForAgent(this.state, reg.id, country.id, this.state.day);
        const newsText = newsItems.map((n) => `- [${n.scope}] ${n.text}`).join("\n") || "(none)";

        const partiesText =
          getActivePartiesDirectory(this.state)
            .slice(0, 10)
            .map((p) => `- ${p.id}: ${p.name} (${p.memberIds.length} members) — ${p.manifesto}`)
            .join("\n") || "(none)";

        const feedPosts = buildAgentFeed(this.state, agent, this.config);
        const feedText =
          feedPosts
            .map(
              (p) =>
                `- [${p.id}] ${p.authorName} (${p.authorNation}, likes: ${p.likes.length}${p.replyToId ? `, reply to ${p.replyToId}` : ""}): ${p.text}`
            )
            .join("\n") || "(no posts)";

        const dms = getAgentDeliveredDms(this.state, agent.id);
        const dmsText =
          dms.map((d) => `- From ${d.fromName} (${d.fromId}): ${d.text}`).join("\n") || "(none)";

        const noticesText = agent.pendingNotices.join("\n") || "(none)";
        agent.pendingNotices = [];

        let electionBlock = "";
        if (isElectionDay) {
          const cards = buildCandidateCards(this.state, country.id);
          electionBlock = canVote
            ? `ELECTION DAY in ${country.name}! Candidates:\n${cards.map((c) => `- ${c.id}: ${c.name} (${c.nation}, party: ${c.partyName ?? "none"}, endorsed by: ${c.endorsedBy.join(", ") || "none"})`).join("\n")}\nYou may cast one {"type": "vote", "candidate_id": "..."} or null to abstain.`
            : `ELECTION DAY in ${country.name} (you are not eligible to vote here).`;
        }

        let presidentBlock = "";
        if (isPresident) {
          presidentBlock = `YOU ARE PRESIDENT of ${country.name}. Decisions remaining this term: ${country.decisionsLeft}. Regions: ${country.regions.join(", ")}.`;
        }

        const rulesText = [
          `World has 3 nations (lyrians, skalians, ventrians) and 9 regions (${Object.keys(this.state.regions).join(", ")}).`,
          `Elections every ${this.config.TERM_DAYS} days (next in ${(this.config.TERM_DAYS - (this.state.day % this.config.TERM_DAYS)) % this.config.TERM_DAYS} days).`,
          this.config.LIFESPAN_AWARENESS
            ? `People in Aldoria live about ${this.config.LIFESPAN_DAYS} days.`
            : "",
        ]
          .filter(Boolean)
          .join(" ");

        const prompt = this.prompts.render("morning", {
          name: agent.name,
          nation: agent.nation,
          region: reg.name,
          country: country.name,
          age: agent.age,
          mbti_blurb: agent.mbtiBlurb,
          backstory: agent.backstory ?? "",
          worldview: agent.worldview ?? "",
          rules_text: rulesText,
          diary: agent.diary.map((d) => `Day ${d.day}: ${d.text}`).join("\n") || "(empty)",
          roster,
          yesterday_chat: yesterdayChat,
          news: newsText,
          parties: partiesText,
          feed: feedText,
          dms: dmsText,
          notices: noticesText,
          election_block: electionBlock,
          president_block: presidentBlock,
          day: this.state.day,
          budget: this.config.SOCIAL_MSG_BUDGET,
          limit: this.config.SOCIAL_CHAR_LIMIT,
          like_budget: this.config.LIKE_BUDGET,
          move_status: canMove
            ? "You MAY move to any region today (applied at end of day)"
            : `On cooldown (last moved day ${agent.lastMoveDay}, cooldown ${this.config.MOVE_COOLDOWN_DAYS} days)`,
          allowed_actions: allowedList.join(", "),
        });

        const callId = `d${this.state.day}_morning_${agent.id}`;
        const res = await this.llm.generate({
          callId,
          day: this.state.day,
          phase: "morning",
          agentId: agent.id,
          purpose: "morning",
          prompt,
          schema,
        });

        await this.logLLM({
          callId,
          timestamp: new Date().toISOString(),
          day: this.state.day,
          phase: "morning",
          agentId: agent.id,
          purpose: "morning",
          promptHash: crypto.createHash("sha256").update(prompt).digest("hex"),
          ...(this.config.LOG_FULL_PROMPTS ? { prompt } : {}),
          rawResponse: res.rawText,
          parsedOk: res.success,
          retries: res.retries,
          safetyBlocked: res.safetyBlocked,
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
          latencyMs: res.latencyMs,
          error: res.error,
        });

        return { agent, res };
      })
    );

    // 2. Resolve actions in deterministic order (sorted by agent numericId)
    results.sort((a, b) => a.agent.numericId - b.agent.numericId);

    for (const { agent, res } of results) {
      if (!res.success || !res.data) {
        await this.emit({
          day: this.state.day,
          phase: "morning",
          actor: agent.id,
          type: "llm_noop",
          payload: { agentId: agent.id, reason: res.error ?? "LLM output invalid" },
        });
        continue;
      }

      const data = res.data;
      if (data.private_thought) {
        agent.privateThoughts.push({
          day: this.state.day,
          phase: "morning",
          text: data.private_thought,
        });
        await this.emit({
          day: this.state.day,
          phase: "morning",
          actor: agent.id,
          type: "private_thought",
          payload: { agentId: agent.id, text: data.private_thought },
        });
      }

      // Resolution order (§5): 1. President, 2. Social, 3. Parties, 4. Votes, 5. Moves & Independence
      const actions = data.actions;
      const presActions = actions.filter((a) => isPresidentAction(a));
      const socialActions = actions.filter(
        (a) => a.type === "post" || a.type === "reply" || a.type === "dm" || a.type === "like"
      );
      const partyActions = actions.filter(
        (a) =>
          a.type === "found_party" ||
          a.type === "join_party" ||
          a.type === "leave_party" ||
          a.type === "endorse"
      );
      const voteActions = actions.filter((a) => a.type === "vote");
      const moveActions = actions.filter((a) => a.type === "move");
      const indepActions = actions.filter((a) => a.type === "declare_independence");

      for (const act of presActions) {
        const reg = this.state.regions[agent.region]!;
        const pRes = executePresidentAction(this.state, agent, act, this.config);
        await this.emit({
          day: this.state.day,
          phase: "morning",
          actor: agent.id,
          type: "president_action",
          payload: {
            countryId: reg.countryId,
            presidentId: agent.id,
            actionType: act.type,
            details: act as unknown as Record<string, unknown>,
            succeeded: pRes.succeeded,
            reason: pRes.reason,
          },
        });
        if (pRes.succeeded && pRes.curriculumChanged) {
          await this.emit({
            day: this.state.day,
            phase: "morning",
            actor: agent.id,
            type: "curriculum_changed",
            payload: {
              countryId: reg.countryId,
              presidentId: agent.id,
              oldText: pRes.curriculumChanged.oldText,
              newText: pRes.curriculumChanged.newText,
            },
          });
          addNewsItem(
            this.state,
            "country",
            reg.countryId,
            `Curriculum changed by President ${agent.name}.`
          );
        } else if (pRes.succeeded && pRes.regionCeded) {
          await this.emit({
            day: this.state.day,
            phase: "morning",
            actor: agent.id,
            type: "region_ceded",
            payload: {
              regionId: pRes.regionCeded.regionId,
              fromCountry: pRes.regionCeded.fromCountry,
              toCountry: pRes.regionCeded.toCountry,
              presidentId: agent.id,
            },
          });
          addNewsItem(
            this.state,
            "world",
            null,
            `${this.state.regions[pRes.regionCeded.regionId]?.name} was ceded from ${this.state.countries[pRes.regionCeded.fromCountry].name} to ${this.state.countries[pRes.regionCeded.toCountry].name}.`
          );
        } else if (pRes.succeeded && pRes.decreeText) {
          addNewsItem(
            this.state,
            "country",
            reg.countryId,
            `Presidential Decree (${agent.name}): ${pRes.decreeText}`
          );
        }
      }

      for (const act of socialActions) {
        if (act.type === "post" || act.type === "reply") {
          const replyToId = act.type === "reply" ? act.post_id : null;
          const pRes = createPostOrReply(this.state, agent, act.text, replyToId, this.config);
          if (pRes.accepted && pRes.post) {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "post_created",
              payload: {
                postId: pRes.post.id,
                authorId: agent.id,
                text: pRes.post.text,
                replyToId: pRes.post.replyToId,
                censored: pRes.censored,
                truncated: pRes.truncated,
              },
            });
          } else {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "action_rejected",
              payload: { agentId: agent.id, actionType: act.type, reason: pRes.reason ?? "Rejected" },
            });
          }
        } else if (act.type === "dm") {
          const dRes = sendDirectMessage(this.state, agent, act.to, act.text, this.config);
          if (dRes.accepted && dRes.dm) {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "dm_sent",
              payload: {
                dmId: dRes.dm.id,
                fromId: agent.id,
                toId: dRes.dm.toId,
                text: dRes.dm.text,
                truncated: dRes.truncated,
              },
            });
          } else {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "action_rejected",
              payload: { agentId: agent.id, actionType: "dm", reason: dRes.reason ?? "Rejected" },
            });
          }
        } else if (act.type === "like") {
          const lRes = addLike(this.state, agent, act.target_id, this.config);
          if (lRes.accepted && lRes.targetKind) {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "like_added",
              payload: { agentId: agent.id, targetId: act.target_id, targetKind: lRes.targetKind },
            });
          } else {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "action_rejected",
              payload: { agentId: agent.id, actionType: "like", reason: lRes.reason ?? "Rejected" },
            });
          }
        }
      }

      for (const act of partyActions) {
        if (act.type === "found_party") {
          const pRes = foundParty(this.state, agent, act.name, act.manifesto, this.config);
          if (pRes.succeeded && pRes.party) {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "party_founded",
              payload: { partyId: pRes.party.id, name: pRes.party.name, leaderId: agent.id },
            });
            addNewsItem(this.state, "world", null, `${agent.name} founded a new party: ${pRes.party.name}.`);
          } else {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "action_rejected",
              payload: { agentId: agent.id, actionType: "found_party", reason: pRes.reason ?? "Rejected" },
            });
          }
        } else if (act.type === "join_party") {
          const pRes = joinParty(this.state, agent, act.party_id, this.config);
          if (pRes.succeeded && pRes.party) {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "party_joined",
              payload: { partyId: pRes.party.id, agentId: agent.id },
            });
          } else {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "action_rejected",
              payload: { agentId: agent.id, actionType: "join_party", reason: pRes.reason ?? "Rejected" },
            });
          }
        } else if (act.type === "leave_party") {
          const lRes = removeAgentFromParty(this.state, agent);
          if (lRes.leftPartyId) {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "party_left",
              payload: { partyId: lRes.leftPartyId, agentId: agent.id },
            });
          }
        } else if (act.type === "endorse") {
          const eRes = endorseCandidate(this.state, agent, act.candidate_id, this.config);
          if (eRes.succeeded && eRes.party) {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "party_endorsed",
              payload: { partyId: eRes.party.id, candidateId: act.candidate_id },
            });
          } else {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "action_rejected",
              payload: { agentId: agent.id, actionType: "endorse", reason: eRes.reason ?? "Rejected" },
            });
          }
        }
      }

      if (isElectionDay && voteActions.length > 0) {
        const voteAct = voteActions[0]!;
        if (voteAct.type === "vote") {
          const startRegion = this.state.regions[agent.region]!;
          const startCountry = this.state.countries[startRegion.countryId]!;
          if (isEligibleVoter(agent, startCountry.id, this.state, this.config)) {
            this.state.pendingVotes.push({
              voterId: agent.id,
              countryId: startCountry.id,
              regionId: startRegion.id,
              candidateId: voteAct.candidate_id,
            });
            agent.votesCast.push({
              day: this.state.day,
              countryId: startCountry.id,
              candidateId: voteAct.candidate_id,
            });
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "vote_cast",
              payload: {
                voterId: agent.id,
                countryId: startCountry.id,
                regionId: startRegion.id,
                candidateId: voteAct.candidate_id,
              },
            });
          } else {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "action_rejected",
              payload: { agentId: agent.id, actionType: "vote", reason: "Not eligible to vote" },
            });
          }
        }
      }

      if (moveActions.length > 0) {
        const moveAct = moveActions[0]!;
        if (moveAct.type === "move") {
          const targetId = moveAct.region.toLowerCase();
          const targetReg = this.state.regions[targetId];
          const canMove =
            agent.lastMoveDay === null ||
            this.state.day - agent.lastMoveDay >= this.config.MOVE_COOLDOWN_DAYS;

          if (!targetReg) {
            agent.pendingNotices.push(`Move to "${moveAct.region}" failed: unknown region.`);
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "move_rejected",
              payload: { agentId: agent.id, fromRegion: agent.region, toRegion: targetId, reason: "Unknown region" },
            });
          } else if (targetId === agent.region) {
            // No-op move to current region
          } else if (!canMove) {
            const reason = `Move cooldown active (last moved day ${agent.lastMoveDay})`;
            agent.pendingNotices.push(`Move to ${targetReg.name} rejected: ${reason}.`);
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "move_rejected",
              payload: { agentId: agent.id, fromRegion: agent.region, toRegion: targetId, reason },
            });
          } else {
            const destCountry = this.state.countries[targetReg.countryId]!;
            const borderRule = destCountry.laws.borders[targetId] ?? [];
            const blocked =
              borderRule === "all" ||
              (Array.isArray(borderRule) && borderRule.includes(agent.nation));
            if (blocked) {
              const reason = `Border of ${targetReg.name} is closed to ${agent.nation}`;
              agent.pendingNotices.push(`Move to ${targetReg.name} rejected: ${reason}.`);
              await this.emit({
                day: this.state.day,
                phase: "morning",
                actor: agent.id,
                type: "move_rejected",
                payload: { agentId: agent.id, fromRegion: agent.region, toRegion: targetId, reason },
              });
            } else {
              this.state.pendingMoves.push({
                agentId: agent.id,
                fromRegion: agent.region,
                toRegion: targetId,
              });
              await this.emit({
                day: this.state.day,
                phase: "morning",
                actor: agent.id,
                type: "move_requested",
                payload: { agentId: agent.id, fromRegion: agent.region, toRegion: targetId },
              });
            }
          }
        }
      }

      if (indepActions.length > 0) {
        const indAct = indepActions[0]!;
        if (indAct.type === "declare_independence") {
          const targetId = indAct.region.toLowerCase();
          const chk = canQueueIndependence(this.state, agent, targetId, this.config);
          if (chk.ok) {
            this.state.pendingIndependence.push({ agentId: agent.id, regionId: targetId });
          } else {
            await this.emit({
              day: this.state.day,
              phase: "morning",
              actor: agent.id,
              type: "action_rejected",
              payload: {
                agentId: agent.id,
                actionType: "declare_independence",
                reason: chk.reason ?? "Rejected",
              },
            });
          }
        }
      }
    }
  }

  private async runLocalChatPhase(): Promise<void> {
    const prng = new SeededPRNG(this.state.prngState);
    const regionIds = Object.keys(this.state.regions).sort();

    // Pre-compute deterministic speaker orders for all regions and rounds before async calls
    const regionPlans = regionIds.map((regionId) => {
      const occupants = Object.values(this.state.agents)
        .filter(
          (a) =>
            a.alive &&
            a.region === regionId &&
            (this.config.INFANTS_SPEAK_IN_LOCAL_CHAT || a.age >= this.config.EDUCATION_DAYS)
        )
        .sort((a, b) => a.numericId - b.numericId);

      const roundOrders: Agent[][] = [];
      for (let round = 1; round <= this.config.ROUNDS_PER_DAY; round++) {
        roundOrders.push(occupants.length > 1 ? prng.shuffle(occupants) : []);
      }
      return { regionId, occupants, roundOrders };
    });
    this.state.prngState = prng.getState();

    await Promise.all(
      regionPlans.map(async ({ regionId, occupants, roundOrders }) => {
        const reg = this.state.regions[regionId]!;
        const country = this.state.countries[reg.countryId]!;

        // Skip local chat LLM calls when a region has <= 1 occupant (Decision #11)
        if (occupants.length <= 1) return;

        const roster = Object.values(this.state.agents)
          .filter((a) => a.alive && a.region === regionId)
          .map((a) => `- ${a.name} (${a.nation}, age ${a.age}${a.age < this.config.EDUCATION_DAYS ? ", infant" : ""})`)
          .join("\n");

        for (let round = 1; round <= this.config.ROUNDS_PER_DAY; round++) {
          const order = roundOrders[round - 1]!;
          for (const agent of order) {
            const transcript = this.state.localChat
              .filter((c) => c.day === this.state.day && c.regionId === regionId)
              .map((c) => `${c.agentName}: ${c.text}`)
              .join("\n") || "(silence so far)";

            const identityExtra =
              agent.age < this.config.EDUCATION_DAYS
                ? "You are still young and learning about the world."
                : `Backstory: ${agent.backstory ?? ""}\nWorldview: ${agent.worldview ?? ""}`;

            const prompt = this.prompts.render("local_chat", {
              name: agent.name,
              nation: agent.nation,
              region: reg.name,
              country: country.name,
              age: agent.age,
              mbti_blurb: agent.mbtiBlurb,
              identity_extra: identityExtra,
              roster,
              round,
              transcript,
              limit: this.config.LOCAL_CHAT_CHAR_LIMIT,
            });

            const callId = `d${this.state.day}_chat_${regionId}_r${round}_${agent.id}`;
            const res = await this.llm.generate({
              callId,
              day: this.state.day,
              phase: "local_chat",
              agentId: agent.id,
              purpose: "local_chat",
              prompt,
              schema: LocalChatOutputSchema,
            });

            await this.logLLM({
              callId,
              timestamp: new Date().toISOString(),
              day: this.state.day,
              phase: "local_chat",
              agentId: agent.id,
              purpose: "local_chat",
              promptHash: crypto.createHash("sha256").update(prompt).digest("hex"),
              ...(this.config.LOG_FULL_PROMPTS ? { prompt } : {}),
              rawResponse: res.rawText,
              parsedOk: res.success,
              retries: res.retries,
              safetyBlocked: res.safetyBlocked,
              promptTokens: res.promptTokens,
              completionTokens: res.completionTokens,
              latencyMs: res.latencyMs,
              error: res.error,
            });

            if (res.success && res.data) {
              if (res.data.private_thought) {
                agent.privateThoughts.push({
                  day: this.state.day,
                  phase: "local_chat",
                  text: res.data.private_thought,
                });
              }
              if (res.data.say && res.data.say.trim().length > 0) {
                const text = res.data.say.trim().slice(0, this.config.LOCAL_CHAT_CHAR_LIMIT);
                this.state.localChat.push({
                  day: this.state.day,
                  round,
                  regionId,
                  agentId: agent.id,
                  agentName: agent.name,
                  nation: agent.nation,
                  text,
                });
                // Record into infants' infancyTranscript in this region
                for (const occ of occupants) {
                  if (occ.id !== agent.id && occ.age < this.config.EDUCATION_DAYS) {
                    occ.infancyTranscript.push(`${agent.name}: ${text}`);
                  }
                }
                await this.emit({
                  day: this.state.day,
                  phase: "local_chat",
                  actor: agent.id,
                  type: "local_chat",
                  payload: {
                    regionId,
                    round,
                    agentId: agent.id,
                    agentName: agent.name,
                    nation: agent.nation,
                    text,
                  },
                });
              }
            }
          }
        }
      })
    );
  }

  private async runEveningPhase(): Promise<void> {
    const living = Object.values(this.state.agents).filter((a) => a.alive);

    await Promise.all(
      living.map(async (agent) => {
        const reg = this.state.regions[agent.region]!;
        const country = this.state.countries[reg.countryId]!;
        const isDying = agent.age === this.config.LIFESPAN_DAYS - 1;
        const isAdult = agent.age >= this.config.EDUCATION_DAYS;

        const todayChat = this.state.localChat
          .filter((c) => c.day === this.state.day && c.regionId === agent.region)
          .map((c) => `${c.agentName}: ${c.text}`)
          .join("\n") || "(quiet day)";

        const daySummary = `Local conversations in ${reg.name}:\n${todayChat}`;
        const identityExtra = isAdult
          ? `Backstory: ${agent.backstory ?? ""}\nWorldview: ${agent.worldview ?? ""}`
          : `You are still young (age ${agent.age}). Curriculum: ${country.curriculumText}`;

        const prompt = this.prompts.render("evening", {
          name: agent.name,
          nation: agent.nation,
          region: reg.name,
          country: country.name,
          age: agent.age,
          mbti_blurb: agent.mbtiBlurb,
          identity_extra: identityExtra,
          day: this.state.day,
          day_summary: daySummary,
          diary_words: this.config.DIARY_WORDS,
          work_prompt: isAdult
            ? "Optionally publish one cultural work (poem, song, meme, slogan, or anthem, max 500 chars)."
            : "Set work to null.",
          will_prompt: isDying
            ? `This is your final day (age ${agent.age}). Write your will (at most ${this.config.WILL_WORDS} words) for the newborn who will take your place.`
            : "Set will to null.",
        });

        const callId = `d${this.state.day}_evening_${agent.id}`;
        const res = await this.llm.generate({
          callId,
          day: this.state.day,
          phase: "evening",
          agentId: agent.id,
          purpose: "evening",
          prompt,
          schema: EveningOutputSchema,
        });

        await this.logLLM({
          callId,
          timestamp: new Date().toISOString(),
          day: this.state.day,
          phase: "evening",
          agentId: agent.id,
          purpose: "evening",
          promptHash: crypto.createHash("sha256").update(prompt).digest("hex"),
          ...(this.config.LOG_FULL_PROMPTS ? { prompt } : {}),
          rawResponse: res.rawText,
          parsedOk: res.success,
          retries: res.retries,
          safetyBlocked: res.safetyBlocked,
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
          latencyMs: res.latencyMs,
          error: res.error,
        });

        if (res.success && res.data) {
          if (res.data.private_thought) {
            agent.privateThoughts.push({
              day: this.state.day,
              phase: "evening",
              text: res.data.private_thought,
            });
          }
          const diaryText = res.data.diary
            .trim()
            .split(/\s+/)
            .slice(0, this.config.DIARY_WORDS)
            .join(" ");
          agent.diary.push({ day: this.state.day, text: diaryText });
          await this.emit({
            day: this.state.day,
            phase: "evening",
            actor: agent.id,
            type: "diary_written",
            payload: { agentId: agent.id, text: diaryText },
          });

          if (isAdult && res.data.work) {
            const wRes = publishWork(
              this.state,
              agent,
              res.data.work.kind,
              res.data.work.text,
              this.config
            );
            if (wRes.succeeded && wRes.work) {
              await this.emit({
                day: this.state.day,
                phase: "evening",
                actor: agent.id,
                type: "work_published",
                payload: {
                  workId: wRes.work.id,
                  authorId: agent.id,
                  kind: wRes.work.kind,
                  text: wRes.work.text,
                },
              });
            }
          }

          if (isDying && res.data.will) {
            const willText = res.data.will
              .trim()
              .split(/\s+/)
              .slice(0, this.config.WILL_WORDS)
              .join(" ");
            agent.will = willText;
            await this.emit({
              day: this.state.day,
              phase: "evening",
              actor: agent.id,
              type: "will_written",
              payload: { agentId: agent.id, text: willText },
            });
          }
        }
      })
    );
  }

  private async runEndOfDayPhase(): Promise<void> {
    // 1. Apply moves
    for (const mv of this.state.pendingMoves) {
      const agent = this.state.agents[mv.agentId];
      if (!agent || !agent.alive) continue;
      agent.region = mv.toRegion;
      agent.lastMoveDay = this.state.day;
      agent.regionHistory.push({ day: this.state.day, region: mv.toRegion });
      await this.emit({
        day: this.state.day,
        phase: "end_of_day",
        actor: agent.id,
        type: "move_applied",
        payload: { agentId: agent.id, fromRegion: mv.fromRegion, toRegion: mv.toRegion },
      });
      addNewsItem(
        this.state,
        "region",
        mv.fromRegion,
        `${agent.name} departed ${this.state.regions[mv.fromRegion]?.name}.`
      );
      addNewsItem(
        this.state,
        "region",
        mv.toRegion,
        `${agent.name} arrived in ${this.state.regions[mv.toRegion]?.name}.`
      );
    }
    this.state.pendingMoves = [];

    // 2. Election day resolution
    if (this.state.day % this.config.TERM_DAYS === 0) {
      for (const cid of ["lyria", "skalia", "ventriana"] as CountryId[]) {
        const country = this.state.countries[cid];
        if (!country.exists) continue;
        const rec = resolveCountryElection(this.state, cid, this.config);
        const regionWinners: Record<RegionId, string | null> = {};
        for (const [rid, rr] of Object.entries(rec.regionResults)) {
          regionWinners[rid] = rr.winnerId;
        }
        await this.emit({
          day: this.state.day,
          phase: "end_of_day",
          actor: rec.winnerId,
          type: "election_completed",
          payload: {
            countryId: cid,
            winnerId: rec.winnerId,
            actingPresident: rec.actingPresident,
            regionWinners,
          },
        });
        const winName = rec.winnerId ? this.state.agents[rec.winnerId]?.name : "no one";
        addNewsItem(
          this.state,
          "country",
          cid,
          `Election in ${country.name}: ${winName} elected${rec.actingPresident ? " (acting)" : ""}.`
        );
      }
    }
    this.state.pendingVotes = [];

    // 3. Resolve independence declarations
    const indepResults = resolveIndependenceDeclarations(this.state, this.config);
    for (const ir of indepResults) {
      await this.emit({
        day: this.state.day,
        phase: "end_of_day",
        actor: ir.agentId,
        type: "independence_declared",
        payload: {
          regionId: ir.regionId,
          agentId: ir.agentId,
          succeeded: ir.succeeded,
          reason: ir.reason,
          fromCountry: ir.fromCountry,
        },
      });
      if (ir.succeeded) {
        addNewsItem(
          this.state,
          "world",
          null,
          `${this.state.regions[ir.regionId]?.name} declared independence and joined Ventriana!`
        );
      }
    }

    // 4. Generate end-of-day news
    generateEndOfDayNews(this.state);

    // 5. Freeze candidates for next day if D+1 is election day
    if ((this.state.day + 1) % this.config.TERM_DAYS === 0) {
      for (const cid of ["lyria", "skalia", "ventriana"] as CountryId[]) {
        if (this.state.countries[cid].exists) {
          freezeCandidatesForCountry(this.state, cid, this.config, 1);
        }
      }
    }

    // 6. Compute & persist daily stats
    const stats = this.computeDailyStats();
    await this.storage.appendDailyStats(stats);
  }

  public computeDailyStats(): DailyMetricsRow {
    const living = Object.values(this.state.agents).filter((a) => a.alive);
    const regionNationCounts: Record<RegionId, Record<Nation, number>> = {};
    for (const rid of Object.keys(this.state.regions)) {
      regionNationCounts[rid] = { lyrians: 0, skalians: 0, ventrians: 0 };
    }
    for (const a of living) {
      if (regionNationCounts[a.region]) {
        regionNationCounts[a.region]![a.nation] += 1;
      }
    }

    let ventrianRegionsCount = 0;
    let largestVentrianCluster = 0;
    for (const counts of Object.values(regionNationCounts)) {
      if (counts.ventrians > 0) {
        ventrianRegionsCount += 1;
        if (counts.ventrians > largestVentrianCluster) {
          largestVentrianCluster = counts.ventrians;
        }
      }
    }

    const presName = (cid: CountryId) => {
      const pid = this.state.countries[cid].presidentId;
      return pid ? this.state.agents[pid]?.name ?? "" : "";
    };
    const presNation = (cid: CountryId) => {
      const pid = this.state.countries[cid].presidentId;
      return pid ? this.state.agents[pid]?.nation ?? "" : "";
    };

    return {
      day: this.state.day,
      totalAlive: living.length,
      ventrianRegionsCount,
      largestVentrianCluster,
      lyriaRegionsCount: this.state.countries.lyria.regions.length,
      skaliaRegionsCount: this.state.countries.skalia.regions.length,
      ventrianaRegionsCount: this.state.countries.ventriana.exists
        ? this.state.countries.ventriana.regions.length
        : 0,
      lyriaPresident: presName("lyria"),
      lyriaPresidentNation: presNation("lyria"),
      skaliaPresident: presName("skalia"),
      skaliaPresidentNation: presNation("skalia"),
      ventrianaPresident: presName("ventriana"),
      ventrianaPresidentNation: presNation("ventriana"),
      activeParties: Object.values(this.state.parties).filter((p) => !p.dissolved).length,
      postsCount: this.state.posts.filter((p) => p.day === this.state.day).length,
      dmsCount: this.state.dms.filter((d) => d.day === this.state.day).length,
      localChatCount: this.state.localChat.filter((c) => c.day === this.state.day).length,
      worksCount: this.state.works.filter((w) => w.day === this.state.day).length,
      deathsCount: this.dayDeaths,
      birthsCount: this.dayBirths,
      regionNationCounts,
    };
  }
}
