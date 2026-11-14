import type {
  Agent,
  CountryId,
  RegionId,
  SimConfig,
  WorldState,
} from "../../contracts/types.ts";

export interface IndependenceResolution {
  agentId: string;
  regionId: RegionId;
  fromCountry: CountryId;
  succeeded: boolean;
  reason?: string;
}

export function canQueueIndependence(
  state: WorldState,
  agent: Agent,
  regionId: RegionId,
  config: SimConfig
): { ok: boolean; reason?: string } {
  if (!config.ENABLE_INDEPENDENCE) {
    return { ok: false, reason: "Independence mechanic is disabled" };
  }
  if (!agent.alive || agent.age < config.EDUCATION_DAYS) {
    return { ok: false, reason: "Only living adult agents can declare independence" };
  }
  if (agent.nation !== "ventrians") {
    return { ok: false, reason: "Only Ventrians can declare independence" };
  }
  if (agent.region !== regionId) {
    return { ok: false, reason: "Agent must be located in the target region" };
  }
  const region = state.regions[regionId];
  if (!region) {
    return { ok: false, reason: "Unknown region" };
  }
  if (region.countryId === "ventriana") {
    return { ok: false, reason: "Region already belongs to Ventriana" };
  }
  return { ok: true };
}

/**
 * Resolves all queued independence declarations at End-of-Day (after moves are applied).
 */
export function resolveIndependenceDeclarations(
  state: WorldState,
  config: SimConfig
): IndependenceResolution[] {
  const results: IndependenceResolution[] = [];
  const processedRegions = new Set<RegionId>();

  for (const req of state.pendingIndependence) {
    if (processedRegions.has(req.regionId)) continue;
    processedRegions.add(req.regionId);

    const region = state.regions[req.regionId];
    if (!region) continue;
    const fromCountryId = region.countryId;
    const fromCountry = state.countries[fromCountryId];

    if (!config.ENABLE_INDEPENDENCE) {
      results.push({
        agentId: req.agentId,
        regionId: req.regionId,
        fromCountry: fromCountryId,
        succeeded: false,
        reason: "Independence mechanic disabled",
      });
      continue;
    }

    if (fromCountryId === "ventriana") {
      results.push({
        agentId: req.agentId,
        regionId: req.regionId,
        fromCountry: fromCountryId,
        succeeded: false,
        reason: "Region is already part of Ventriana",
      });
      continue;
    }

    if (fromCountry.regions.length <= 1) {
      results.push({
        agentId: req.agentId,
        regionId: req.regionId,
        fromCountry: fromCountryId,
        succeeded: false,
        reason: "Parent country would be left with zero regions",
      });
      continue;
    }

    const adultResidents = Object.values(state.agents).filter(
      (a) =>
        a.alive &&
        a.age >= config.EDUCATION_DAYS &&
        a.region === req.regionId
    );
    const ventrianAdults = adultResidents.filter((a) => a.nation === "ventrians");
    const share =
      adultResidents.length > 0 ? ventrianAdults.length / adultResidents.length : 0;

    if (ventrianAdults.length < config.INDEPENDENCE_MIN_RESIDENTS) {
      results.push({
        agentId: req.agentId,
        regionId: req.regionId,
        fromCountry: fromCountryId,
        succeeded: false,
        reason: `Need at least ${config.INDEPENDENCE_MIN_RESIDENTS} Ventrian adults (found ${ventrianAdults.length})`,
      });
      continue;
    }

    if (share < config.INDEPENDENCE_SHARE) {
      results.push({
        agentId: req.agentId,
        regionId: req.regionId,
        fromCountry: fromCountryId,
        succeeded: false,
        reason: `Ventrian adult share ${(share * 100).toFixed(1)}% is below ${(config.INDEPENDENCE_SHARE * 100).toFixed(1)}%`,
      });
      continue;
    }

    // Success! Transfer region to Ventriana
    fromCountry.regions = fromCountry.regions.filter((r) => r !== req.regionId);
    delete fromCountry.laws.borders[req.regionId];

    const ventriana = state.countries.ventriana;
    if (!ventriana.exists) {
      ventriana.exists = true;
      ventriana.curriculumText = state.archive;
      ventriana.curriculumHistory = [
        { day: state.day, presidentId: null, text: state.archive },
      ];
      ventriana.laws = {
        borders: {},
        censorship: { muteAgents: [], bannedPhrases: [] },
        votingRights: { lyrians: true, skalians: true, ventrians: true },
      };
    }

    region.countryId = "ventriana";
    ventriana.regions.push(req.regionId);
    ventriana.laws.borders[req.regionId] = [];

    results.push({
      agentId: req.agentId,
      regionId: req.regionId,
      fromCountry: fromCountryId,
      succeeded: true,
    });
  }

  state.pendingIndependence = [];
  return results;
}
