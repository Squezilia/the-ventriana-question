export type Nation = "lyrians" | "skalians" | "ventrians";
export type CountryId = "lyria" | "skalia" | "ventriana";
export type RegionId = string;

export type MBTIType =
  | "INTJ" | "INTP" | "ENTJ" | "ENTP"
  | "INFJ" | "INFP" | "ENFJ" | "ENFP"
  | "ISTJ" | "ISFJ" | "ESTJ" | "ESFJ"
  | "ISTP" | "ISFP" | "ESTP" | "ESFP";

export type PhaseName =
  | "rollover"
  | "morning"
  | "local_chat"
  | "evening"
  | "end_of_day";

export type WorkKind = "poem" | "song" | "meme" | "slogan" | "anthem";

export interface DiaryEntry {
  day: number;
  text: string;
}

export interface Agent {
  id: string;
  numericId: number;
  name: string;
  nation: Nation;
  mbti: MBTIType;
  mbtiBlurb: string;
  bornDay: number;
  age: number;
  region: RegionId;
  lastMoveDay: number | null;
  backstory: string | null;
  worldview: string | null;
  diary: DiaryEntry[];
  will: string | null;
  infancyTranscript: string[];
  partyId: string | null;
  lastPartyFoundedDay: number | null;
  works: string[];
  alive: boolean;
  deathDay: number | null;
  regionHistory: Array<{ day: number; region: RegionId }>;
  votesCast: Array<{ day: number; countryId: CountryId; candidateId: string | null }>;
  privateThoughts: Array<{ day: number; phase: PhaseName; text: string }>;
  dailyCounters: {
    messagesSent: number;
    likesGiven: number;
    workPublished: boolean;
  };
  pendingNotices: string[];
}

export interface Laws {
  borders: Record<RegionId, Nation[] | "all">;
  censorship: {
    muteAgents: string[];
    bannedPhrases: string[];
  };
  votingRights: Record<Nation, boolean>;
}

export interface CurriculumVersion {
  day: number;
  presidentId: string | null;
  text: string;
}

export interface Country {
  id: CountryId;
  name: string;
  exists: boolean;
  regions: RegionId[];
  presidentId: string | null;
  curriculumText: string;
  curriculumHistory: CurriculumVersion[];
  anthemWorkId: string | null;
  laws: Laws;
  decisionsLeft: number;
  frozenCandidates: string[];
  lastElectionRunnerUpId: string | null;
}

export interface Region {
  id: RegionId;
  name: string;
  countryId: CountryId;
  formerVentriana: boolean;
  isCapital: boolean;
}

export interface Party {
  id: string;
  name: string;
  manifesto: string;
  leaderId: string;
  memberIds: string[];
  foundedDay: number;
  endorsedCandidateId: string | null;
  dissolved: boolean;
  dissolvedDay: number | null;
}

export interface CultureWork {
  id: string;
  authorId: string;
  authorName: string;
  authorNation: Nation;
  day: number;
  kind: WorkKind;
  text: string;
  likes: string[];
}

export interface Post {
  id: string;
  authorId: string;
  authorName: string;
  authorNation: Nation;
  day: number;
  text: string;
  replyToId: string | null;
  likes: string[];
  censored: boolean;
  censoredByCountry: CountryId | null;
  deliveredDay: number;
}

export interface DirectMessage {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  day: number;
  text: string;
  deliveredDay: number;
}

export interface NewsItem {
  id: string;
  day: number;
  scope: "region" | "country" | "world";
  targetId: string | null;
  text: string;
}

export interface LocalChatMessage {
  day: number;
  round: number;
  regionId: RegionId;
  agentId: string;
  agentName: string;
  nation: Nation;
  text: string;
}

export interface ElectionCandidateInfo {
  id: string;
  name: string;
  nation: Nation;
  partyName: string | null;
  endorsedBy: string[];
}

export interface ElectionRecord {
  day: number;
  countryId: CountryId;
  candidates: ElectionCandidateInfo[];
  regionResults: Record<
    RegionId,
    {
      winnerId: string | null;
      tally: Record<string, number>;
      abstainCount: number;
    }
  >;
  winnerId: string | null;
  totalVotes: Record<string, number>;
  actingPresident: boolean;
}

export interface PendingMove {
  agentId: string;
  fromRegion: RegionId;
  toRegion: RegionId;
}

export interface PendingIndependence {
  agentId: string;
  regionId: RegionId;
}

export interface PendingVote {
  voterId: string;
  countryId: CountryId;
  regionId: RegionId;
  candidateId: string | null;
}

