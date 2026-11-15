import type {
  Agent,
  CountryId,
  Nation,
  RegionId,
  SimConfig,
  WorldState,
} from "../../contracts/types.ts";
import type { AgentAction } from "../../contracts/schemas.ts";

export interface PresidentActionResult {
  succeeded: boolean;
  reason?: string;
  curriculumChanged?: { oldText: string; newText: string };
  regionCeded?: { regionId: RegionId; fromCountry: CountryId; toCountry: CountryId };
  decreeText?: string;
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ");
}

function nationToCountry(nation: Nation): CountryId {
  if (nation === "lyrians") return "lyria";
  if (nation === "skalians") return "skalia";
  return "ventriana";
}

function resolveRegionId(state: WorldState, rawRegion: string): RegionId | null {
  const trimmed = rawRegion.trim();
  if (state.regions[trimmed]) return trimmed;
  const lower = trimmed.toLowerCase();
  if (state.regions[lower]) return lower;
  for (const reg of Object.values(state.regions)) {
    if (reg.name.toLowerCase() === lower) return reg.id;
  }
  return null;
}

export function isPresidentAction(action: AgentAction): boolean {
  return (
    action.type === "set_curriculum" ||
    action.type === "set_border" ||
    action.type === "set_censorship" ||
    action.type === "set_voting_rights" ||
    action.type === "cede_region" ||
    action.type === "adopt_anthem" ||
    action.type === "decree"
  );
}

export function executePresidentAction(
  state: WorldState,
  agent: Agent,
  action: AgentAction,
  config: SimConfig
): PresidentActionResult {
  const region = state.regions[agent.region];
  if (!region) {
    return { succeeded: false, reason: "Invalid agent region" };
  }
  const country = state.countries[region.countryId];
  if (!country || !country.exists || country.presidentId !== agent.id) {
    return { succeeded: false, reason: "Agent is not president of their current country" };
  }
  if (country.decisionsLeft <= 0) {
    return { succeeded: false, reason: "No presidential decisions remaining this term" };
  }

  // Every presidential action counts against the budget, including no-ops (SPEC §10)
  country.decisionsLeft -= 1;

  switch (action.type) {
    case "set_curriculum": {
      const oldText = country.curriculumText;
      const newText = truncateWords(action.text, config.CURRICULUM_MAX_WORDS);
      country.curriculumText = newText;
      country.curriculumHistory.push({
        day: state.day,
        presidentId: agent.id,
        text: newText,
      });
      return {
        succeeded: true,
        curriculumChanged: { oldText, newText },
      };
    }

    case "set_border": {
      const regionId = resolveRegionId(state, action.region);
      const targetRegion = regionId ? state.regions[regionId] : undefined;
      if (!regionId || !targetRegion || targetRegion.countryId !== country.id) {
        return { succeeded: false, reason: `Region ${action.region} does not belong to ${country.name}` };
      }
      country.laws.borders[regionId] = action.blocked;
      return { succeeded: true };
    }

    case "set_censorship": {
      const muteAgents = action.mute_agents.slice(0, 5);
      const bannedPhrases = action.banned_phrases.slice(0, 5);
      country.laws.censorship = {
        muteAgents,
        bannedPhrases,
      };
      return { succeeded: true };
    }

    case "set_voting_rights": {
      if (!config.ALLOW_DISENFRANCHISEMENT && !action.allowed) {
        return { succeeded: false, reason: "Disenfranchisement is disabled by config" };
      }
      country.laws.votingRights[action.nation] = action.allowed;
      return { succeeded: true };
    }

    case "cede_region": {
      const regionId = resolveRegionId(state, action.region);
      const targetRegion = regionId ? state.regions[regionId] : undefined;
      if (!regionId || !targetRegion || targetRegion.countryId !== country.id) {
        return { succeeded: false, reason: `Region ${action.region} does not belong to ${country.name}` };
      }
      if (country.regions.length <= 1) {
        return { succeeded: false, reason: "Cannot cede the country's last remaining region" };
      }
      const destCountryId = nationToCountry(action.to_nation);
      if (destCountryId === country.id) {
        return { succeeded: false, reason: "Cannot cede a region to your own country" };
      }
      const destCountry = state.countries[destCountryId];
      // Transfer region
      country.regions = country.regions.filter((r) => r !== regionId);
      targetRegion.countryId = destCountryId;
      if (!destCountry.exists) {
        destCountry.exists = true;
        destCountry.curriculumText = state.archive;
        destCountry.curriculumHistory = [
          { day: state.day, presidentId: null, text: state.archive },
        ];
        destCountry.laws = {
          borders: {},
          censorship: { muteAgents: [], bannedPhrases: [] },
          votingRights: { lyrians: true, skalians: true, ventrians: true },
        };
      }
      if (!destCountry.regions.includes(regionId)) {
        destCountry.regions.push(regionId);
      }
      if (!destCountry.laws.borders[regionId]) {
        destCountry.laws.borders[regionId] = [];
      }
      delete country.laws.borders[regionId];

      return {
        succeeded: true,
        regionCeded: {
          regionId,
          fromCountry: country.id,
          toCountry: destCountryId,
        },
      };
    }

    case "adopt_anthem": {
      const workId = action.work_id.trim();
      const work =
        state.works.find((w) => w.id === workId) ??
        state.works.find((w) => w.id.toLowerCase() === workId.toLowerCase());
      if (!work) {
        return { succeeded: false, reason: `Work ${action.work_id} not found` };
      }
      country.anthemWorkId = work.id;
      return { succeeded: true };
    }

    case "decree": {
      return {
        succeeded: true,
        decreeText: action.text.trim(),
      };
    }

    default:
      return { succeeded: false, reason: "Not a presidential action" };
  }
}
