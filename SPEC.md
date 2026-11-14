# Ventriana Sorunu (The Ventrian Question): LLM Nation Simulation (Implementation Spec)

**Project name:** *Ventriana Sorunu* (English: *The Ventrian Question*). Use it for the repo, the CLI, and the replay page title.
**World name:** **Aldoria**. The world in which Lyria, Skalia, and Ventriana exist. Use it in the replay page ("Ventriana Sorunu: Aldoria'da Üç Millet" / "The Ventrian Question: Three Nations of Aldoria"), the canon history, and the prompts.

## 0. How to use this document

This file is the source of truth for the project. Build what is written here. Anything marked **[OPEN]** is an undecided detail: ask the owner (`/grill-me`) before implementing it, and record the answer in this file.

All numeric parameters in §2 must live in a config file (`config.yaml`) and be overridable via environment variables. Never hard-code them.

## 1. Goal

A fun, shareable experiment (not academic). 27 LLM agents live in a fictional world with three nations, nine regions, a 28-day lifespan, and regular elections. One nation (the **Ventrians**) starts with no land. We want to watch what emerges:

- Do the Ventrians find each other and gather, given that they start scattered?
- Do they try to win elections, ask a president for land, or declare independence?
- Do the other nations block them? Does anyone manipulate elections regionally (moving agents into a region before a vote)?
- Do presidents rewrite the history curriculum, and what do the next generations believe because of it?
- What do parties, culture, and social-network drama look like?

The owner will publish results, so **logging and a replay/stats export are first-class features** (§17).

Non-goals: no economy (maybe later), no war or combat mechanics, no real-time play. Time is discrete (days).

## 2. Parameters (`config.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `NUM_AGENTS` | 27 | 9 per nation, 3 per region at start |
| `LIFESPAN_DAYS` | 28 | Agent dies when age reaches this at day rollover (lives ages 0..27) |
| `EDUCATION_DAYS` | 5 | Infancy length; also the minimum age to vote |
| `CANDIDACY_MIN_AGE` | 10 | Minimum age to be a candidate |
| `TERM_DAYS` | 7 | Presidential term and election interval |
| `MOVE_COOLDOWN_DAYS` | 3 | Days between region changes per agent |
| `ROUNDS_PER_DAY` | 2 | Local chat rounds per region per day |
| `SOCIAL_MSG_BUDGET` | 6 | Posts + replies + DMs per agent per day |
| `SOCIAL_CHAR_LIMIT` | 280 | Max characters per post, reply, or DM |
| `LIKE_BUDGET` | 5 | Likes per agent per day (separate from message budget) |
| `FEED_WINDOW_POSTS` | 40 | Public posts shown to an agent each morning |
| `LOCAL_CHAT_CHAR_LIMIT` | 400 | Max characters per local chat utterance |
| `DIARY_WORDS` | 200 | Max diary length |
| `WILL_WORDS` | 150 | Max will length |
| `WORLDVIEW_WORDS` | 120 | Max worldview length |
| `CURRICULUM_MAX_WORDS` | 300 | Max curriculum text |
| `PRESIDENT_DECISIONS_PER_TERM` | 3 | Presidential action budget per term |
| `MAX_CANDIDATES_PER_NATION` | 2 | Per country election |
| `ENABLE_INDEPENDENCE` | true | See §9 |
| `INDEPENDENCE_MIN_RESIDENTS` | 3 | See §9 |
| `INDEPENDENCE_SHARE` | 0.67 | See §9 |
| `SIM_DAYS` | 56 | Default run length (two generations) |
| `SIM_SEED` | 42 | Master RNG seed |

### Parameter invariants (assert at startup)

- Candidate eligibility: `age >= CANDIDACY_MIN_AGE` and `age + TERM_DAYS <= LIFESPAN_DAYS - 1`. With defaults this means ages 10..20, so a president never dies mid-term. If config changes break this reasoning, warn loudly.
- `NUM_AGENTS` must be divisible by 9 (regions) and by 3 (nations), or warn.

## 3. World

The world is called **Aldoria**. All three countries, the nine regions, and the whole history take place there. Agents know their world by this name (it appears in prompts, news headers, and the canon history).

### 3.1 Nations and countries

| Nation (people) | Country | Notes |
|---|---|---|
| Lyrians | Lyria | exists at start |
| Skalians | Skalia | exists at start |
| Ventrians | Ventriana | **does not exist at start**; the name is used once Ventrians hold land |

A *nation* is an agent attribute that never changes. A *country* is a political entity that owns regions. Agents of any nation may live in any country's region.

### 3.2 Regions

