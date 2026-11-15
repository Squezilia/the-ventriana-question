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
  RunMetadata,
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
import { getHallOfFame, publishWork } from "../social/culture.ts";
import {
  endorseCandidate,
  foundParty,
  getActivePartiesDirectory,
  joinParty,
  removeAgentFromParty,
} from "../social/parties.ts";
import {
  addLike,
  createPostOrReply,
  getAgentDeliveredDms,
  getAgentPriorityFeedPosts,
  getSharedMorningFeedWindow,
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
  onStatusChange?: (
    status: RunMetadata["status"],
    info: { day: number; phase: PhaseName; isPaused: boolean; isStopping: boolean }
  ) => void;
  phaseDelayMs?: number;
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
  private readonly onStatusChange?: SimulationRunnerOptions["onStatusChange"];
  private readonly phaseDelayMs: number;

  private eventSeq = 1;
  private dayDeaths = 0;
  private dayBirths = 0;
  private paused = false;
  private stopRequested = false;
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
    this.onStatusChange = opts.onStatusChange;
    this.phaseDelayMs = opts.phaseDelayMs ?? 0;
  }

  pause(): void {
    this.paused = true;
    if (this.pauseResolvers.length > 0 || !this.isRunningLoop) {
      void this.storage.updateRunMetadata({ status: "paused" });
      this.onStatusChange?.("paused", {
        day: this.state.day,
        phase: this.state.phase,
        isPaused: true,
        isStopping: this.stopRequested,
      });
    }
  }

  resume(): void {
    this.paused = false;
    this.stepBudget = 0;
    void this.storage.updateRunMetadata({ status: "running" });
    this.onStatusChange?.("running", {
      day: this.state.day,
      phase: this.state.phase,
      isPaused: false,
      isStopping: this.stopRequested,
    });
    const resolvers = this.pauseResolvers.splice(0);
    for (const r of resolvers) r();
  }

  requestStop(): void {
    this.stopRequested = true;
    this.onStatusChange?.(this.paused ? "paused" : "running", {
      day: this.state.day,
      phase: this.state.phase,
      isPaused: this.paused,
      isStopping: true,
    });
    const resolvers = this.pauseResolvers.splice(0);
    for (const r of resolvers) r();
  }

  isPaused(): boolean {
    return this.paused;
  }

  isStopping(): boolean {
    return this.stopRequested;
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

  private async waitIfPaused(): Promise<boolean> {
    if (this.stopRequested) return false;
    if (!this.paused) return true;
    if (this.stepBudget > 0) {
      this.stepBudget -= 1;
      return true;
    }
    let resolved = false;
    const pausePromise = new Promise<void>((resolve) => {
      this.pauseResolvers.push(() => {
        resolved = true;
        resolve();
      });
    });
    await this.storage.updateRunMetadata({ status: "paused" });
    this.onStatusChange?.("paused", {
      day: this.state.day,
      phase: this.state.phase,
      isPaused: true,
      isStopping: this.stopRequested,
    });
    if (!resolved && this.paused && !this.stopRequested) {
      await pausePromise;
    }
    if (this.stopRequested) return false;
    if (this.paused && this.stepBudget > 0) {
      this.stepBudget -= 1;
    }
    return true;
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
    stopped?: boolean;
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
        const firstIdx = day === startDay ? startPhaseIdx : 0;

        for (let pIdx = firstIdx; pIdx < PHASE_ORDER.length; pIdx++) {
          const shouldContinue = await this.waitIfPaused();
          if (!shouldContinue || this.stopRequested) {
            await this.storage.updateRunMetadata({ status: "paused" });
            this.onStatusChange?.("paused", {
              day: this.state.day,
              phase: this.state.phase,
              isPaused: true,
              isStopping: false,
            });
            return { completed: false, budgetStopped: false, stopped: true };
          }

          this.state.day = day;
          const phase = PHASE_ORDER[pIdx]!;
          await this.runSinglePhase(phase);
          const stepResolvers = this.stepDoneResolvers.splice(0);
          for (const r of stepResolvers) r();

          if (this.stopRequested) {
            await this.storage.updateRunMetadata({
              status: "paused",
              lastCompletedDay: day,
              lastCompletedPhase: phase,
            });
            this.onStatusChange?.("paused", {
              day,
              phase,
              isPaused: true,
              isStopping: false,
            });
            return { completed: false, budgetStopped: false, stopped: true };
          }

          if (this.rateLimiter) {
            const budget = this.rateLimiter.isBudgetExhausted();
            if (budget.exhausted) {
              await this.storage.updateRunMetadata({
                status: "budget_stopped",
                lastCompletedDay: day,
                lastCompletedPhase: phase,
              });
              this.onStatusChange?.("budget_stopped", {
                day,
                phase,
                isPaused: false,
                isStopping: false,
              });
              return { completed: false, budgetStopped: true, reason: budget.reason };
            }
          }

          if (this.phaseDelayMs > 0 && !this.stopRequested && !this.paused) {
            await new Promise((resolve) => setTimeout(resolve, this.phaseDelayMs));
          }
        }
      }

      await this.storage.updateRunMetadata({
        status: "completed",
        endedAt: new Date().toISOString(),
        lastCompletedDay: targetEndDayExclusive - 1,
        lastCompletedPhase: "end_of_day",
      });
      this.onStatusChange?.("completed", {
        day: this.state.day,
        phase: this.state.phase,
        isPaused: false,
        isStopping: false,
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
    const adults = Object.values(this.state.agents)
      .filter((a) => a.alive && a.age >= this.config.EDUCATION_DAYS)
      .sort((a, b) => a.numericId - b.numericId);
    const isElectionDay = this.state.day % this.config.TERM_DAYS === 0;
    const isTr = this.config.SIM_LANGUAGE === "tr";

    // Build shared phase-level system context ONCE so Gemini implicit context caching hits across all adults
    const daysUntilElection =
      (this.config.TERM_DAYS - (this.state.day % this.config.TERM_DAYS)) % this.config.TERM_DAYS;
    const rulesText = isTr
      ? [
          `Aldoria dünyasında 3 millet (lyrians, skalians, ventrians) ve 9 bölge vardır (${Object.keys(this.state.regions).join(", ")}).`,
          `Seçimler her ${this.config.TERM_DAYS} günde bir yapılır (sonraki ${daysUntilElection} gün içinde).`,
          this.config.LIFESPAN_AWARENESS
            ? `Aldoria halkı yaklaşık ${this.config.LIFESPAN_DAYS} gün yaşar.`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : [
          `World has 3 nations (lyrians, skalians, ventrians) and 9 regions (${Object.keys(this.state.regions).join(", ")}).`,
          `Elections every ${this.config.TERM_DAYS} days (next in ${daysUntilElection} days).`,
          this.config.LIFESPAN_AWARENESS
            ? `People in Aldoria live about ${this.config.LIFESPAN_DAYS} days.`
            : "",
        ]
          .filter(Boolean)
          .join(" ");

    const partiesText =
      getActivePartiesDirectory(this.state)
        .slice(0, 10)
        .map((p) => `- ${p.id}: ${p.name} (${p.memberIds.length} members) — ${p.manifesto}`)
        .join("\n") || (isTr ? "(yok)" : "(none)");

    const worldNewsItems = this.state.news.filter(
      (n) =>
        n.scope === "world" &&
        (n.day === (this.state.day === 0 ? 0 : this.state.day - 1) || n.day === this.state.day)
    );
    const worldNewsText =
      worldNewsItems.map((n) => `- [world] ${n.text}`).join("\n") || (isTr ? "(yok)" : "(none)");

    // Precompute phase-level indexes ONCE instead of scanning per agent (critical for large multi-day runs)
    const deliveredTodayPosts = this.state.posts.filter(
      (p) => !p.censored && p.deliveredDay === this.state.day
    );
    const postIdsByAuthor = new Map<string, Set<string>>();
    for (const p of this.state.posts) {
      let set = postIdsByAuthor.get(p.authorId);
      if (!set) {
        set = new Set();
        postIdsByAuthor.set(p.authorId, set);
      }
      set.add(p.id);
    }

    const rosterByRegion = new Map<RegionId, string>();
    const livingByRegion = new Map<RegionId, Agent[]>();
    for (const a of Object.values(this.state.agents)) {
      if (!a.alive) continue;
      let list = livingByRegion.get(a.region);
      if (!list) {
        list = [];
        livingByRegion.set(a.region, list);
      }
      list.push(a);
    }
    for (const [rid, list] of livingByRegion) {
      list.sort((a, b) => a.numericId - b.numericId);
      const regCountry = this.state.countries[this.state.regions[rid]!.countryId]!;
      rosterByRegion.set(
        rid,
        list
          .map((a) => {
            const pName = a.partyId && this.state.parties[a.partyId] ? this.state.parties[a.partyId]!.name : "none";
            const presFlag = regCountry.presidentId === a.id ? ", PRESIDENT" : "";
            const stage = a.age < this.config.EDUCATION_DAYS ? "infant" : "adult";
            return `- ${a.name} (${a.id}, ${a.nation}, age ${a.age}, ${stage}, party: ${pName}${presFlag})`;
          })
          .join("\n")
      );
    }

    const yesterdayChatByRegion = new Map<RegionId, string>();
    const yDay = this.state.day - 1;
    const rawChatByRegion = new Map<RegionId, typeof this.state.localChat>();
    for (const c of this.state.localChat) {
      if (c.day !== yDay) continue;
      let arr = rawChatByRegion.get(c.regionId);
      if (!arr) {
        arr = [];
        rawChatByRegion.set(c.regionId, arr);
      }
      arr.push(c);
    }
    for (const [rid, arr] of rawChatByRegion) {
      yesterdayChatByRegion.set(
        rid,
        arr
          .slice(-20)
          .map((c) => `[R${c.round}] ${c.agentName}: ${c.text}`)
          .join("\n")
      );
    }

    const sharedFeedPosts = getSharedMorningFeedWindow(this.state, this.config, deliveredTodayPosts);
    const sharedFeedIds = new Set(sharedFeedPosts.map((p) => p.id));
    const sharedFeedText =
      sharedFeedPosts
        .map(
          (p) =>
            `- [${p.id}] ${p.authorName} (${p.authorNation}, likes: ${p.likes.length}${p.replyToId ? `, reply to ${p.replyToId}` : ""}): ${p.text}`
        )
        .join("\n") || (isTr ? "(henüz gönderi yok)" : "(no posts)");

    const yesterdayWorks = this.state.works.filter((w) => w.day === this.state.day - 1);
    const hallOfFame = getHallOfFame(this.state, 5).filter(
      (w) => w.day < this.state.day && w.likes.length > 0 && !yesterdayWorks.some((y) => y.id === w.id)
    );
    const worksSectionLines = [
      ...yesterdayWorks.map(
        (w) => `- [${w.id}] ${w.authorName} (${w.authorNation}, ${w.kind}, likes: ${w.likes.length}): ${w.text}`
      ),
      ...hallOfFame.map(
        (w) => `- [${w.id}] [Top Day ${w.day}] ${w.authorName} (${w.kind}, likes: ${w.likes.length}): ${w.text}`
      ),
    ];
    const worksText = worksSectionLines.join("\n") || (isTr ? "(yok)" : "(none)");

    const morningSystemPrompt = isTr
      ? [
          "Sen Aldoria dünyasının bir vatandaşısın. Asla rolden çıkma. Yalnızca istenen şemaya uygun geçerli JSON döndür.",
          `\nDünya Kuralları:\n${rulesText}`,
          `\nAktif Partiler:\n${partiesText}`,
          `\nDünya Haberleri (Gün ${this.state.day}):\n${worldNewsText}`,
          `\nOrtak Sosyal Akış (dünden teslim edilen son gönderiler — [pID] ile beğenebilir veya yanıtlayabilirsin):\n${sharedFeedText}`,
          `\nDünün Kültürel Eserleri ve Seçkin Eserler ([wID] ile beğenebilir, başkanlar adopt_anthem ile marş seçebilir):\n${worksText}`,
        ].join("\n")
      : [
          "You are a citizen of the world of Aldoria. Never break character. Reply ONLY with valid JSON matching the required schema.",
          `\nWorld Rules:\n${rulesText}`,
          `\nActive Party Directory:\n${partiesText}`,
          `\nWorld Headlines (Day ${this.state.day}):\n${worldNewsText}`,
          `\nShared Public Social Feed (last delivered posts — use [pID] to reply or like):\n${sharedFeedText}`,
          `\nYesterday's & Notable Cultural Works (use [wID] to like or adopt_anthem):\n${worksText}`,
        ].join("\n");

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

        const roster = rosterByRegion.get(agent.region) ?? "";

        const yesterdayChat =
          yesterdayChatByRegion.get(agent.region) || (isTr ? "(yok)" : "(none)");

        const localNewsItems = getNewsForAgent(this.state, reg.id, country.id, this.state.day).filter(
          (n) => n.scope !== "world"
        );
        const newsText =
          localNewsItems.map((n) => `- [${n.scope}] ${n.text}`).join("\n") || (isTr ? "(yok)" : "(none)");

        const priorityPosts = getAgentPriorityFeedPosts(this.state, agent, 10, {
          deliveredToday: deliveredTodayPosts,
          myPostIds: postIdsByAuthor.get(agent.id) ?? new Set(),
        });
        const feedText =
          priorityPosts.length > 0
            ? priorityPosts
                .map(
                  (p) =>
                    `- [${p.id}] ${p.authorName} (${p.authorNation}, likes: ${p.likes.length}${p.replyToId ? `, reply to ${p.replyToId}` : ""}${sharedFeedIds.has(p.id) ? "" : ", earlier in window"}): ${p.text}`
                )
                .join("\n")
            : isTr
              ? "(sana doğrudan yanıt veya bahsetme yok; genel akış üstteki sistem bülteninde)"
              : "(no direct replies or mentions; general feed is in the shared bulletin above)";

        const dms = getAgentDeliveredDms(this.state, agent.id);
        const dmsText =
          dms.map((d) => `- From ${d.fromName} (${d.fromId}): ${d.text}`).join("\n") ||
          (isTr ? "(yok)" : "(none)");

        const noticesText = agent.pendingNotices.join("\n") || (isTr ? "(yok)" : "(none)");
        agent.pendingNotices = [];

        let electionBlock = "";
        if (isElectionDay) {
          const cards = buildCandidateCards(this.state, country.id);
          if (isTr) {
            electionBlock = canVote
              ? `${country.name} ülkesinde SEÇİM GÜNÜ! Adaylar:\n${cards.map((c) => `- ${c.id}: ${c.name} (${c.nation}, parti: ${c.partyName ?? "bağımsız"}, destekleyenler: ${c.endorsedBy.join(", ") || "yok"})`).join("\n")}\nBir {"type": "vote", "candidate_id": "..."} oyu kullanabilir veya çekimser kalmak için null verebilirsin.`
              : `${country.name} ülkesinde SEÇİM GÜNÜ (burada oy kullanma hakkın yok).`;
          } else {
            electionBlock = canVote
              ? `ELECTION DAY in ${country.name}! Candidates:\n${cards.map((c) => `- ${c.id}: ${c.name} (${c.nation}, party: ${c.partyName ?? "none"}, endorsed by: ${c.endorsedBy.join(", ") || "none"})`).join("\n")}\nYou may cast one {"type": "vote", "candidate_id": "..."} or null to abstain.`
              : `ELECTION DAY in ${country.name} (you are not eligible to vote here).`;
          }
        }

        let presidentBlock = "";
        if (isPresident) {
          presidentBlock = isTr
            ? `${country.name} BAŞKANI SENSİN. Bu dönem kalan karar hakkın: ${country.decisionsLeft}. Bölgeler: ${country.regions.join(", ")}.`
            : `YOU ARE PRESIDENT of ${country.name}. Decisions remaining this term: ${country.decisionsLeft}. Regions: ${country.regions.join(", ")}.`;
        }

        const moveStatusText = canMove
          ? isTr
            ? "Bugün herhangi bir bölgeye taşınabilirsin (gün sonunda uygulanır)"
            : "You MAY move to any region today (applied at end of day)"
          : isTr
            ? `Bekleme süresindesin (son taşınma: Gün ${agent.lastMoveDay}, bekleme: ${this.config.MOVE_COOLDOWN_DAYS} gün)`
            : `On cooldown (last moved day ${agent.lastMoveDay}, cooldown ${this.config.MOVE_COOLDOWN_DAYS} days)`;

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
          diary:
            agent.diary.map((d) => `${isTr ? "Gün" : "Day"} ${d.day}: ${d.text}`).join("\n") ||
            (isTr ? "(boş)" : "(empty)"),
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
          move_status: moveStatusText,
          allowed_actions: allowedList.join(", "),
        });

        const fullPromptForLog = `[SYSTEM]\n${morningSystemPrompt}\n\n[USER]\n${prompt}`;
        const callId = `d${this.state.day}_morning_${agent.id}`;
        const res = await this.llm.generate({
          callId,
          day: this.state.day,
          phase: "morning",
          agentId: agent.id,
          purpose: "morning",
          systemPrompt: morningSystemPrompt,
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
          promptHash: crypto.createHash("sha256").update(fullPromptForLog).digest("hex"),
          ...(this.config.LOG_FULL_PROMPTS ? { prompt: fullPromptForLog } : {}),
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

        return { agent, res };
      })
    );

    // 2. Resolve actions in deterministic SPEC §5 order across all agents sorted by numericId:
    // 1. President -> 2. Social -> 3. Parties -> 4. Votes -> 5. Moves & Independence
    results.sort((a, b) => a.agent.numericId - b.agent.numericId);

    const parsedAgents: Array<{
      agent: Agent;
      actions: NonNullable<typeof results[number]["res"]["data"]>["actions"];
    }> = [];

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

      if (res.data.private_thought) {
        agent.privateThoughts.push({
          day: this.state.day,
          phase: "morning",
          text: res.data.private_thought,
        });
        await this.emit({
          day: this.state.day,
          phase: "morning",
          actor: agent.id,
          type: "private_thought",
          payload: { agentId: agent.id, text: res.data.private_thought },
        });
      }
      parsedAgents.push({ agent, actions: res.data.actions });
    }

    // Bucket 1: Presidential actions across all agents
    for (const { agent, actions } of parsedAgents) {
      for (const act of actions.filter((a) => isPresidentAction(a))) {
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
    }

    // Bucket 2: Social actions across all agents
    for (const { agent, actions } of parsedAgents) {
      const socialActions = actions.filter(
        (a) => a.type === "post" || a.type === "reply" || a.type === "dm" || a.type === "like"
      );
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
    }

    // Bucket 3: Party actions across all agents
    for (const { agent, actions } of parsedAgents) {
      const partyActions = actions.filter(
        (a) =>
          a.type === "found_party" ||
          a.type === "join_party" ||
          a.type === "leave_party" ||
          a.type === "endorse"
      );
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
    }

    // Bucket 4: Votes across all agents (note: a region ceded in Bucket 1 reflects current countryId)
    if (isElectionDay) {
      for (const { agent, actions } of parsedAgents) {
        const voteActions = actions.filter((a) => a.type === "vote");
        if (voteActions.length === 0) continue;
        const voteAct = voteActions[0]!;
        if (voteAct.type !== "vote") continue;
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

    // Bucket 5: Moves & Independence declarations across all agents
    for (const { agent, actions } of parsedAgents) {
      const moveActions = actions.filter((a) => a.type === "move");
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

      const indepActions = actions.filter((a) => a.type === "declare_independence");
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

    const isTr = this.config.SIM_LANGUAGE === "tr";
    const localChatSystemPrompt = isTr
      ? "Aldoria dünyasında bir bölge meydanı sohbetindesin. Asla rolden çıkma ve yalnızca istenen şemaya uygun JSON döndür."
      : "You are in a local town square conversation in Aldoria. Never break character and reply ONLY with valid JSON matching the schema.";

    const perRegionEntries = await Promise.all(
      regionPlans.map(async ({ regionId, occupants, roundOrders }) => {
        const reg = this.state.regions[regionId]!;
        const country = this.state.countries[reg.countryId]!;
        const regionEntries: WorldState["localChat"] = [];

        // Skip local chat LLM calls when a region has <= 1 occupant (Decision #11)
        if (occupants.length <= 1) return regionEntries;

        const roster = Object.values(this.state.agents)
          .filter((a) => a.alive && a.region === regionId)
          .sort((a, b) => a.numericId - b.numericId)
          .map((a) => `- ${a.name} (${a.nation}, age ${a.age}${a.age < this.config.EDUCATION_DAYS ? ", infant" : ""})`)
          .join("\n");

        for (let round = 1; round <= this.config.ROUNDS_PER_DAY; round++) {
          const order = roundOrders[round - 1]!;
          for (const agent of order) {
            const transcript =
              regionEntries.map((c) => `${c.agentName}: ${c.text}`).join("\n") ||
              (isTr ? "(şimdilik sessizlik)" : "(silence so far)");

            const identityExtra =
              agent.age < this.config.EDUCATION_DAYS
                ? isTr
                  ? "Henüz çok gençsin ve dünyayı öğreniyorsun."
                  : "You are still young and learning about the world."
                : isTr
                  ? `Geçmişin: ${agent.backstory ?? ""}\nDünya görüşün: ${agent.worldview ?? ""}`
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

            const fullPromptForLog = `[SYSTEM]\n${localChatSystemPrompt}\n\n[USER]\n${prompt}`;
            const callId = `d${this.state.day}_chat_${regionId}_r${round}_${agent.id}`;
            const res = await this.llm.generate({
              callId,
              day: this.state.day,
              phase: "local_chat",
              agentId: agent.id,
              purpose: "local_chat",
              systemPrompt: localChatSystemPrompt,
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
              promptHash: crypto.createHash("sha256").update(fullPromptForLog).digest("hex"),
              ...(this.config.LOG_FULL_PROMPTS ? { prompt: fullPromptForLog } : {}),
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
              if (res.data.private_thought) {
                agent.privateThoughts.push({
                  day: this.state.day,
                  phase: "local_chat",
                  text: res.data.private_thought,
                });
              }
              if (res.data.say && res.data.say.trim().length > 0) {
                const text = res.data.say.trim().slice(0, this.config.LOCAL_CHAT_CHAR_LIMIT);
                const entry: WorldState["localChat"][number] = {
                  day: this.state.day,
                  round,
                  regionId,
                  agentId: agent.id,
                  agentName: agent.name,
                  nation: agent.nation,
                  text,
                };
                regionEntries.push(entry);
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
        return regionEntries;
      })
    );

    // Append region chats in deterministic sorted regionId order
    for (const regionEntries of perRegionEntries) {
      this.state.localChat.push(...regionEntries);
    }
  }

  private async runEveningPhase(): Promise<void> {
    const living = Object.values(this.state.agents)
      .filter((a) => a.alive)
      .sort((a, b) => a.numericId - b.numericId);
    const isTr = this.config.SIM_LANGUAGE === "tr";
    const eveningSystemPrompt = isTr
      ? "Sen Aldoria dünyasının bir vatandaşısın. Gün sonu değerlendirmeni karakterinden çıkmadan yalnızca istenen JSON şemasıyla yaz."
      : "You are a citizen of Aldoria reflecting at the end of the day. Stay in character and reply ONLY with valid JSON matching the schema.";

    const todayChatByRegion = new Map<RegionId, string[]>();
    for (const c of this.state.localChat) {
      if (c.day !== this.state.day) continue;
      let arr = todayChatByRegion.get(c.regionId);
      if (!arr) {
        arr = [];
        todayChatByRegion.set(c.regionId, arr);
      }
      arr.push(`${c.agentName}: ${c.text}`);
    }

    const eveningResults = await Promise.all(
      living.map(async (agent) => {
        const reg = this.state.regions[agent.region]!;
        const country = this.state.countries[reg.countryId]!;
        const isDying = agent.age === this.config.LIFESPAN_DAYS - 1;
        const isAdult = agent.age >= this.config.EDUCATION_DAYS;

        const todayChat =
          todayChatByRegion.get(agent.region)?.join("\n") ||
          (isTr ? "(sakin bir gün)" : "(quiet day)");

        const daySummary = isTr
          ? `${reg.name} bölgesindeki yerel sohbetler:\n${todayChat}`
          : `Local conversations in ${reg.name}:\n${todayChat}`;
        const identityExtra = isAdult
          ? isTr
            ? `Geçmişin: ${agent.backstory ?? ""}\nDünya görüşün: ${agent.worldview ?? ""}`
            : `Backstory: ${agent.backstory ?? ""}\nWorldview: ${agent.worldview ?? ""}`
          : isTr
            ? `Henüz gençsin (${agent.age} günlük). Müfredat: ${country.curriculumText}`
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
            ? isTr
              ? "İsteğe bağlı olarak bir kültürel eser yayınla (poem, song, meme, slogan veya anthem; en fazla 500 karakter; istemiyorsan work: null)."
              : "Optionally publish one cultural work (poem, song, meme, slogan, or anthem, max 500 chars)."
            : isTr
              ? "work alanını null bırak."
              : "Set work to null.",
          will_prompt: isDying
            ? isTr
              ? `Bu senin son günün (${agent.age} günlüksün). Yerini alacak yenidoğan için vasiyetini (will, en fazla ${this.config.WILL_WORDS} kelime) yaz.`
              : `This is your final day (age ${agent.age}). Write your will (at most ${this.config.WILL_WORDS} words) for the newborn who will take your place.`
            : isTr
              ? "will alanını null bırak."
              : "Set will to null.",
        });

        const fullPromptForLog = `[SYSTEM]\n${eveningSystemPrompt}\n\n[USER]\n${prompt}`;
        const callId = `d${this.state.day}_evening_${agent.id}`;
        const res = await this.llm.generate({
          callId,
          day: this.state.day,
          phase: "evening",
          agentId: agent.id,
          purpose: "evening",
          systemPrompt: eveningSystemPrompt,
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
          promptHash: crypto.createHash("sha256").update(fullPromptForLog).digest("hex"),
          ...(this.config.LOG_FULL_PROMPTS ? { prompt: fullPromptForLog } : {}),
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

        return { agent, res, isAdult, isDying };
      })
    );

    // Apply evening mutations & emit events in deterministic numericId order
    eveningResults.sort((a, b) => a.agent.numericId - b.agent.numericId);

    for (const { agent, res, isAdult, isDying } of eveningResults) {
      if (!res.success || !res.data) continue;
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

    const allAgents = Object.values(this.state.agents);
    const deathsCount = allAgents.filter((a) => a.deathDay === this.state.day).length;
    const birthsCount =
      this.state.day > 0
        ? allAgents.filter((a) => a.bornDay === this.state.day).length
        : 0;

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
      deathsCount,
      birthsCount,
      regionNationCounts,
    };
  }
}
