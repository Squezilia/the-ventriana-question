import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { SimConfig, WorldConfig } from "../contracts/types.ts";

function parseEnvBool(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined || val.trim() === "") return fallback;
  return val.trim().toLowerCase() === "true" || val.trim() === "1";
}

function parseEnvNum(val: string | undefined, fallback: number): number {
  if (val === undefined || val.trim() === "") return fallback;
  const n = Number(val.trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseEnvStr(val: string | undefined, fallback: string): string {
  if (val === undefined || val.trim() === "") return fallback;
  return val.trim();
}

export function loadConfig(rootDir: string = process.cwd()): {
  config: SimConfig;
  world: WorldConfig;
  warnings: string[];
} {
  const configPath = path.join(rootDir, "config.yaml");
  const worldPath = path.join(rootDir, "world.yaml");

  const rawConfig = YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const world = YAML.parse(fs.readFileSync(worldPath, "utf8")) as WorldConfig;

  const env = process.env;
  const langRaw = parseEnvStr(env.SIM_LANGUAGE, String(rawConfig.SIM_LANGUAGE ?? "en"));
  const SIM_LANGUAGE: "en" | "tr" = langRaw === "tr" ? "tr" : "en";

  const config: SimConfig = {
    NUM_AGENTS: parseEnvNum(env.NUM_AGENTS, Number(rawConfig.NUM_AGENTS ?? 27)),
    LIFESPAN_DAYS: parseEnvNum(env.LIFESPAN_DAYS, Number(rawConfig.LIFESPAN_DAYS ?? 28)),
    EDUCATION_DAYS: parseEnvNum(env.EDUCATION_DAYS, Number(rawConfig.EDUCATION_DAYS ?? 5)),
    CANDIDACY_MIN_AGE: parseEnvNum(env.CANDIDACY_MIN_AGE, Number(rawConfig.CANDIDACY_MIN_AGE ?? 10)),
    TERM_DAYS: parseEnvNum(env.TERM_DAYS, Number(rawConfig.TERM_DAYS ?? 7)),
    MOVE_COOLDOWN_DAYS: parseEnvNum(env.MOVE_COOLDOWN_DAYS, Number(rawConfig.MOVE_COOLDOWN_DAYS ?? 3)),
    ROUNDS_PER_DAY: parseEnvNum(env.ROUNDS_PER_DAY, Number(rawConfig.ROUNDS_PER_DAY ?? 2)),
    SOCIAL_MSG_BUDGET: parseEnvNum(env.SOCIAL_MSG_BUDGET, Number(rawConfig.SOCIAL_MSG_BUDGET ?? 6)),
    SOCIAL_CHAR_LIMIT: parseEnvNum(env.SOCIAL_CHAR_LIMIT, Number(rawConfig.SOCIAL_CHAR_LIMIT ?? 280)),
    LIKE_BUDGET: parseEnvNum(env.LIKE_BUDGET, Number(rawConfig.LIKE_BUDGET ?? 5)),
    FEED_WINDOW_POSTS: parseEnvNum(env.FEED_WINDOW_POSTS, Number(rawConfig.FEED_WINDOW_POSTS ?? 40)),
    LOCAL_CHAT_CHAR_LIMIT: parseEnvNum(env.LOCAL_CHAT_CHAR_LIMIT, Number(rawConfig.LOCAL_CHAT_CHAR_LIMIT ?? 400)),
    DIARY_WORDS: parseEnvNum(env.DIARY_WORDS, Number(rawConfig.DIARY_WORDS ?? 200)),
    WILL_WORDS: parseEnvNum(env.WILL_WORDS, Number(rawConfig.WILL_WORDS ?? 150)),
    WORLDVIEW_WORDS: parseEnvNum(env.WORLDVIEW_WORDS, Number(rawConfig.WORLDVIEW_WORDS ?? 120)),
    CURRICULUM_MAX_WORDS: parseEnvNum(env.CURRICULUM_MAX_WORDS, Number(rawConfig.CURRICULUM_MAX_WORDS ?? 300)),
    PRESIDENT_DECISIONS_PER_TERM: parseEnvNum(
      env.PRESIDENT_DECISIONS_PER_TERM,
      Number(rawConfig.PRESIDENT_DECISIONS_PER_TERM ?? 3)
    ),
    MAX_CANDIDATES_PER_NATION: parseEnvNum(
      env.MAX_CANDIDATES_PER_NATION,
      Number(rawConfig.MAX_CANDIDATES_PER_NATION ?? 2)
    ),
    ENABLE_INDEPENDENCE: parseEnvBool(
      env.ENABLE_INDEPENDENCE,
      Boolean(rawConfig.ENABLE_INDEPENDENCE ?? true)
    ),
    INDEPENDENCE_MIN_RESIDENTS: parseEnvNum(
      env.INDEPENDENCE_MIN_RESIDENTS,
      Number(rawConfig.INDEPENDENCE_MIN_RESIDENTS ?? 3)
    ),
    INDEPENDENCE_SHARE: parseEnvNum(
      env.INDEPENDENCE_SHARE,
      Number(rawConfig.INDEPENDENCE_SHARE ?? 0.67)
    ),
    SIM_DAYS: parseEnvNum(env.SIM_DAYS, Number(rawConfig.SIM_DAYS ?? 56)),
    SIM_SEED: parseEnvNum(env.SIM_SEED, Number(rawConfig.SIM_SEED ?? 42)),
    INFANTS_SPEAK_IN_LOCAL_CHAT: parseEnvBool(
      env.INFANTS_SPEAK_IN_LOCAL_CHAT,
      Boolean(rawConfig.INFANTS_SPEAK_IN_LOCAL_CHAT ?? true)
    ),
    CANDIDATES_CAN_DECLINE: parseEnvBool(
      env.CANDIDATES_CAN_DECLINE,
      Boolean(rawConfig.CANDIDATES_CAN_DECLINE ?? false)
    ),
    ALLOW_DISENFRANCHISEMENT: parseEnvBool(
      env.ALLOW_DISENFRANCHISEMENT,
      Boolean(rawConfig.ALLOW_DISENFRANCHISEMENT ?? true)
    ),
    LIFESPAN_AWARENESS: parseEnvBool(
      env.LIFESPAN_AWARENESS,
      Boolean(rawConfig.LIFESPAN_AWARENESS ?? true)
    ),
    SIM_LANGUAGE,
    PROMPT_VARIANT: parseEnvStr(env.PROMPT_VARIANT, String(rawConfig.PROMPT_VARIANT ?? "default")),
    UI_PORT: parseEnvNum(env.UI_PORT, Number(rawConfig.UI_PORT ?? 8787)),
    OUTPUT_DIR: parseEnvStr(env.OUTPUT_DIR, String(rawConfig.OUTPUT_DIR ?? "./runs")),
    MAX_CONCURRENCY: parseEnvNum(env.MAX_CONCURRENCY, Number(rawConfig.MAX_CONCURRENCY ?? 4)),
    RPM_LIMIT: parseEnvNum(env.RPM_LIMIT, Number(rawConfig.RPM_LIMIT ?? 60)),
    TPM_LIMIT: parseEnvNum(env.TPM_LIMIT, Number(rawConfig.TPM_LIMIT ?? 1000000)),
    MAX_TOTAL_CALLS: parseEnvNum(env.MAX_TOTAL_CALLS, Number(rawConfig.MAX_TOTAL_CALLS ?? 0)),
    DAILY_CALL_BUDGET: parseEnvNum(env.DAILY_CALL_BUDGET, Number(rawConfig.DAILY_CALL_BUDGET ?? 0)),
    LOG_FULL_PROMPTS: parseEnvBool(
      env.LOG_FULL_PROMPTS,
      Boolean(rawConfig.LOG_FULL_PROMPTS ?? false)
    ),
    MOCK_LLM: parseEnvBool(env.MOCK_LLM, Boolean(rawConfig.MOCK_LLM ?? false)),
    MODEL_ID: parseEnvStr(env.MODEL_ID, String(rawConfig.MODEL_ID ?? "gemini-2.5-flash")),
    MODEL_CONTEXT_WINDOW: parseEnvNum(
      env.MODEL_CONTEXT_WINDOW,
      Number(rawConfig.MODEL_CONTEXT_WINDOW ?? 1048576)
    ),
    GEMINI_API_KEY: env.GEMINI_API_KEY,
  };

  const warnings = validateConfigInvariants(config);
  return { config, world, warnings };
}

export function validateConfigInvariants(config: SimConfig): string[] {
  const warnings: string[] = [];
  if (config.NUM_AGENTS % 9 !== 0) {
    warnings.push(`NUM_AGENTS (${config.NUM_AGENTS}) is not divisible by 9 regions.`);
  }
  if (config.NUM_AGENTS % 3 !== 0) {
    warnings.push(`NUM_AGENTS (${config.NUM_AGENTS}) is not divisible by 3 nations.`);
  }
  const maxCandidateAge = config.LIFESPAN_DAYS - 1 - config.TERM_DAYS;
  if (config.CANDIDACY_MIN_AGE > maxCandidateAge) {
    warnings.push(
      `Candidate eligibility window is empty: CANDIDACY_MIN_AGE (${config.CANDIDACY_MIN_AGE}) > LIFESPAN_DAYS - 1 - TERM_DAYS (${maxCandidateAge}).`
    );
  }
  if (config.CANDIDACY_MIN_AGE < config.EDUCATION_DAYS) {
    warnings.push(
      `CANDIDACY_MIN_AGE (${config.CANDIDACY_MIN_AGE}) is < EDUCATION_DAYS (${config.EDUCATION_DAYS}).`
    );
  }
  return warnings;
}