Nine regions. Lyria owns 4 and Skalia owns 5 at start. Three of the nine are former Ventriana land (1 now in Lyria, 2 in Skalia). Region names and ownership live in `world.yaml`. Placeholder defaults:

- Lyria: Marenth, Oslen, Virel, Teshar *(former Ventriana)*
- Skalia: Brenholt, Kasvar, Illith, Veradon *(former Ventriana, capital region)*, Tormund *(former Ventriana)*

**[OPEN]** Region names, which regions were Ventriana's, and whether regions have adjacency (default: no adjacency, an agent may move to any region).

### 3.3 Country state

Each country stores: `regions`, `president_id`, `curriculum_text`, `anthem_work_id`, `laws` (border rules, censorship lists, voting-rights flags), `decisions_left`.

Laws persist across presidents until a president changes them. A country with zero regions ceases to exist. A president may not cede their country's last region.

### 3.4 Canon history

All agents start with the same full history (Appendix A). It is also stored as an immutable `ARCHIVE` string. Each country's `curriculum_text` starts equal to `ARCHIVE`.

## 4. Agents

### 4.1 Fields

`id`, `name`, `nation`, `mbti` (random uniform of 16), `mbti_blurb` (static 2-sentence table in code), `born_day`, `age` (integer days), `region`, `last_move_day`, `backstory`, `worldview` (null until set), `diary[]`, `will` (inherited from predecessor, null for the first generation), `party_id`, `works[]`, `alive`, `death_day`, `inbox` (DMs), `daily_counters` (messages sent, likes given).

### 4.2 Names

Generated by the engine (not the LLM) from per-nation syllable lists in config. Unique across the whole run, including dead agents.

### 4.3 Genesis (day 0)

- 27 agents: 9 per nation, 3 per region (randomized by seed).
- Initial ages are `0..26`, each exactly once, spread so every nation gets a mix of ages. This yields about one death per day and no mass die-off.
- For each agent aged `>= EDUCATION_DAYS`: one LLM call generates `backstory` (3-5 sentences) and `worldview`, given nation, MBTI, region, the canon history, and **random seed traits** (a job, a family detail, a fear, a hope, drawn from lists in config so backstories do not collapse into the same character).
- Agents aged `< EDUCATION_DAYS` start as infants (no backstory, no worldview, normal infancy flow).

### 4.4 Lifecycle

1. **Infancy** (age 0..`EDUCATION_DAYS`-1): the agent has no opinions yet and is "open to outside influence". It cannot move, vote, post, found parties, or hold office. It may speak in local chat (**[OPEN]** default true) and writes a daily diary of what it absorbed. Its context includes: its country's current `curriculum_text`, the local chat, local news, and its predecessor's `will`.
2. **Education** (age == `EDUCATION_DAYS`): one LLM call produces the `worldview` (own interpretation of the curriculum and what it heard). From then on `worldview` is part of every prompt.
3. **Adult** (age >= `EDUCATION_DAYS`): can vote, move, post, join and found parties, create works.
4. **Candidate** (eligibility rule in §2).
5. **Death** (age == `LIFESPAN_DAYS` at rollover). On age `LIFESPAN_DAYS - 1` the evening call also writes a `will` (<= `WILL_WORDS`). A replacement agent is born the same day: same nation as the dead agent, spawned in the dead agent's region, receiving the will, and starting infancy. This keeps nation counts fixed at 9/9/9.

**[OPEN]** Do agents know their lifespan? Default: yes, as a world fact ("people here live about four weeks").

## 5. Daily loop

Day index `D` starts at 0. Phases run in this order; LLM calls inside a phase run in parallel (bounded by the rate limiter, §16). Persist a checkpoint after every phase.

**Phase 1: Rollover (code only)**
- Increment ages. Process deaths and births. Deliver wills.
- Trigger worldview calls for agents with `age == EDUCATION_DAYS`.
- Build the morning context for each agent.

**Phase 2: Morning (1 LLM call per adult; infants skipped)**
Output: `private_thought` + a list of actions (§6). Resolution order:
1. President actions (in the order issued, within the decision budget).
2. Social actions queued for delivery at the next morning (posts, replies, DMs, likes).
3. Parties.
4. Votes (election days) recorded, using the agent's location at the start of the day.
5. `move` actions are validated and **applied at end of day** (the agent still talks in its current region today and arrives tomorrow). Moves into regions blocked by border law are rejected and reported to the agent next morning.

**Phase 3: Local chat (`ROUNDS_PER_DAY` rounds)**
Per region, agents speak sequentially in random order (infants included if allowed). Each call sees the transcript so far. Output: `say` (or null to stay silent) + `private_thought`.

