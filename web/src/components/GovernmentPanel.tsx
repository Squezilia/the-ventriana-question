import React from "react";
import type { CountryId, WorldState } from "../../../contracts/types.ts";
import { COUNTRY_COLORS, NATION_COLORS } from "../types.ts";

interface GovernmentPanelProps {
  state: WorldState;
  onSelectAgent: (agentId: string) => void;
}

function computeWordDiff(oldText: string, newText: string): Array<{ type: "same" | "add" | "del"; word: string }> {
  const a = oldText.split(/\s+/).filter(Boolean);
  const b = newText.split(/\s+/).filter(Boolean);
  const setA = new Set(a);
  const setB = new Set(b);
  const out: Array<{ type: "same" | "add" | "del"; word: string }> = [];
  for (const w of a) {
    if (!setB.has(w)) out.push({ type: "del", word: w });
  }
  for (const w of b) {
    out.push({ type: setA.has(w) ? "same" : "add", word: w });
  }
  return out;
}

export const GovernmentPanel: React.FC<GovernmentPanelProps> = ({
  state,
  onSelectAgent,
}) => {
  const existingCountries = (["lyria", "skalia", "ventriana"] as CountryId[]).filter(
    (cid) => state.countries[cid].exists
  );

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-[#12161f] p-4 text-xs">
      <div className="border-b border-slate-800 pb-2">
        <h3 className="text-sm font-semibold text-slate-100">
          Governments, Laws & Curriculum Timeline
        </h3>
        <p className="text-slate-400">
          Presidential leadership, active border/censorship/voting laws, and history rewrites.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {existingCountries.map((cid) => {
          const c = state.countries[cid];
          const pres = c.presidentId ? state.agents[c.presidentId] : null;
          const anthem = c.anthemWorkId
            ? state.works.find((w) => w.id === c.anthemWorkId)
            : null;

          return (
            <div
              key={cid}
              className="flex flex-col gap-3 rounded border border-slate-800 bg-[#0b0e14] p-3"
            >
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                <span className={`text-sm font-semibold ${COUNTRY_COLORS[cid].text}`}>
                  {c.name} ({c.regions.length} regions)
                </span>
                <span className="text-slate-400">
                  Decisions left: <strong className="text-slate-200">{c.decisionsLeft}</strong>
                </span>
              </div>

              <div>
                <span className="text-slate-400">President: </span>
                {pres ? (
                  <button
                    onClick={() => onSelectAgent(pres.id)}
                    className={`font-semibold hover:underline ${NATION_COLORS[pres.nation].text}`}
                  >
                    {pres.name} ({pres.nation})
                  </button>
                ) : (
                  <span className="text-slate-500">Vacant</span>
                )}
              </div>

              {/* Laws */}
              <div className="space-y-1 rounded bg-slate-900/60 p-2">
                <div>
                  <span className="text-slate-400">Voting rights: </span>
                  {(["lyrians", "skalians", "ventrians"] as const).map((n) => (
                    <span
                      key={n}
                      className={`mr-2 ${
                        c.laws.votingRights[n] ? "text-emerald-400" : "text-rose-400 line-through"
                      }`}
                    >
                      {n}
                    </span>
                  ))}
                </div>
                <div>
                  <span className="text-slate-400">Censorship: </span>
                  {c.laws.censorship.muteAgents.length === 0 &&
                  c.laws.censorship.bannedPhrases.length === 0 ? (
                    <span className="text-slate-500">None</span>
                  ) : (
                    <span className="text-rose-300">
                      Muted: [{c.laws.censorship.muteAgents.join(", ")}] · Phrases: [
                      {c.laws.censorship.bannedPhrases.join(", ")}]
                    </span>
                  )}
                </div>
                <div>
                  <span className="text-slate-400">Borders: </span>
                  {Object.entries(c.laws.borders)
                    .filter(([, rule]) => rule === "all" || (Array.isArray(rule) && rule.length > 0))
                    .map(([rid, rule]) => `${state.regions[rid]?.name ?? rid}: ${Array.isArray(rule) ? rule.join(",") : rule}`)
                    .join(" | ") || <span className="text-slate-500">All open</span>}
                </div>
                {anthem && (
                  <div>
                    <span className="text-slate-400">Anthem: </span>
                    <span className="italic text-slate-200">"{anthem.text}"</span>
                  </div>
                )}
              </div>

              {/* Curriculum Timeline */}
              <div>
                <h4 className="mb-1.5 font-medium text-slate-300">
                  Curriculum timeline ({c.curriculumHistory.length} versions)
                </h4>
                <div className="max-h-56 space-y-2 overflow-y-auto">
                  {c.curriculumHistory.map((ver, idx) => {
                    const prev = idx > 0 ? c.curriculumHistory[idx - 1] : null;
                    const author = ver.presidentId ? state.agents[ver.presidentId]?.name : "Archive";
                    const diff = prev ? computeWordDiff(prev.text, ver.text) : null;
                    return (
                      <div
                        key={idx}
                        className="rounded border border-slate-800 bg-[#12161f] p-2"
                      >
                        <div className="mb-1 text-[11px] text-slate-400">
                          Day {ver.day} · Author: <strong className="text-slate-200">{author}</strong>
                        </div>
                        {!diff ? (
                          <p className="leading-relaxed text-slate-300">{ver.text}</p>
                        ) : (
                          <p className="leading-relaxed">
                            {diff.map((tok, ti) => (
                              <span
                                key={ti}
                                className={
                                  tok.type === "add"
                                    ? "bg-emerald-500/20 text-emerald-300 px-0.5 rounded"
                                    : tok.type === "del"
                                    ? "bg-rose-500/20 text-rose-300 line-through px-0.5 rounded"
                                    : "text-slate-300"
                                }
                              >
                                {tok.word}{" "}
                              </span>
                            ))}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
