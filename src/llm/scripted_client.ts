import type {
  LLMClient,
  LLMGenerateOptions,
  LLMGenerateResult,
} from "../../contracts/interfaces.ts";

export interface ScriptedResponseRule {
  day?: number;
  agentId?: string;
  purpose: "genesis" | "worldview" | "morning" | "local_chat" | "evening";
  response: unknown;
}

export class ScriptedLLMClient implements LLMClient {
  readonly name = "scripted";
  private readonly rules: ScriptedResponseRule[];
  public readonly recordedPrompts: Array<{
    day: number;
    agentId: string | null;
    purpose: string;
    prompt: string;
  }> = [];

  constructor(rules: ScriptedResponseRule[]) {
    this.rules = rules;
  }

  async generate<T>(options: LLMGenerateOptions<T>): Promise<LLMGenerateResult<T>> {
    this.recordedPrompts.push({
      day: options.day,
      agentId: options.agentId,
      purpose: options.purpose,
      prompt: options.prompt,
    });

    const match = this.rules.find(
      (r) =>
        r.purpose === options.purpose &&
        (r.day === undefined || r.day === options.day) &&
        (r.agentId === undefined || r.agentId === options.agentId)
    );

    let rawObj: unknown;
    if (match) {
      rawObj = match.response;
    } else {
      switch (options.purpose) {
        case "genesis":
          rawObj = { backstory: "A citizen of Aldoria.", worldview: "Peace and fairness." };
          break;
        case "worldview":
          rawObj = { worldview: "I have formed my own view." };
          break;
        case "morning":
          rawObj = { private_thought: "Observing.", actions: [] };
          break;
        case "local_chat":
          rawObj = { private_thought: "Listening.", say: null };
          break;
        case "evening":
          rawObj = {
            private_thought: "Resting.",
            diary: `Day ${options.day} passed quietly.`,
            work: null,
            will: options.prompt.toLowerCase().includes("will") ? "Carry on with courage." : null,
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
        promptTokens: Math.ceil(options.prompt.length / 4),
        completionTokens: 10,
        latencyMs: 0,
        retries: 0,
        safetyBlocked: false,
        error: parsed.error.message,
      };
    }

    return {
      success: true,
      data: parsed.data,
      rawText: JSON.stringify(parsed.data),
      promptTokens: Math.ceil(options.prompt.length / 4),
      completionTokens: Math.ceil(JSON.stringify(parsed.data).length / 4),
      latencyMs: 0,
      retries: 0,
      safetyBlocked: false,
    };
  }
}