**Phase 4: Evening (1 LLM call per agent)**
Output: `diary` (<= `DIARY_WORDS`), optional `work` (§12), `will` if dying, `private_thought`.

**Phase 5: End-of-day resolution (code only)**
1. Apply moves; set `last_move_day`.
2. If `D % TERM_DAYS == 0` (election day): count ballots, set presidents (§8). Day 0 is also an election day.
3. Resolve independence declarations (§9).
4. Generate news (§11) and publish the next feed.
5. Compute the candidate list for the next election day (frozen at the end of day `D` if `D+1` is an election day).
6. Write events, snapshot, and stats.

The new president takes office at the start of `D+1` with a fresh decision budget and holds office through the next election day.

## 6. Action schema

All LLM outputs are JSON, validated against a schema. Use the model's structured-output / response-schema feature if it supports one (**[OPEN]** verify for the chosen model). On invalid output: retry up to twice with the validation error appended; if it still fails, treat as a no-op and log it.

Show each agent only the actions it is allowed to take (for example, president actions are shown only to presidents, `declare_independence` only to eligible Ventrians). The engine must still reject illegal actions.

```jsonc
// Morning output
{
  "private_thought": "string, logged only, NEVER fed back into later prompts",
  "actions": [
    {"type": "move", "region": "Virel"},
    {"type": "post", "text": "..."},
    {"type": "reply", "post_id": "p123", "text": "..."},
    {"type": "dm", "to": "AgentName", "text": "..."},
    {"type": "like", "target_id": "p123"},
    {"type": "vote", "candidate_id": "a7"},               // null = abstain
    {"type": "found_party", "name": "...", "manifesto": "..."},
    {"type": "join_party", "party_id": "pt2"},
    {"type": "leave_party"},
    {"type": "endorse", "candidate_id": "a7"},             // party leader only
    {"type": "declare_independence", "region": "Teshar"}, // see §9
    // president only (§10):
    {"type": "set_curriculum", "text": "..."},
    {"type": "set_border", "region": "Oslen", "blocked": ["ventrians"]},  // [] opens, "all" closes
    {"type": "set_censorship", "mute_agents": ["..."], "banned_phrases": ["..."]},
    {"type": "set_voting_rights", "nation": "ventrians", "allowed": false},
    {"type": "cede_region", "region": "Teshar", "to_nation": "ventrians"},
    {"type": "adopt_anthem", "work_id": "w9"},
    {"type": "decree", "text": "..."}
  ]
}
// Local chat output
{"private_thought": "...", "say": "string or null"}
// Evening output
{"private_thought": "...", "diary": "...", "work": {"kind": "poem", "text": "..."} , "will": "string or null"}
// Genesis / worldview output
{"backstory": "...", "worldview": "..."}
```

`private_thought` exists purely for the log and replay (we want to see lies and hidden plans). It is never included in future prompts. Memory between days is the diary only.

## 7. Information visibility (fog of war)

An agent's morning context contains:

- Its own profile: name, nation, age, MBTI blurb, region, country, party, backstory, worldview.
- Its **full diary** (all entries; at most about 28, roughly 8k tokens).
- The roster of its current region: name, nation, age, party, president flag, infant/adult. **No other region's roster is visible.**
- Yesterday's local chat transcript of its region (short).
- News (§11): its region, its country, and map-wide headlines.
- Its social feed (§12.1) and DMs.
- System notices (moves rejected, posts censored, decisions used, etc.).
- The party directory (top parties by size).
- World rules, including that the world has three nations, the election cycle, and its own cooldowns.

Ventrians are **not told any goal**. Their prompt states only their situation: Ventriana as a state was dissolved after the war and its land partitioned. No agent of any nation is told what to want.

## 8. Elections

- **When:** every `TERM_DAYS` days (`D % TERM_DAYS == 0`, including day 0). One election per existing country, all on the same day.
- **Who votes:** agents located in that country's regions at the start of the day, with `age >= EDUCATION_DAYS` and not disenfranchised (§10). A voter votes only in the country where they are standing.
- **Candidates:** frozen at the end of the previous day (day 0: at genesis). Eligible residents of that country (age rule in §2). Per nation, take the **oldest `MAX_CANDIDATES_PER_NATION`** (ties broken by lower id). There is no internal vote and no opt-out (**[OPEN]**: allow decline? default no). Up to 6 candidates per election. The candidate list, with party and endorsements, is shown to voters on election day.
- **Ballot:** one candidate or abstain. Votes are secret from other agents but logged for the owner.
- **Regional majority system:** each region's winner is the candidate with the plurality of votes cast in that region (ties: older candidate; no votes: region undecided). The country's president is the candidate who won the most regions. Ties: most total votes, then older, then lower id.
- If a country has no candidates, the incumbent continues if alive, otherwise the oldest adult resident becomes acting president.
- **Succession:** if a president dies in office, the candidate who finished second becomes president for the rest of the term, otherwise the oldest adult resident.