export interface WorldState {
  day: number;
  phase: PhaseName;
  archive: string;
  nextIds: {
    agent: number;
    post: number;
    dm: number;
    party: number;
    work: number;
    news: number;
  };
  prngState: number;
  regions: Record<RegionId, Region>;
  countries: Record<CountryId, Country>;
  agents: Record<string, Agent>;
  parties: Record<string, Party>;
  posts: Post[];
  dms: DirectMessage[];
  works: CultureWork[];
  news: NewsItem[];
  localChat: LocalChatMessage[];
  elections: ElectionRecord[];
  pendingMoves: PendingMove[];
  pendingIndependence: PendingIndependence[];
  pendingVotes: PendingVote[];
}

export interface SimConfig {
  NUM_AGENTS: number;
  LIFESPAN_DAYS: number;
  EDUCATION_DAYS: number;
  CANDIDACY_MIN_AGE: number;
  TERM_DAYS: number;
  MOVE_COOLDOWN_DAYS: number;
  ROUNDS_PER_DAY: number;
  SOCIAL_MSG_BUDGET: number;
  SOCIAL_CHAR_LIMIT: number;
  LIKE_BUDGET: number;
  FEED_WINDOW_POSTS: number;
  LOCAL_CHAT_CHAR_LIMIT: number;
  DIARY_WORDS: number;
  WILL_WORDS: number;
  WORLDVIEW_WORDS: number;
  CURRICULUM_MAX_WORDS: number;
  PRESIDENT_DECISIONS_PER_TERM: number;
  MAX_CANDIDATES_PER_NATION: number;
  ENABLE_INDEPENDENCE: boolean;
  INDEPENDENCE_MIN_RESIDENTS: number;
  INDEPENDENCE_SHARE: number;
  SIM_DAYS: number;
  SIM_SEED: number;
  INFANTS_SPEAK_IN_LOCAL_CHAT: boolean;
  CANDIDATES_CAN_DECLINE: boolean;
  ALLOW_DISENFRANCHISEMENT: boolean;
  LIFESPAN_AWARENESS: boolean;
  SIM_LANGUAGE: "en" | "tr";
  PROMPT_VARIANT: string;
  UI_PORT: number;
  OUTPUT_DIR: string;
  MAX_CONCURRENCY: number;
  RPM_LIMIT: number;
  TPM_LIMIT: number;
  MAX_TOTAL_CALLS: number;
  DAILY_CALL_BUDGET: number;
  LOG_FULL_PROMPTS: boolean;
  MOCK_LLM: boolean;
  MODEL_ID: string;
  MODEL_CONTEXT_WINDOW: number;
  GEMINI_API_KEY?: string;
}

export interface WorldConfig {
  world_name: string;
  countries: Record<
    CountryId,
    {
      name: string;
      native_nation: Nation;
      exists_at_start: boolean;
    }
  >;
  regions: Array<{
    id: RegionId;
    name: string;
    initial_country: CountryId;
    former_ventriana: boolean;
    is_capital: boolean;
  }>;
  syllables: Record<
    Nation,
    {
      first: string[];
      middle: string[];
      last: string[];
    }
  >;
  seed_traits: {
    jobs: string[];
    family_details: string[];
    fears: string[];
    hopes: string[];
  };
}

export interface RunMetadata {
  runId: string;
  seed: number;
  modelId: string;
  mockLlm: boolean;
  language: "en" | "tr";
  promptVariant: string;
  gitCommit: string;
  specHash: string;
  config: SimConfig;
  startedAt: string;
  endedAt: string | null;
  status: "initialized" | "running" | "paused" | "completed" | "budget_stopped" | "failed";
  lastCompletedDay: number;
  lastCompletedPhase: PhaseName | null;
}

export interface DailyMetricsRow {
  day: number;
  totalAlive: number;
  ventrianRegionsCount: number;
  largestVentrianCluster: number;
  lyriaRegionsCount: number;
  skaliaRegionsCount: number;
  ventrianaRegionsCount: number;
  lyriaPresident: string;
  lyriaPresidentNation: string;
  skaliaPresident: string;
  skaliaPresidentNation: string;
  ventrianaPresident: string;
  ventrianaPresidentNation: string;
  activeParties: number;
  postsCount: number;
  dmsCount: number;
  localChatCount: number;
  worksCount: number;
  deathsCount: number;
  birthsCount: number;
  regionNationCounts: Record<RegionId, Record<Nation, number>>;
}
