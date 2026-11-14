import React, { useMemo, useState } from "react";
import type { SimEvent } from "../../../contracts/events.ts";
import type { WorldState } from "../../../contracts/types.ts";

interface EventLogPanelProps {
  events: SimEvent[];
  state: WorldState;
  spyMode: boolean;
}

const ROW_HEIGHT = 44;
const VIEWPORT_HEIGHT = 360;

export const EventLogPanel: React.FC<EventLogPanelProps> = ({
  events,
  state,
  spyMode,
}) => {
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [searchText, setSearchText] = useState<string>("");
  const [scrollTop, setScrollTop] = useState(0);

  const eventTypes = useMemo(() => {
    const s = new Set<string>();
    for (const e of events) s.add(e.type);
    return Array.from(s).sort();
  }, [events]);

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return events
      .filter((e) => {
        if (!spyMode && (e.type === "private_thought" || e.type === "dm_sent")) {
          return false;
        }
        if (typeFilter !== "all" && e.type !== typeFilter) return false;
        if (actorFilter !== "all" && e.actor !== actorFilter) return false;
        if (q) {
          const hay = `${e.type} ${e.actor ?? ""} ${JSON.stringify(e.payload)}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .reverse();
  }, [events, spyMode, typeFilter, actorFilter, searchText]);

  const totalHeight = filtered.length * ROW_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + 8;
  const slice = filtered.slice(startIdx, startIdx + visibleCount);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-[#12161f] p-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
        <h3 className="text-sm font-semibold text-slate-100">
          Event log ({filtered.length})
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded border border-slate-700 bg-[#0b0e14] px-2 py-1 text-slate-200"
          >
            <option value="all">All types</option>
            {eventTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
            className="rounded border border-slate-700 bg-[#0b0e14] px-2 py-1 text-slate-200"
          >
            <option value="all">All citizens</option>
            {Object.values(state.agents).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Filter text or region..."
            className="rounded border border-slate-700 bg-[#0b0e14] px-2 py-1 text-slate-200 placeholder:text-slate-500"
          />
        </div>
      </div>

      <div
        className="relative overflow-y-auto rounded border border-slate-800 bg-[#0b0e14]"
        style={{ height: VIEWPORT_HEIGHT }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: totalHeight, position: "relative" }}>
          {slice.map((ev, i) => {
            const idx = startIdx + i;
            const actorName = ev.actor ? state.agents[ev.actor]?.name ?? ev.actor : "Engine";
            return (
              <div
                key={ev.id}
                style={{
                  position: "absolute",
                  top: idx * ROW_HEIGHT,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT,
                }}
                className="flex items-center justify-between gap-2 border-b border-slate-800/60 px-3"
              >
                <div className="truncate">
                  <span className="font-mono text-[11px] text-slate-500">
                    D{ev.day}·{ev.phase}
                  </span>{" "}
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
                    {ev.type}
                  </span>{" "}
                  <span className="font-medium text-slate-200">{actorName}</span>{" "}
                  <span className="text-slate-400">
                    {JSON.stringify(ev.payload).slice(0, 120)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