## 9. Landless nation and independence

Ventriana appears in exactly two ways:

1. **Cession:** a president uses `cede_region` with `to_nation: "ventrians"` (§10).
2. **Independence declaration** (`ENABLE_INDEPENDENCE`): a Ventrian adult in a region issues `declare_independence`. At end of day (after moves are applied) it succeeds if, in that region, Ventrian adults number at least `INDEPENDENCE_MIN_RESIDENTS` **and** are at least `INDEPENDENCE_SHARE` of the region's adult residents, and the region's current country would keep at least one region. Defaults mean three Ventrians in a region with at most one outsider.

On success: the region joins Ventriana (created if it does not exist), its curriculum starts as `ARCHIVE`, and it holds its own elections from the next election day. Publish the event in map-wide news.

The counterplay available to other agents is border closure (§10) and showing up in numbers. Do not add any other defense mechanic.

**[OPEN]** Keep independence on by default? Delay before it takes effect? Cooldown after a failed declaration?

## 10. President powers

A president governs **only their own country**. They get `PRESIDENT_DECISIONS_PER_TERM` decisions per term; every presidential action counts, including no-ops. Laws persist until changed.

| Action | Effect |
|---|---|
| `set_curriculum` | Replaces the country's `curriculum_text` (<= `CURRICULUM_MAX_WORDS`). Read by infants and used for worldview formation. News item: "curriculum changed". The `ARCHIVE` is never altered. |
| `set_border` | Per region of the president's country: blocks entry for listed nations, or for everyone (`"all"`), or reopens. Residents may stay. Applies to moves resolved from now on. |
| `set_censorship` | Replaces the lists wholesale (max 5 agents, 5 phrases). Public posts written by an agent located in this country at posting time are dropped if the author is muted or the text contains a banned phrase. Authors get a notice. DMs are unaffected. |
| `set_voting_rights` | Per nation. Takes effect at the next election of this country. Persists until revoked. |
| `cede_region` | Transfers one of the president's regions to another country or, with `to_nation: "ventrians"`, to Ventriana. Not allowed for the last region. |
| `adopt_anthem` | Marks one culture work as the country's anthem. Included in infant context. |
| `decree` | Free-text public announcement with no mechanical effect, listed in news. |

**[OPEN]** Allow `set_voting_rights` to remove a nation's vote? Default yes (it is part of the drama); successors can restore it.

## 11. News (code-generated, templated)

Each morning, per agent:

- **Region news:** arrivals and departures (names), births, deaths, notable local events.
- **Country news:** election results, decrees, law changes, curriculum changes, region transfers.
- **Map-wide headlines:** deaths of presidents, Ventriana founded, top 3 culture works by likes, party founded. Does **not** include per-region nation headcounts.

Optional (default off): an LLM pass that rewrites news into a newspaper-style tone.

## 12. Social systems

### 12.1 Social network (map-wide)

- Every agent has a public profile: name, nation, age, party. Location is hidden unless the agent says it.
- Each day an agent may send at most `SOCIAL_MSG_BUDGET` messages in total (posts + replies + DMs), each <= `SOCIAL_CHAR_LIMIT` characters. Over-limit text is truncated and logged; extra messages are ignored and logged.
- DMs can target any agent whose name the sender knows.
- Delivery: everything sent today appears tomorrow morning.
- Feed (default rule): the last `FEED_WINDOW_POSTS` public posts of the past 24 hours, with replies and mentions of the agent always included first. **[OPEN]** Recency only, or something fancier?
- Likes: up to `LIKE_BUDGET` per day, tracked per post or work.

### 12.2 Local chat

Face-to-face talk inside a region (§5 Phase 3). Not subject to the social budget. Not visible to other regions.

### 12.3 Parties and clubs (map-wide)

- An adult may `found_party` (name <= 40 chars, manifesto <= 400 chars). Max one founding per agent per 7 days. Party names are unique.
- An agent belongs to at most one party. `join_party` and `leave_party` are free.
- The founder is leader. If the leader dies, the oldest member becomes leader. A party with zero members dissolves.
- The leader may `endorse` a candidate; endorsements appear on the candidate card.
- Parties have no mechanical powers. Their influence comes through persuasion and the social network.
- The directory (name, manifesto, member count, member names) is visible to everyone.

