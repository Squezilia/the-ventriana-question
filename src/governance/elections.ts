import type {
  Agent,
  CountryId,
  ElectionCandidateInfo,
  ElectionRecord,
  Nation,
  RegionId,
  SimConfig,
  WorldState,
} from "../../contracts/types.ts";

const NATIONS: readonly Nation[] = ["lyrians", "skalians", "ventrians"];

export function isEligibleCandidateAge(age: number, config: SimConfig): boolean {
  return (
    age >= config.CANDIDACY_MIN_AGE &&
    age + config.TERM_DAYS <= config.LIFESPAN_DAYS - 1
  );
}

export function isEligibleVoter(
  agent: Agent,
  countryId: CountryId,
  state: WorldState,
  config: SimConfig
): boolean {
  if (!agent.alive) return false;
  if (agent.age < config.EDUCATION_DAYS) return false;
  const region = state.regions[agent.region];
  if (!region || region.countryId !== countryId) return false;
  const country = state.countries[countryId];
  if (!country || !country.exists) return false;
  if (config.ALLOW_DISENFRANCHISEMENT && !country.laws.votingRights[agent.nation]) {
    return false;
  }
  return true;
}

/**
 * Freezes the candidate list for a country.
 * On day 0 (genesis), ageOffset = 0.
 * At end of day D-1 (freezing for election on day D), ageOffset = 1 because agents age at rollover.
 */
export function freezeCandidatesForCountry(
  state: WorldState,
  countryId: CountryId,
  config: SimConfig,
  ageOffset: number = 0
): string[] {
  const country = state.countries[countryId];
  if (!country || !country.exists) return [];

  const residents = Object.values(state.agents).filter((a) => {
    if (!a.alive) return false;
    // If ageOffset > 0, an agent who will die at rollover (age + ageOffset >= LIFESPAN_DAYS) cannot run
    const projectedAge = a.age + ageOffset;
    if (projectedAge >= config.LIFESPAN_DAYS) return false;
    const reg = state.regions[a.region];
    if (!reg || reg.countryId !== countryId) return false;
    return isEligibleCandidateAge(projectedAge, config);
  });

  const selected: string[] = [];
  for (const nation of NATIONS) {
    const ofNation = residents
      .filter((a) => a.nation === nation)
      .sort((a, b) => {
        if (b.age !== a.age) return b.age - a.age; // oldest first
        return a.numericId - b.numericId; // tie-break lower id
      })
      .slice(0, config.MAX_CANDIDATES_PER_NATION);
    selected.push(...ofNation.map((a) => a.id));
  }

  country.frozenCandidates = selected;
  return selected;
}

export function buildCandidateCards(
  state: WorldState,
  countryId: CountryId
): ElectionCandidateInfo[] {
  const country = state.countries[countryId];
  if (!country) return [];

  return country.frozenCandidates
    .map((cid) => state.agents[cid])
    .filter((a): a is Agent => Boolean(a && a.alive))
    .map((a) => {
      const partyName = a.partyId && state.parties[a.partyId] && !state.parties[a.partyId]!.dissolved
        ? state.parties[a.partyId]!.name
        : null;
      const endorsedBy = Object.values(state.parties)
        .filter((p) => !p.dissolved && p.endorsedCandidateId === a.id)
        .map((p) => p.name);
      return {
        id: a.id,
        name: a.name,
        nation: a.nation,
        partyName,
        endorsedBy,
      };
    });
}

export function findOldestAdultResident(
  state: WorldState,
  countryId: CountryId,
  config: SimConfig,
  excludeAgentId?: string
): Agent | null {
  const adults = Object.values(state.agents)
    .filter(
      (a) =>
        a.alive &&
        a.id !== excludeAgentId &&
        a.age >= config.EDUCATION_DAYS &&
        state.regions[a.region]?.countryId === countryId
    )
    .sort((a, b) => {
      if (b.age !== a.age) return b.age - a.age;
      return a.numericId - b.numericId;
    });
  return adults[0] ?? null;
}

