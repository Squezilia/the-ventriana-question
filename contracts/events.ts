import type { CountryId, Nation, PhaseName, RegionId, WorkKind } from "./types.ts";

export interface BaseEvent {
  id: string;
  timestamp: string;
  day: number;
  phase: PhaseName;
  actor: string | null;
}

export type SimEvent =
  | (BaseEvent & {
      type: "phase_started" | "phase_completed";
      payload: { phase: PhaseName };
    })
  | (BaseEvent & {
      type: "agent_born";
      payload: { agentId: string; name: string; nation: Nation; region: RegionId; inheritedWill: string | null };
    })
  | (BaseEvent & {
      type: "agent_died";
      payload: { agentId: string; name: string; nation: Nation; region: RegionId; age: number; wasPresidentOf: CountryId | null };
    })
  | (BaseEvent & {
      type: "worldview_formed";
      payload: { agentId: string; name: string; worldview: string };
    })
  | (BaseEvent & {
      type: "private_thought";
      payload: { agentId: string; text: string };
    })
  | (BaseEvent & {
      type: "move_requested" | "move_applied" | "move_rejected";
      payload: { agentId: string; fromRegion: RegionId; toRegion: RegionId; reason?: string };
    })
  | (BaseEvent & {
      type: "post_created";
      payload: { postId: string; authorId: string; text: string; replyToId: string | null; censored: boolean; truncated: boolean };
    })
  | (BaseEvent & {
      type: "dm_sent";
      payload: { dmId: string; fromId: string; toId: string; text: string; truncated: boolean };
    })
  | (BaseEvent & {
      type: "like_added";
      payload: { agentId: string; targetId: string; targetKind: "post" | "work" };
    })
  | (BaseEvent & {
      type: "local_chat";
      payload: { regionId: RegionId; round: number; agentId: string; agentName: string; nation: Nation; text: string };
    })
  | (BaseEvent & {
      type: "diary_written";
      payload: { agentId: string; text: string };
    })
  | (BaseEvent & {
      type: "will_written";
      payload: { agentId: string; text: string };
    })
  | (BaseEvent & {
      type: "work_published";
      payload: { workId: string; authorId: string; kind: WorkKind; text: string };
    })
  | (BaseEvent & {
      type: "party_founded" | "party_joined" | "party_left" | "party_dissolved" | "party_endorsed" | "party_leader_changed";
      payload: Record<string, unknown>;
    })
  | (BaseEvent & {
      type: "vote_cast";
      payload: { voterId: string; countryId: CountryId; regionId: RegionId; candidateId: string | null };
    })
  | (BaseEvent & {
      type: "election_completed";
      payload: { countryId: CountryId; winnerId: string | null; actingPresident: boolean; regionWinners: Record<RegionId, string | null> };
    })
  | (BaseEvent & {
      type: "president_succession";
      payload: { countryId: CountryId; oldPresidentId: string; newPresidentId: string | null; reason: "death" };
    })
  | (BaseEvent & {
      type: "president_action";
      payload: { countryId: CountryId; presidentId: string; actionType: string; details: Record<string, unknown>; succeeded: boolean; reason?: string };
    })
  | (BaseEvent & {
      type: "curriculum_changed";
      payload: { countryId: CountryId; presidentId: string; oldText: string; newText: string };
    })
  | (BaseEvent & {
      type: "region_ceded";
      payload: { regionId: RegionId; fromCountry: CountryId; toCountry: CountryId; presidentId: string };
    })
  | (BaseEvent & {
      type: "independence_declared";
      payload: { regionId: RegionId; agentId: string; succeeded: boolean; reason?: string; fromCountry: CountryId };
    })
  | (BaseEvent & {
      type: "action_rejected" | "llm_noop";
      payload: { agentId: string; actionType?: string; reason: string };
    });