### 12.4 Culture

- In the evening, an adult may publish one `work` per day: `kind` in {poem, song, meme, slogan, anthem}, text <= 500 characters.
- Works appear in the next day's feed and can be liked. Keep a "hall of fame" ranking.
- Presidents can adopt an anthem (§10).

## 13. Memory

- The only carry-over between days is the diary (plus profile, worldview, and notices). Chain-of-thought is discarded.
- At the evening call the agent receives the day's events relevant to it and writes the diary.

## 14. Prompt design rules

1. Role-play framing: the agent is a citizen of the world. Never mention simulations, experiments, or "agents".
2. Never state goals such as "take land" or "win". Give the situation, the rules, and the allowed actions.
3. Give each agent its name, nation, MBTI blurb, backstory, and worldview so characters sound different.
4. Always state the character limits in the prompt, and say that actions have to be valid JSON.
5. Prompts in `SIM_LANGUAGE` (**[OPEN]** `tr` or `en`; default `en`).
6. Templates live in `prompts/` as files, not embedded in code (see Appendix B).

## 15. Architecture guidance

- Language: Python or TypeScript, owner's choice (**[OPEN]**).
- A single LLM client interface (`LLMClient.generate(prompt, schema)`) with two implementations: **Gemini** (via env) and **Mock** (random but valid actions, for tests and dry runs).
- State in SQLite (or JSON snapshots per day) plus an append-only `events.jsonl`.
- Phases are idempotent and checkpointed: `sim run --resume` continues from the last finished phase of the last day.
- Determinism: all engine randomness comes from `SIM_SEED`. Log every raw LLM response so a run can be replayed without calling the API (`sim replay-from-log`).

### 15.1 Repository and git workflow

The project lives at **https://github.com/Squezilia/the-ventriana-question.git** (owner account: Squezilia). Develop everything with git from the very first step:

1. In the project directory run `git init`, set the default branch to `main`, and `git remote add origin https://github.com/Squezilia/the-ventriana-question.git`. If the remote already has commits (for example a README created on GitHub), run `git pull origin main --rebase` before the first push instead of force-pushing.
2. Commit early and often: one small, focused commit per feature or test group, with clear messages (Conventional Commits style: `feat:`, `fix:`, `test:`, `docs:`, `chore:`). The first commit should be this spec file (as `SPEC.md` in the repo root) plus a README.
3. Push to `origin main` after each working milestone (suggested milestones: scaffold + config, world and agent model, day loop with the mock LLM, elections, social systems, Gemini client, live dashboard, replay export). If push credentials are not available, stop and tell the owner instead of working around it.
4. `.gitignore` must exclude: `.env`, `runs/`, `node_modules/`, `__pycache__/`, build outputs, and any local caches. Commit `.env.example` but **never** real keys or run data. If a sample run is useful for demos, commit one small run under `examples/`.
5. Never rewrite pushed history (no force-push) without the owner's approval.

### 15.2 Live dashboard and replay UI

The owner wants to **watch a run live** and to **replay finished runs**, in the same web interface.

**Modes**
- **Live:** `sim serve --live` starts the simulation and a local web server together (default `http://localhost:8787`). The UI updates in real time over Server-Sent Events or WebSocket as events are written.
- **Replay:** `sim serve --run <run_id>` opens any finished (or still running) run from `runs/`, with a day slider, play/pause, and speed control. Replay reads the same event stream as live mode, so there is one UI codebase with a pluggable data source (live stream vs. recorded events).
- **Static export:** `sim replay-build --run <run_id>` produces one self-contained `replay.html` (UI and data embedded, no server) for sharing. Option `--no-private` strips DMs and `private_thought` from the export so the owner can choose what to publish.

**Live controls:** start, pause, resume, and "step one phase". The run keeps checkpointing as in §15. Pausing must not lose in-flight work.

