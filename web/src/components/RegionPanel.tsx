import React from "react";
import type { RegionId, WorldState } from "../../../contracts/types.ts";
import { COUNTRY_COLORS, NATION_COLORS } from "../types.ts";

interface RegionPanelProps {
  state: WorldState;
  regionId: RegionId | null;
  onSelectAgent: (agentId: string) => void;
}

export const RegionPanel: React.FC<RegionPanelProps> = ({
  state,
  regionId,
  onSelectAgent,
}) => {
  const region = regionId ? state.regions[regionId] : null;
  if (!region) {
    return (
      <div className="rounded-lg border border-slate-800 bg-[#12161f] p-4 text-sm text-slate-400">
        Select a region on the map to view its roster, local chat, and news.
      </div>
    );
  }

  const country = state.countries[region.countryId];
  const occupants = Object.values(state.agents)
    .filter((a) => a.alive && a.region === region.id)
    .sort((a, b) => b.age - a.age);

  const todayChat = state.localChat.filter(
    (c) => c.regionId === region.id && c.day === state.day
  );
  const regionNews = state.news
    .filter((n) => n.scope === "region" && n.targetId === region.id)
    .slice(-15)
    .reverse();

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-[#12161f] p-4">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div>
          <h3 className="text-base font-semibold text-slate-100">
            {region.name}
          </h3>
          <p className="text-xs text-slate-400">
            Country:{" "}
            <span className={COUNTRY_COLORS[region.countryId].text}>
              {country.name}
            </span>
            {region.formerVentriana ? " · Former Ventriana" : ""}
            {region.isCapital ? " · Former Capital" : ""}
          </p>
        </div>
        <span className="rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-xs text-slate-300">
          {occupants.length} residents
        </span>
      </div>

      {/* Roster */}
      <div>
        <h4 className="mb-1.5 text-xs font-medium text-slate-400">Roster</h4>
        <div className="flex flex-wrap gap-1.5">
          {occupants.map((a) => {
            const isPres = country.presidentId === a.id;
            return (
              <button
                key={a.id}
                onClick={() => onSelectAgent(a.id)}
                className={`rounded border px-2 py-1 text-xs transition hover:brightness-125 ${NATION_COLORS[a.nation].badge}`}
              >
                {a.name} ({a.age}d{isPres ? ", Pres" : ""})
              </button>
            );
          })}
          {occupants.length === 0 && (
            <span className="text-xs text-slate-500">No living residents.</span>
          )}
        </div>
      </div>

      {/* Local Chat */}
      <div>
        <h4 className="mb-1.5 text-xs font-medium text-slate-400">
          Local chat (Day {state.day})
        </h4>
        <div className="max-h-52 space-y-1.5 overflow-y-auto rounded border border-slate-800 bg-[#0b0e14] p-2.5 text-xs">
          {todayChat.length === 0 ? (
            <p className="text-slate-500">No local chat recorded today.</p>
          ) : (
            todayChat.map((c, idx) => (
              <div key={idx} className="leading-relaxed">
                <span className="text-slate-500">[R{c.round}] </span>
                <button
                  onClick={() => onSelectAgent(c.agentId)}
                  className={`font-medium hover:underline ${NATION_COLORS[c.nation].text}`}
                >
                  {c.agentName}
                </button>
                <span className="text-slate-300">: {c.text}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Region News */}
      <div>
        <h4 className="mb-1.5 text-xs font-medium text-slate-400">
          Recent region news
        </h4>
        <div className="max-h-36 space-y-1 overflow-y-auto text-xs text-slate-300">
          {regionNews.length === 0 ? (
            <p className="text-slate-500">No region news yet.</p>
          ) : (
            regionNews.map((n) => (
              <div key={n.id} className="border-l-2 border-slate-700 pl-2">
                <span className="text-slate-500">Day {n.day}: </span>
                {n.text}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
