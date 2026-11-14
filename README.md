# Ventriana Sorunu · The Ventrian Question

A discrete-time LLM nation simulation set in the world of **Aldoria** — 27 agents across 3 nations (Lyrians, Skalians, and landless Ventrians), 9 regions, a 28-day lifespan, regular elections, presidential powers, cultural works, and social networks — with deterministic replay, a live/replay web dashboard, and a self-contained `replay.html` exporter.

See [`SPEC.md`](./SPEC.md) for the full specification and [`DECISIONS.md`](./DECISIONS.md) for resolved design decisions.

## Setup

1. Install [Bun](https://bun.sh/) (`>= 1.3`).
2. Install dependencies:
   ```bash
   bun install
   ```
3. Copy `.env.example` to `.env` and fill in your `GEMINI_API_KEY`, `MODEL_ID`, `RPM_LIMIT`, and `TPM_LIMIT` (or set `MOCK_LLM=true` for dry runs and tests). **Never commit `.env`.**

## CLI Commands

```bash
# Initialize a new run
bun run sim init

# Run the simulation (mock or real LLM depending on .env)
MOCK_LLM=true bun run sim run --days 56

# Resume an interrupted run
bun run sim run --resume

# Start live dashboard + simulation (http://127.0.0.1:8787)
bun run sim serve --live

# Open replay UI for a finished/in-progress run
bun run sim serve --run <run_id>

# Export self-contained replay.html (use --no-private to strip DMs & private_thought)
bun run sim replay-build --run <run_id>
bun run sim replay-build --run <run_id> --no-private

# Print run statistics
bun run sim stats --run <run_id>

# Deterministically replay a run from llm_calls.jsonl
bun run sim replay-from-log --run <run_id>
```

## Testing

```bash
# Run all unit, scenario, property, contract, and determinism tests
bun test

# Run with coverage
bun test --coverage

# Run Playwright UI E2E tests
bunx playwright test
```