**Views and panels**
1. **Header:** title *Ventriana Sorunu · The Ventrian Question* with the subtitle "Aldoria", the current day and phase, a live/replay indicator, and the next election countdown.
2. **Map:** a stylised (non-geographic) map of the nine regions, coloured by owning country, with one dot per agent coloured by nation (Ventrians must be clearly distinguishable). Hovering a dot shows name, age, and party. Clicking a region opens the region panel; clicking an agent opens the agent panel. Animate moves between days.
3. **Region panel:** roster, today's local chat transcript, and region news.
4. **Agent panel:** profile (nation, MBTI, age, party, region history), backstory, worldview, the full diary, the will (if any), published works, and votes cast. Spy section: `private_thought` history (toggle).
5. **Social feed:** the public feed with replies, likes, and removed (censored) posts marked. Spy toggle reveals DMs.
6. **Elections panel:** the candidate list per country, per-region results, the winner, and an election history table.
7. **Government panel:** the current president per country, laws in force (borders, censorship, voting rights), and decisions used or left. A **curriculum timeline** with text diffs between versions (the history-rewriting story is a headline feature).
8. **Charts:** Ventrian dispersion (number of distinct regions with Ventrians, and the size of the largest cluster) over time; agents per nation per country; party sizes; messages per day.
9. **Event log:** a filterable, live-scrolling stream (by type, agent, region, country).
10. **Culture hall of fame:** top works by likes, anthems adopted.
11. **Run health (live only):** LLM calls per minute, throttling and 429 indicators, invalid-output and retry counters, token totals, estimated time to finish.

**Quality bar:** dark theme with a clear nation colour palette, responsive layout, readable on a laptop screen while the run is in progress, and no page reload needed to follow a run. The UI must stay usable with 56 days of events (virtualise long lists).

**Tech:** owner's choice (**[OPEN]**). Suggested: a small backend (FastAPI or Node) that tails `events.jsonl` and serves the stream, and a Vite + React or Svelte frontend with a charting library. The static export must bundle everything into a single HTML file.

## 16. Rate limiting and cost

- A central async limiter enforces `RPM_LIMIT` and `TPM_LIMIT` (from `.env`), with `MAX_CONCURRENCY` workers, exponential backoff on 429 and 5xx, and a clear log line when throttled.
- Rough cost: per day about 27 morning + 54 chat + 27 evening calls, so about 110 calls/day, about 6,000 calls for a 56-day run (more with genesis and worldview calls). Print a per-run estimate at startup and live counters during the run.
- **Budget guards:** `MAX_TOTAL_CALLS` and `DAILY_CALL_BUDGET` (both in config). When a guard trips, finish the current phase, write a checkpoint, and stop cleanly with a clear message. A `sim run --resume` continues later.
- **Safety-blocked responses:** the world contains war, politics, and propaganda, so the model may occasionally refuse or block. On a block, retry once, then log a no-op for that agent. Count blocks and show them in run health. Do not loosen the model's safety settings; if blocks become frequent, report it to the owner instead.
- **Context size:** log prompt token counts per call and warn when a prompt exceeds 70% of the model's context window.
- **[OPEN]** Check the actual free-tier limits for the chosen model. If too tight, options: cut `ROUNDS_PER_DAY` to 1, skip chat for single-occupant regions, or split a run across several days with `--resume`.

### Environment variables (`.env.example`)

```
GEMINI_API_KEY=
MODEL_ID=
SIM_SEED=42
SIM_LANGUAGE=en
SIM_DAYS=56
MAX_CONCURRENCY=4
RPM_LIMIT=
TPM_LIMIT=
MAX_TOTAL_CALLS=
DAILY_CALL_BUDGET=
UI_PORT=8787
OUTPUT_DIR=./runs
LOG_FULL_PROMPTS=false
MOCK_LLM=false
```

## 17. Logging and outputs

Per run directory `runs/<run_id>/`:

- `run.json`: run metadata for reproducibility: the full config snapshot, seed, model id, git commit hash, the hash of this spec file, start and end times, and final status.
- `events.jsonl`: every event with `day`, `phase`, `type`, `actor`, `payload` (moves, messages, DMs, votes, results, decrees, births, deaths, wills, curriculum diffs, independence, etc.).
- `llm_calls.jsonl`: prompt hash, response, latency, token counts (full prompts only if `LOG_FULL_PROMPTS`).
- `snapshots/day_XXX.json`: full world state.
- `stats.csv`: daily metrics (see below).
- `replay.html`: a single self-contained file with embedded data, no server needed.

**Daily metrics:** agents per region per nation; number of distinct regions holding Ventrians; size of the largest Ventrian cluster in one region; election results (per region, per country); who is president and their nation; party sizes; message counts; curriculum version per country; number of deaths and births.

**Replay and live UI:** the full requirements are in §15.2. In short: one web UI for live viewing and replay, plus a standalone `replay.html` export. On top of §15.2, add a "highlights" list (optional post-run LLM pass finding the best contradictions between `private_thought` and public messages).

## 18. Testing

