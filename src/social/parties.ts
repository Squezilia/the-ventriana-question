import type { Agent, Party, SimConfig, WorldState } from "../../contracts/types.ts";

export interface PartyActionResult {
  succeeded: boolean;
  party?: Party;
  reason?: string;
}

export function removeAgentFromParty(
  state: WorldState,
  agent: Agent
): { dissolvedPartyId?: string; newLeaderId?: string; leftPartyId?: string } {
  if (!agent.partyId) return {};
  const party = state.parties[agent.partyId];
  agent.partyId = null;
  if (!party || party.dissolved) return {};

  const leftPartyId = party.id;
  party.memberIds = party.memberIds.filter((id) => id !== agent.id);

  if (party.memberIds.length === 0) {
    party.dissolved = true;
    party.dissolvedDay = state.day;
    party.endorsedCandidateId = null;
    return { leftPartyId, dissolvedPartyId: party.id };
  }

  if (party.leaderId === agent.id) {
    const remaining = party.memberIds
      .map((id) => state.agents[id])
      .filter((a): a is Agent => Boolean(a && a.alive))
      .sort((a, b) => {
        if (b.age !== a.age) return b.age - a.age;
        return a.numericId - b.numericId;
      });
    if (remaining[0]) {
      party.leaderId = remaining[0].id;
      return { leftPartyId, newLeaderId: remaining[0].id };
    }
  }

  return { leftPartyId };
}

export function foundParty(
  state: WorldState,
  agent: Agent,
  rawName: string,
  rawManifesto: string,
  config: SimConfig
): PartyActionResult {
  if (!agent.alive || agent.age < config.EDUCATION_DAYS) {
    return { succeeded: false, reason: "Only living adults can found a party" };
  }
  if (
    agent.lastPartyFoundedDay !== null &&
    state.day - agent.lastPartyFoundedDay < 7
  ) {
    return { succeeded: false, reason: "Party founding is limited to once every 7 days" };
  }

  const name = rawName.trim().slice(0, 40);
  const manifesto = rawManifesto.trim().slice(0, 400);
  if (!name) {
    return { succeeded: false, reason: "Party name cannot be empty" };
  }

  const duplicate = Object.values(state.parties).some(
    (p) => !p.dissolved && p.name.toLowerCase() === name.toLowerCase()
  );
  if (duplicate) {
    return { succeeded: false, reason: `Party name "${name}" already exists` };
  }

  // Leave current party if any
  if (agent.partyId) {
    removeAgentFromParty(state, agent);
  }

  const id = `pt${state.nextIds.party++}`;
  const party: Party = {
    id,
    name,
    manifesto,
    leaderId: agent.id,
    memberIds: [agent.id],
    foundedDay: state.day,
    endorsedCandidateId: null,
    dissolved: false,
    dissolvedDay: null,
  };
  state.parties[id] = party;
  agent.partyId = id;
  agent.lastPartyFoundedDay = state.day;

  return { succeeded: true, party };
}

export function joinParty(
  state: WorldState,
  agent: Agent,
  partyId: string,
  config: SimConfig
): PartyActionResult {
  if (!agent.alive || agent.age < config.EDUCATION_DAYS) {
    return { succeeded: false, reason: "Only living adults can join a party" };
  }
  const target = state.parties[partyId];
  if (!target || target.dissolved) {
    return { succeeded: false, reason: `Party ${partyId} not found or dissolved` };
  }
  if (agent.partyId === partyId) {
    return { succeeded: false, reason: "Already a member of this party" };
  }

  if (agent.partyId) {
    removeAgentFromParty(state, agent);
  }

  target.memberIds.push(agent.id);
  agent.partyId = target.id;
  return { succeeded: true, party: target };
}

export function endorseCandidate(
  state: WorldState,
  agent: Agent,
  candidateId: string,
  config: SimConfig
): { succeeded: boolean; party?: Party; reason?: string } {
  if (!agent.alive || agent.age < config.EDUCATION_DAYS) {
    return { succeeded: false, reason: "Only living adults can endorse" };
  }
  if (!agent.partyId) {
    return { succeeded: false, reason: "Agent is not in a party" };
  }
  const party = state.parties[agent.partyId];
  if (!party || party.dissolved) {
    return { succeeded: false, reason: "Party not found or dissolved" };
  }
  if (party.leaderId !== agent.id) {
    return { succeeded: false, reason: "Only the party leader can endorse a candidate" };
  }
  const candidate = state.agents[candidateId];
  if (!candidate || !candidate.alive) {
    return { succeeded: false, reason: `Candidate ${candidateId} not found or not alive` };
  }
  party.endorsedCandidateId = candidateId;
  return { succeeded: true, party };
}

export function getActivePartiesDirectory(state: WorldState): Party[] {
  return Object.values(state.parties)
    .filter((p) => !p.dissolved)
    .sort((a, b) => b.memberIds.length - a.memberIds.length);
}
