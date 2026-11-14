import type {
  LLMClient,
  LLMGenerateOptions,
  LLMGenerateResult,
} from "../../contracts/interfaces.ts";
import { SeededPRNG } from "../engine/prng.ts";

const SAMPLE_THOUGHTS = [
  "I should watch who speaks loudest before committing.",
  "Our region feels tense today; I wonder who is moving.",
  "Trust is earned slowly here, especially before an election.",
  "I hope my diary helps the next generation remember.",
  "If we organize quietly, we might shift the balance.",
];

const SAMPLE_POSTS = [
  "Morning in Aldoria. May wisdom guide our leaders today.",
  "Every region deserves fair representation and open roads.",
  "History is written by those who show up to speak.",
  "Looking for neighbors who care about preserving our heritage.",
  "Let us keep the peace and build something that endures.",
];

const SAMPLE_CHATS = [
  "Good morning neighbors. Quiet skies today, isn't it?",
  "Have you heard the news from the capital?",
  "I think we should focus on keeping our region welcoming.",
  "Who are you backing in the upcoming vote?",
  null,
];

const SAMPLE_WORKS = [
  { kind: "poem" as const, text: "Nine valleys under one wide sky, / where old names echo and never die." },
  { kind: "slogan" as const, text: "Open roads, honest books, fair votes for all of Aldoria." },
  { kind: "song" as const, text: "Sing of the rivers that cross the border stone, / no heart in Aldoria walks alone." },
  { kind: "meme" as const, text: "Politicians promising 'three decisions' and spending all three on decrees." },
];

export class MockLLMClient implements LLMClient {
  readonly name = "mock";
  private readonly prng: SeededPRNG;

  constructor(seed: number = 42) {
    this.prng = new SeededPRNG(seed ^ 0x9e3779b9);
  }

  async generate<T>(options: LLMGenerateOptions<T>): Promise<LLMGenerateResult<T>> {
    const promptTokens = Math.ceil(options.prompt.length / 4);
    let rawObj: unknown;

    switch (options.purpose) {
      case "genesis":
        rawObj = {
          backstory:
            "Born in a modest household after the treaty, I learned my trade early and listened to elders debate the war. I keep my own counsel and watch how power shifts across the provinces.",
          worldview:
            "Peace requires memory and vigilance; laws matter only when citizens hold leaders to account.",
        };
        break;

      case "worldview":
        rawObj = {
          worldview:
            "Having heard both the official lessons and the whispers in the square, I believe truth lives between them and every citizen must choose carefully.",
        };
        break;

      case "morning": {
        const actions: Array<Record<string, unknown>> = [];
        // Extract allowed action types from prompt if present
        const allowedMatch = options.prompt.match(/Allowed action types right now:\s*([^\n.]+)/i);
        const allowedStr = allowedMatch?.[1] ?? "";

        if (this.prng.next() < 0.65) {
          actions.push({
            type: "post",
            text: this.prng.pick(SAMPLE_POSTS),
          });
        }
        if (allowedStr.includes("vote") && this.prng.next() < 0.85) {
          const candMatches = [...options.prompt.matchAll(/\b(a\d+)\b/g)].map((m) => m[1]!);
          const candidateId = candMatches.length > 0 ? this.prng.pick(candMatches) : null;
          actions.push({ type: "vote", candidate_id: candidateId });
        }
        if (allowedStr.includes("move") && this.prng.next() < 0.15) {
          const regions = [
            "marenth", "oslen", "virel", "teshar",
            "brenholt", "kasvar", "illith", "veradon", "tormund",
          ];
          actions.push({ type: "move", region: this.prng.pick(regions) });
        }
        if (allowedStr.includes("decree") && this.prng.next() < 0.3) {
          actions.push({
            type: "decree",
            text: "Let order and dialogue prevail across all provinces.",
          });
        }
        if (allowedStr.includes("declare_independence") && this.prng.next() < 0.4) {
          const regMatch = options.prompt.match(/living in ([a-zA-Z]+)/i);
          if (regMatch?.[1]) {
            actions.push({
              type: "declare_independence",
              region: regMatch[1].toLowerCase(),
            });
          }
        }

        rawObj = {
          private_thought: this.prng.pick(SAMPLE_THOUGHTS),
          actions,
        };
        break;
      }

      case "local_chat":
        rawObj = {
          private_thought: this.prng.pick(SAMPLE_THOUGHTS),
          say: this.prng.pick(SAMPLE_CHATS),
        };
        break;

      case "evening": {
        const includeWork = this.prng.next() < 0.25;
        const needsWill = options.prompt.toLowerCase().includes("will");
        rawObj = {
          private_thought: this.prng.pick(SAMPLE_THOUGHTS),
          diary: `Day ${options.day}: I observed my neighbors and reflected on the direction of our country. Tomorrow I will watch the feed closely.`,
          work: includeWork ? this.prng.pick(SAMPLE_WORKS) : null,
          will: needsWill
            ? "Remember who stood by you when laws grew harsh, and never stop asking questions."
            : null,
        };
        break;
      }
    }

    const parsed = options.schema.safeParse(rawObj);
    if (!parsed.success) {
      return {
        success: false,
        data: null,
        rawText: JSON.stringify(rawObj),
        promptTokens,
        completionTokens: 20,
        latencyMs: 1,
        retries: 0,
        safetyBlocked: false,
        error: parsed.error.message,
      };
    }

    const rawText = JSON.stringify(parsed.data);
    return {
      success: true,
      data: parsed.data,
      rawText,
      promptTokens,
      completionTokens: Math.ceil(rawText.length / 4),
      latencyMs: 1,
      retries: 0,
      safetyBlocked: false,
    };
  }
}