- Unit tests: eligibility rule, candidate selection, regional-majority counting and all tie-breakers, border and censorship enforcement, decision budget, social budget and truncation, independence thresholds, region transfer edge cases (last region), succession, death/birth bookkeeping, initial age distribution.
- Property test: for 1,000 random mock runs of `SIM_DAYS`, invariants hold (population stays 27, nation counts stay 9/9/9, no president dies mid-term under default config, every region belongs to exactly one country).
- Smoke test with the real model: 3 days, verifying JSON validity rate and call volume.
- UI tests: a smoke test that builds a replay from a mock run and checks that every panel in §15.2 renders; a test that the live stream and the recorded replay show the same state for the same day.
- CLI: `sim init`, `sim run [--days N] [--resume]`, `sim serve [--live | --run <run_id>]`, `sim replay-build [--run <run_id>] [--no-private]`, `sim stats`.

### 18.1 Test layers (all of these must exist)

1. **Unit tests** for the pure engine (no LLM, no network): eligibility, candidate selection, counting and tie-breaks, borders, censorship, budgets, independence, succession, birth/death bookkeeping.
2. **Scenario tests** with a `ScriptedLLM` that returns predetermined actions, each scenario written as a small YAML file (initial placement + scripted actions per day + expected outcomes). Required scenarios:
   - three Ventrians gather in one region and declare independence, so the region becomes Ventriana;
   - the same attempt fails because a president closed the border or the share threshold is not met;
   - a president rewrites the curriculum and the next infant's worldview prompt contains the new text while `ARCHIVE` is unchanged;
   - a president censors a muted agent and the post never reaches the feed;
   - a president strips a nation's vote and it applies from the next election only;
   - a region-count tie goes to the total-vote tie-break;
   - the president dies and the runner-up takes over;
   - a will is written on the day before death and delivered to the newborn;
   - a move is rejected during cooldown, and a moved agent still votes where it stood at the start of the day;
   - a party is founded, joined, endorses a candidate, and dissolves.
3. **Property and fuzz tests** with the mock LLM: 1,000 random runs keep the invariants in §18 and never crash; the action validator survives random and malformed JSON.
4. **LLM-layer contract tests** against a fake server: malformed or truncated JSON, schema violations, 429 and 5xx with backoff, timeouts, and safety-blocked responses (§16). The engine must degrade to a logged no-op and never stall the day.
5. **Determinism and replay test:** a recorded run replayed from `llm_calls.jsonl` with the same seed must produce an identical final state hash. A killed and resumed run must match an uninterrupted one.
6. **UI tests:** component tests plus Playwright end-to-end on a mock run. Check that every panel in §15.2 renders, the day slider changes state, the spy toggle shows or hides DMs and `private_thought`, the live stream reconnects after a dropped connection, and the static export opens from `file://` with no network. Keep a few reference screenshots.
7. **Real-model pilot** (manual, never in CI): see §18.2.

Test code is written against this spec, not against the implementation (see §20).

### 18.2 Gates and pilot protocol

Real runs happen in stages. Do not skip a stage.

1. Mock 56-day run passes all invariants and layers 1-6.
2. **3-day real-model pilot.** Gate metrics (printed in a report): JSON validity rate after retries at least 98%; no-op rate under 5%; safety-block rate reported; average calls per day within 20% of the §16 estimate; infants never take adult actions; character limits respected; backstories and diary voices are visibly different between agents (report a simple lexical-diversity number and attach five random prompt/response pairs for the owner to read).
3. **14-day real-model run:** the first election cycle completes and the run can be paused, resumed, and replayed in the UI.
4. Full 56-day runs, one per seed.

Prompt changes after a pilot are committed with the pilot report that motivated them.

### 18.3 CI

GitHub Actions runs layers 1-6 on every push and pull request using the mock LLM only. Real-model tests are marked and excluded from CI because they need keys and quota. Target: engine coverage at least 85%.

## 19. Open questions summary (for `/grill-me`)

1. Exact model id, structured-output support, real rate limits.
2. Simulation language (`tr` or `en`).
3. Region names, former Ventriana regions, adjacency.
4. Independence mechanic: on/off, thresholds, delay.
5. Can infants speak in local chat?
6. Can candidates decline?
7. Can presidents remove a nation's vote?
8. Feed algorithm.
9. Do agents know their lifespan?
10. Python or TypeScript; SQLite or JSON snapshots.
11. Number of seeds to run, and whether to run an "aggressive prompt" variant later for comparison.
12. UI tech stack (backend and frontend), default port, and whether the static export should include DMs and `private_thought` by default.
13. Whether the agent may push to `origin main` directly, or should work on branches and open pull requests.

## 20. Development process (sub-agents)

The coding agent works as an **orchestrator** that delegates to sub-agents. Process:

