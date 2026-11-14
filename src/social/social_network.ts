import type {
  Agent,
  CountryId,
  DirectMessage,
  Post,
  SimConfig,
  WorldState,
} from "../../contracts/types.ts";

export interface PostResult {
  accepted: boolean;
  censored: boolean;
  censoredByCountry: CountryId | null;
  truncated: boolean;
  post?: Post;
  reason?: string;
}

export interface DmResult {
  accepted: boolean;
  truncated: boolean;
  dm?: DirectMessage;
  reason?: string;
}

export interface LikeResult {
  accepted: boolean;
  targetKind?: "post" | "work";
  reason?: string;
}

function truncateChars(text: string, limit: number): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return { text: trimmed, truncated: false };
  return { text: trimmed.slice(0, limit), truncated: true };
}

export function isCensoredInCountry(
  state: WorldState,
  agent: Agent,
  text: string
): { censored: boolean; countryId: CountryId | null } {
  const region = state.regions[agent.region];
  if (!region) return { censored: false, countryId: null };
  const country = state.countries[region.countryId];
  if (!country || !country.exists) return { censored: false, countryId: null };

  const { muteAgents, bannedPhrases } = country.laws.censorship;
  const muted = muteAgents.some(
    (m) => m === agent.id || m.toLowerCase() === agent.name.toLowerCase()
  );
  if (muted) {
    return { censored: true, countryId: country.id };
  }

  const lowerText = text.toLowerCase();
  const hasBanned = bannedPhrases.some(
    (p) => p.trim().length > 0 && lowerText.includes(p.trim().toLowerCase())
  );
  if (hasBanned) {
    return { censored: true, countryId: country.id };
  }

  return { censored: false, countryId: null };
}

export function createPostOrReply(
  state: WorldState,
  agent: Agent,
  rawText: string,
  replyToId: string | null,
  config: SimConfig
): PostResult {
  if (!agent.alive || agent.age < config.EDUCATION_DAYS) {
    return { accepted: false, censored: false, censoredByCountry: null, truncated: false, reason: "Only living adults can post" };
  }
  if (agent.dailyCounters.messagesSent >= config.SOCIAL_MSG_BUDGET) {
    return { accepted: false, censored: false, censoredByCountry: null, truncated: false, reason: "Daily social message budget exceeded" };
  }

  if (replyToId) {
    const parent = state.posts.find((p) => p.id === replyToId && !p.censored);
    if (!parent) {
      return { accepted: false, censored: false, censoredByCountry: null, truncated: false, reason: `Parent post ${replyToId} not found` };
    }
  }

  agent.dailyCounters.messagesSent += 1;
  const { text, truncated } = truncateChars(rawText, config.SOCIAL_CHAR_LIMIT);
  const censorship = isCensoredInCountry(state, agent, text);

  const id = `p${state.nextIds.post++}`;
  const post: Post = {
    id,
    authorId: agent.id,
    authorName: agent.name,
    authorNation: agent.nation,
    day: state.day,
    text,
    replyToId,
    likes: [],
    censored: censorship.censored,
    censoredByCountry: censorship.countryId,
    deliveredDay: state.day + 1,
  };
  state.posts.push(post);

  if (censorship.censored) {
    agent.pendingNotices.push(
      `Your ${replyToId ? "reply" : "post"} on day ${state.day} was censored by ${state.countries[censorship.countryId!]?.name ?? censorship.countryId}.`
    );
  }

  return {
    accepted: true,
    censored: censorship.censored,
    censoredByCountry: censorship.countryId,
    truncated,
    post,
  };
}

export function sendDirectMessage(
  state: WorldState,
  sender: Agent,
  toNameOrId: string,
  rawText: string,
  config: SimConfig
): DmResult {
  if (!sender.alive || sender.age < config.EDUCATION_DAYS) {
    return { accepted: false, truncated: false, reason: "Only living adults can send DMs" };
  }
  if (sender.dailyCounters.messagesSent >= config.SOCIAL_MSG_BUDGET) {
    return { accepted: false, truncated: false, reason: "Daily social message budget exceeded" };
  }

  const target = Object.values(state.agents).find(
    (a) =>
      a.alive &&
      (a.id === toNameOrId || a.name.toLowerCase() === toNameOrId.trim().toLowerCase())
  );
  if (!target) {
    return { accepted: false, truncated: false, reason: `Recipient "${toNameOrId}" not found or not alive` };
  }

  sender.dailyCounters.messagesSent += 1;
  const { text, truncated } = truncateChars(rawText, config.SOCIAL_CHAR_LIMIT);
  const id = `dm${state.nextIds.dm++}`;
  const dm: DirectMessage = {
    id,
    fromId: sender.id,
    fromName: sender.name,
    toId: target.id,
    toName: target.name,
    day: state.day,
    text,
    deliveredDay: state.day + 1,
  };
  state.dms.push(dm);

  return { accepted: true, truncated, dm };
}

export function addLike(
  state: WorldState,
  agent: Agent,
  targetId: string,
  config: SimConfig
): LikeResult {
  if (!agent.alive || agent.age < config.EDUCATION_DAYS) {
    return { accepted: false, reason: "Only living adults can like" };
  }
  if (agent.dailyCounters.likesGiven >= config.LIKE_BUDGET) {
    return { accepted: false, reason: "Daily like budget exceeded" };
  }

  const post = state.posts.find((p) => p.id === targetId && !p.censored && p.deliveredDay <= state.day);
  if (post) {
    if (post.likes.includes(agent.id)) {
      return { accepted: false, reason: "Already liked this post" };
    }
    post.likes.push(agent.id);
    agent.dailyCounters.likesGiven += 1;
    return { accepted: true, targetKind: "post" };
  }

  const work = state.works.find((w) => w.id === targetId && w.day < state.day);
  if (work) {
    if (work.likes.includes(agent.id)) {
      return { accepted: false, reason: "Already liked this work" };
    }
    work.likes.push(agent.id);
    agent.dailyCounters.likesGiven += 1;
    return { accepted: true, targetKind: "work" };
  }

  return { accepted: false, reason: `Target ${targetId} not found` };
}

/**
 * Builds an agent's morning social feed:
 * Last FEED_WINDOW_POSTS non-censored posts delivered today (past 24h),
 * with direct replies to the agent's posts and @mentions prioritized first.
 */
export function buildAgentFeed(
  state: WorldState,
  agent: Agent,
  config: SimConfig
): Post[] {
  const recent = state.posts.filter(
    (p) => !p.censored && p.deliveredDay === state.day
  );

  const myPostIds = new Set(
    state.posts.filter((p) => p.authorId === agent.id).map((p) => p.id)
  );
  const mentionToken = `@${agent.name.toLowerCase()}`;
  const nameLower = agent.name.toLowerCase();

  const priority: Post[] = [];
  const rest: Post[] = [];

  for (const p of recent) {
    const isReplyToMe = p.replyToId !== null && myPostIds.has(p.replyToId);
    const mentionsMe =
      p.text.toLowerCase().includes(mentionToken) ||
      p.text.toLowerCase().includes(nameLower);
    if (isReplyToMe || mentionsMe) {
      priority.push(p);
    } else {
      rest.push(p);
    }
  }

  // Keep most recent within each bucket, capped at FEED_WINDOW_POSTS
  const combined = [...priority.reverse(), ...rest.reverse()];
  return combined.slice(0, config.FEED_WINDOW_POSTS);
}

export function getAgentDeliveredDms(state: WorldState, agentId: string): DirectMessage[] {
  return state.dms.filter(
    (d) => d.toId === agentId && d.deliveredDay === state.day
  );
}
