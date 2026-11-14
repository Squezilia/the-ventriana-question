import React from "react";
import type { CountryId, WorldState } from "../../../contracts/types.ts";
import { COUNTRY_COLORS, NATION_COLORS } from "../types.ts";

interface CulturePanelProps {
  state: WorldState;
  onSelectAgent: (agentId: string) => void;
}

export const CulturePanel: React.FC<CulturePanelProps> = ({
  state,
  onSelectAgent,
}) => {
  const hall = [...state.works].sort((a, b) => {
    if (b.likes.length !== a.likes.length) return b.likes.length - a.likes.length;
    return b.day - a.day;
  });

  const anthems = (["lyria", "skalia", "ventriana"] as CountryId[])
    .filter((cid) => state.countries[cid].exists && state.countries[cid].anthemWorkId)
    .map((cid) => ({
      country: state.countries[cid],
      work: state.works.find((w) => w.id === state.countries[cid].anthemWorkId),
    }))
    .filter((x) => Boolean(x.work));

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-[#12161f] p-4 text-xs">
      <div className="border-b border-slate-800 pb-2">
        <h3 className="text-sm font-semibold text-slate-100">
          Culture Hall of Fame
        </h3>
        <p className="text-slate-400">
          Poems, songs, memes, slogans, and adopted national anthems.
        </p>
      </div>

      {anthems.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-medium text-slate-300">Adopted Anthems</h4>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {anthems.map(({ country, work }) => (
              <div
                key={country.id}
                className="rounded border border-amber-500/30 bg-amber-500/5 p-2.5"
              >
                <div className={`mb-1 font-semibold ${COUNTRY_COLORS[country.id].text}`}>
                  {country.name} Anthem
                </div>
                <p className="italic text-slate-200">"{work!.text}"</p>
                <div className="mt-1 text-[11px] text-slate-400">
                  by {work!.authorName} · ♥ {work!.likes.length}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="max-h-72 space-y-2 overflow-y-auto">
        {hall.length === 0 ? (
          <p className="text-slate-500">No cultural works published yet.</p>
        ) : (
          hall.map((w, idx) => (
            <div
              key={w.id}
              className="rounded border border-slate-800 bg-[#0b0e14] p-2.5"
            >
              <div className="mb-1 flex items-center justify-between">
                <div>
                  <span className="mr-1.5 text-slate-500">#{idx + 1}</span>
                  <button
                    onClick={() => onSelectAgent(w.authorId)}
                    className={`font-semibold hover:underline ${NATION_COLORS[w.authorNation].text}`}
                  >
                    {w.authorName}
                  </button>
                  <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                    {w.kind}
                  </span>
                  <span className="ml-2 text-slate-500">Day {w.day}</span>
                </div>
                <span className="font-medium text-rose-300">♥ {w.likes.length}</span>
              </div>
              <p className="text-slate-200">{w.text}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
