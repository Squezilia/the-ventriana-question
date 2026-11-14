import type { SimEvent } from "../../contracts/events.ts";
import type { RunHealthStats } from "../../contracts/stream.ts";
import type {
  CountryId,
  DailyMetricsRow,
  Nation,
  RunMetadata,
  WorldState,
} from "../../contracts/types.ts";

export interface EmbeddedReplayPayload {
  mode: "static";
  metadata: RunMetadata;
  snapshots: Record<number, WorldState>;
  events: SimEvent[];
  stats: DailyMetricsRow[];
  noPrivate?: boolean;
}

declare global {
  interface Window {
    __VENTRIANA_REPLAY_DATA__?: EmbeddedReplayPayload;
  }
}

export const NATION_COLORS: Record<
  Nation,
  { fill: string; border: string; text: string; badge: string; label: string }
> = {
  lyrians: {
    fill: "#38bdf8",
    border: "#0284c7",
    text: "text-sky-300",
    badge: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    label: "Lyrian",
  },
  skalians: {
    fill: "#f59e0b",
    border: "#d97706",
    text: "text-amber-300",
    badge: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    label: "Skalian",
  },
  ventrians: {
    fill: "#fb7185",
    border: "#e11d48",
    text: "text-rose-300",
    badge: "bg-rose-500/20 text-rose-300 border-rose-500/40",
    label: "Ventrian",
  },
};

export const COUNTRY_COLORS: Record<
  CountryId,
  { bg: string; stroke: string; text: string; label: string }
> = {
  lyria: {
    bg: "#102333",
    stroke: "#2563eb",
    text: "text-sky-300",
    label: "Lyria",
  },
  skalia: {
    bg: "#261d10",
    stroke: "#d97706",
    text: "text-amber-300",
    label: "Skalia",
  },
  ventriana: {
    bg: "#2e121b",
    stroke: "#e11d48",
    text: "text-rose-300",
    label: "Ventriana",
  },
};
