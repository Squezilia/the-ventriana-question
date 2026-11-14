import React from "react";
import type { CountryId, WorldState } from "../../../contracts/types.ts";
import { COUNTRY_COLORS, NATION_COLORS } from "../types.ts";

interface ElectionsPanelProps {
  state: WorldState;
  onSelectAgent: (agentId: string) => void;
}

export const ElectionsPanel: React.FC<ElectionsPanelProps> = ({
  state,
  onSelectAgent,
}) => {
  const existingCountries = (["lyria", "skalia", "ventriana"] as CountryId[]).filter(
    (cid) => state.countries[cid].exists
  );

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-[#12161f] p-4 text-xs">
      <div className="border-b border-slate-800 pb-2">
        <h3 className="text-sm font-semibold text-slate-100">Elections</h3>
        <p className="text-slate-400">
          Frozen candidate slates, regional plurality results, and election history.
        </p>
      </div>

      {/* Frozen / Upcoming Candidates */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {existingCountries.map((cid) => {
          const country = state.countries[cid];
          return (
            <div
              key={cid}
              className="rounded border border-slate-800 bg-[#0b0e14] p-2.5"
            >
              <div className={`mb-1.5 font-semibold ${COUNTRY_COLORS[cid].text}`}>
                {country.name} — Candidates
              </div>
              {country.frozenCandidates.length === 0 ? (
                <p className="text-slate-500">None frozen.</p>
              ) : (
                <ul className="space-y-1">
                  {country.frozenCandidates.map((candId) => {
                    const a = state.agents[candId];
                    if (!a) return null;
                    return (
                      <li key={candId} className="flex items-center justify-between">
                        <button
                          onClick={() => onSelectAgent(a.id)}
                          className={`hover:underline ${NATION_COLORS[a.nation].text}`}
                        >
                          {a.name} ({a.age}d)
                        </button>
                        <span className="text-slate-500">{a.nation}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* Election History */}
      <div>
        <h4 className="mb-2 font-medium text-slate-300">
          Election history ({state.elections.length})
        </h4>
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {state.elections.length === 0 ? (
            <p className="text-slate-500">No elections completed yet.</p>
          ) : (
            [...state.elections].reverse().map((el, idx) => {
              const winner = el.winnerId ? state.agents[el.winnerId] : null;
              return (
                <div
                  key={idx}
                  className="rounded border border-slate-800 bg-[#0b0e14] p-2.5"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className={`font-semibold ${COUNTRY_COLORS[el.countryId].text}`}>
                      Day {el.day} · {state.countries[el.countryId].name}
                    </span>
                    <span className="text-slate-200">
                      Winner:{" "}
                      {winner ? (
                        <button
                          onClick={() => onSelectAgent(winner.id)}
                          className="font-semibold underline"
                        >
                          {winner.name}
                        </button>
                      ) : (
                        "None"
                      )}
                      {el.actingPresident ? " (acting)" : ""}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-slate-400">
                    {Object.entries(el.regionResults).map(([rid, rr]) => {
                      const rw = rr.winnerId ? state.agents[rr.winnerId]?.name : "Undecided";
                      return (
                        <span key={rid} className="rounded bg-slate-900 px-1.5 py-0.5">
                          {state.regions[rid]?.name ?? rid}: {rw}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