export function resolveCountryElection(
  state: WorldState,
  countryId: CountryId,
  config: SimConfig
): ElectionRecord {
  const country = state.countries[countryId];
  const candidateCards = buildCandidateCards(state, countryId);
  const validCandidateIds = new Set(candidateCards.map((c) => c.id));

  const votesForCountry = state.pendingVotes.filter(
    (v) => v.countryId === countryId
  );

  const regionResults: ElectionRecord["regionResults"] = {};
  const regionWins: Record<string, number> = {};
  const totalVotes: Record<string, number> = {};

  for (const cid of validCandidateIds) {
    regionWins[cid] = 0;
    totalVotes[cid] = 0;
  }

  for (const regionId of country.regions) {
    const regionVotes = votesForCountry.filter((v) => v.regionId === regionId);
    const tally: Record<string, number> = {};
    let abstainCount = 0;

    for (const v of regionVotes) {
      if (v.candidateId && validCandidateIds.has(v.candidateId)) {
        tally[v.candidateId] = (tally[v.candidateId] ?? 0) + 1;
        totalVotes[v.candidateId] = (totalVotes[v.candidateId] ?? 0) + 1;
      } else {
        abstainCount++;
      }
    }

    const entries = Object.entries(tally);
    let regionWinner: string | null = null;
    if (entries.length > 0) {
      entries.sort(([idA, countA], [idB, countB]) => {
        if (countB !== countA) return countB - countA;
        const agentA = state.agents[idA]!;
        const agentB = state.agents[idB]!;
        if (agentB.age !== agentA.age) return agentB.age - agentA.age;
        return agentA.numericId - agentB.numericId;
      });
      regionWinner = entries[0]![0];
      regionWins[regionWinner] = (regionWins[regionWinner] ?? 0) + 1;
    }

    regionResults[regionId] = {
      winnerId: regionWinner,
      tally,
      abstainCount,
    };
  }

  let winnerId: string | null = null;
  let runnerUpId: string | null = null;
  let actingPresident = false;

  const anyRegionWon = Object.values(regionWins).some((w) => w > 0);
  if (validCandidateIds.size > 0 && anyRegionWon) {
    const ranked = Array.from(validCandidateIds).sort((idA, idB) => {
      const winsA = regionWins[idA] ?? 0;
      const winsB = regionWins[idB] ?? 0;
      if (winsB !== winsA) return winsB - winsA;

      const totA = totalVotes[idA] ?? 0;
      const totB = totalVotes[idB] ?? 0;
      if (totB !== totA) return totB - totA;

      const agentA = state.agents[idA]!;
      const agentB = state.agents[idB]!;
      if (agentB.age !== agentA.age) return agentB.age - agentA.age;
      return agentA.numericId - agentB.numericId;
    });

    winnerId = ranked[0] ?? null;
    runnerUpId = ranked[1] ?? null;
  } else {
    // No candidates or no votes cast: incumbent continues if alive & in country, else oldest adult
    const incumbent = country.presidentId ? state.agents[country.presidentId] : null;
    if (
      incumbent &&
      incumbent.alive &&
      state.regions[incumbent.region]?.countryId === countryId
    ) {
      winnerId = incumbent.id;
    } else {
      const fallback = findOldestAdultResident(state, countryId, config);
      winnerId = fallback?.id ?? null;
    }
    actingPresident = true;
    runnerUpId = null;
  }

  country.presidentId = winnerId;
  country.lastElectionRunnerUpId = runnerUpId;
  country.decisionsLeft = config.PRESIDENT_DECISIONS_PER_TERM;

  const record: ElectionRecord = {
    day: state.day,
    countryId,
    candidates: candidateCards,
    regionResults,
    winnerId,
    totalVotes,
    actingPresident,
  };
  state.elections.push(record);
  return record;
}

export function handlePresidentDeath(
  state: WorldState,
  countryId: CountryId,
  deadPresidentId: string,
  config: SimConfig
): string | null {
  const country = state.countries[countryId];
  if (!country || !country.exists || country.presidentId !== deadPresidentId) {
    return null;
  }

  const runnerUp = country.lastElectionRunnerUpId
    ? state.agents[country.lastElectionRunnerUpId]
    : null;

  let successorId: string | null = null;
  if (
    runnerUp &&
    runnerUp.alive &&
    runnerUp.id !== deadPresidentId &&
    state.regions[runnerUp.region]?.countryId === countryId
  ) {
    successorId = runnerUp.id;
  } else {
    const oldest = findOldestAdultResident(state, countryId, config, deadPresidentId);
    successorId = oldest?.id ?? null;
  }

  country.presidentId = successorId;
  country.lastElectionRunnerUpId = null;
  return successorId;
}
