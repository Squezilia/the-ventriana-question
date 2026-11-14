# Architecture & Spec Decisions (`DECISIONS.md`)

Recorded answers to `SPEC.md` §19 open questions from `/grill-me`:

| # | Topic | Decision |
|---|---|---|
| 1 | Model & Structured Outputs | Configured in `.env` (`GEMINI_API_KEY`, `MODEL_ID`, `RPM_LIMIT`, `TPM_LIMIT`). Use Vercel AI SDK (`ai` + `@ai-sdk/google`) with `generateObject` and Zod structured outputs; up to 2 retries appending validation errors on failure, then logged no-op. |
| 2 | Simulation Language | Configured in `.env` (`SIM_LANGUAGE`). Support both `prompts/en/` and `prompts/tr/` templates (defaulting to `en` if unset). |
| 3 | Regions & Adjacency | Placeholder region names and former-Ventriana split in `world.yaml` (Lyria: Marenth, Oslen, Virel, *Teshar*; Skalia: Brenholt, Kasvar, Illith, *Veradon*, *Tormund*). No adjacency (agents may move to any region). |
| 4 | Independence Mechanic | `ENABLE_INDEPENDENCE: true` by default; resolves immediately at end of day (after moves); no extra cooldown after a failed declaration. |
| 5 | Infants in Local Chat | `true` (infants may speak in local chat). |
| 6 | Candidate Opt-out | `false` (candidates cannot decline nomination). |
| 7 | Disenfranchisement | `true` (`set_voting_rights` may remove a nation's vote, effective next election). |
| 8 | Social Feed Algorithm | Recency-based: last `FEED_WINDOW_POSTS` (40) public posts from the past 24h, with direct replies and `@mentions` of the agent prioritized first. |
| 9 | Lifespan Awareness | `true` (agents know people live ~28 days as a world fact). |
| 10 | Language & Storage | **TypeScript everywhere** on **Bun** (`bun:sqlite` + JSON snapshots + `events.jsonl`), **Elysia** backend, **Vite + React** frontend. |
| 11 | Seeds & Prompt Variants | Support `PROMPT_VARIANT` (e.g. `default` vs `aggressive` under `prompts/{lang}/{variant}/`) and skip local chat LLM calls when a region has `<= 1` occupant. |
| 12 | UI Stack & Export Privacy | Elysia (port `8787`, `localhost` only) + Vite + React + Tailwind + Recharts. Static `replay.html` includes DMs & `private_thought` by default (`--no-private` strips them). |
| 13 | Git Workflow | Push directly to `origin main` after each working milestone. |
