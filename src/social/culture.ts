import type {
  Agent,
  CultureWork,
  SimConfig,
  WorkKind,
  WorldState,
} from "../../contracts/types.ts";

const WORK_CHAR_LIMIT = 500;

export function publishWork(
  state: WorldState,
  agent: Agent,
  kind: WorkKind,
  rawText: string,
  config: SimConfig
): { succeeded: boolean; work?: CultureWork; reason?: string } {
  if (!agent.alive || agent.age < config.EDUCATION_DAYS) {
    return { succeeded: false, reason: "Only living adults can publish cultural works" };
  }
  if (agent.dailyCounters.workPublished) {
    return { succeeded: false, reason: "Already published a work today" };
  }
  const text = rawText.trim().slice(0, WORK_CHAR_LIMIT);
  if (!text) {
    return { succeeded: false, reason: "Work text cannot be empty" };
  }

  const id = `w${state.nextIds.work++}`;
  const work: CultureWork = {
    id,
    authorId: agent.id,
    authorName: agent.name,
    authorNation: agent.nation,
    day: state.day,
    kind,
    text,
    likes: [],
  };

  state.works.push(work);
  agent.works.push(id);
  agent.dailyCounters.workPublished = true;
  return { succeeded: true, work };
}

export function getHallOfFame(state: WorldState, limit: number = 20): CultureWork[] {
  return [...state.works]
    .sort((a, b) => {
      if (b.likes.length !== a.likes.length) return b.likes.length - a.likes.length;
      return b.day - a.day;
    })
    .slice(0, limit);
}