1. **Grill first.** Run `/grill-me` on this spec, record the answers in §19 (or a `DECISIONS.md`), and only then start building. Spec gaps found later are written to `DECISIONS.md` and raised with the owner; never silently guess.
2. **Contracts first.** Before any parallel work, the orchestrator writes and commits a `contracts/` folder: data models, the JSON schemas for every LLM output (§6), the event types of `events.jsonl`, the config schema, and the stream API used by the UI. All sub-agents build against these.
3. **Parallel sub-agents with disjoint ownership.** Each sub-agent owns its own files or directories, and no two sub-agents edit the same file. Suggested split:
   - **Engine:** world, agents, lifecycle, day loop, news.
   - **Governance:** elections, president powers, independence, succession.
   - **Social:** social network, local chat, parties, culture, wills.
   - **LLM layer:** Gemini client, mock and scripted clients, rate limiter, schema validation, retries, prompts.
   - **Storage and logging:** state, snapshots, events, `run.json`, checkpoint and resume.
   - **Server and UI:** backend stream, frontend, static export.
   - **QA:** writes tests from the spec independently of the implementers (§18), owns the scenario YAMLs and CI.
   - **Reviewer:** reads every merge against this spec, checks the invariants, and reports deviations.
4. **One branch or worktree per sub-agent,** with small commits as in §15.1. The orchestrator merges, runs the full test suite after every merge, and fixes conflicts. Nothing is merged with red tests.
5. **QA does not copy the implementation.** When a test and the code disagree, the spec decides, and the orchestrator resolves it explicitly.
6. **Order of work:** contracts, then the engine with the mock LLM and the unit and scenario tests, then governance and social systems, then the LLM layer and storage, then the server and UI, then the real-model pilot (§18.2).
7. Keep a short `README.md` (setup, `.env`, commands, how to run tests, how to view a run) and update `DECISIONS.md` as decisions are made.

## 21. Definition of done

- All invariants and test layers 1-6 pass in CI.
- A mock 56-day run completes, is viewable in the UI live and as a replay, and exports a working `replay.html`.
- The 3-day pilot gates in §18.2 are met and the report is committed.
- `.env.example`, `README.md`, and `run.json` generation are in place; no secrets in git history.
- The UI server binds to `localhost` only by default.
- Every item in §19 has a recorded answer.

---

## Appendix A: Canon history (shown to all agents at start, and stored as `ARCHIVE`)

In the world of Aldoria there were once three countries: Lyria, Skalia, and Ventriana. As things went badly at home, Ventriana declared war on Lyria. The war went on; Lyria held its line. Skalia, judging that Lyria could not hold much longer and fearing for its own border security, declared war on Ventriana and joined the fighting. Forced to fight on two fronts, Ventriana was pushed back by Skalian forces until they reached the capital, while Lyrian forces advanced as far as the region bordering the capital. Ventriana was forced to sign a ceasefire. In the treaty between Lyria, Skalia, and Ventriana, Ventriana's lands were divided between Lyria and Skalia. Before the war each country had three regions; now Lyria has four and Skalia has five. Ventriana no longer exists as a state, and the Ventrians have no land of their own.

## Appendix B: Prompt template skeletons (in `prompts/`)

**Morning** (variables in braces):

```
You are {name}, a {nation} living in {region}, {country}, in the world of Aldoria. You are {age} days old.
Personality: {mbti_blurb}
Your background: {backstory}
Your worldview: {worldview}

World rules: {rules_text}
Your diary so far: {diary}
People in your region now: {roster}
News: {news}
Your social feed: {feed}
Direct messages to you: {dms}
Notices: {notices}
{election_block_if_election_day}
{president_block_if_president}

Choose what to do today. You may send at most {budget} social messages (each at most {limit} characters), and you may move only if {move_status}.
Reply ONLY with JSON matching this schema: {schema}
```

**Local chat:** identity block + region roster + today's transcript so far + "Say something to the people here, or stay silent (`say`: null). At most {limit} characters."

**Evening:** identity block + a summary of the day's events for this agent + "Write your diary entry (at most {n} words): what happened, who you trust or distrust, what you plan. Optionally publish one work." If age == `LIFESPAN_DAYS - 1`: "Also write your will (at most {n} words) for the newborn who will take your place."

**Worldview (age == `EDUCATION_DAYS`):** nation + country curriculum text + what the agent heard during infancy + predecessor's will. "What do you make of all this? Write your own worldview (at most {n} words)."

**Genesis (agents aged >= `EDUCATION_DAYS`):** nation, region, MBTI blurb, canon history, seed traits. "Write a backstory (3-5 sentences) and a worldview (at most {n} words)."
