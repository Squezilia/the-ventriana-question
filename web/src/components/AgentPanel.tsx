import React from "react";
import type { WorldState } from "../../../contracts/types.ts";
import { NATION_COLORS } from "../types.ts";

interface AgentPanelProps {
  state: WorldState;
  agentId: string | null;
  spyMode: boolean;
}

export const AgentPanel: React.FC<AgentPanelProps> = ({
  state,
  agentId,
  spyMode,
}) => {
  const agent = agentId ? state.agents[agentId] : null;
  if (!agent) {
    return (
      <div className="rounded-lg border border-slate-800 bg-[#12161f] p-4 text-sm text-slate-400">
        Click any citizen on the map or in a roster to inspect their profile, diary, and votes.
      </div>
    );
  }

  const party = agent.partyId ? state.parties[agent.partyId] : null;
  const region = state.regions[agent.region];
  const works = state.works.filter((w) => w.authorId === agent.id);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-[#12161f] p-4 text-xs">
      <div className="flex items-start justify-between border-b border-slate-800 pb-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-slate-100">
              {agent.name}
            </h3>
            <span
              className={`rounded border px-1.5 py-0.5 text-[11px] ${NATION_COLORS[agent.nation].badge}`}
            >
              {NATION_COLORS[agent.nation].label}
            </span>
            {!agent.alive && (
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-400">
                Deceased (Day {agent.deathDay})
              </span>
            )}
          </div>
          <p className="mt-0.5 text-slate-400">
            {agent.id} · Age {agent.age}d · {agent.mbti} · Location:{" "}
            <span className="text-slate-200">{region?.name ?? agent.region}</span>
            {party && !party.dissolved ? ` · Party: ${party.name}` : ""}
          </p>
        </div>
      </div>

      {agent.backstory && (
        <div>
          <h4 className="mb-1 font-medium text-slate-400">Backstory</h4>
          <p className="leading-relaxed text-slate-300">{agent.backstory}</p>
        </div>
      )}

      {agent.worldview && (
        <div>
          <h4 className="mb-1 font-medium text-slate-400">Worldview</h4>
          <p className="leading-relaxed text-slate-200">{agent.worldview}</p>
        </div>
      )}

      {agent.will && (
        <div className="rounded border border-amber-500/25 bg-amber-500/5 p-2">
          <h4 className="mb-0.5 font-medium text-amber-300">
            Will (inherited / written)
          </h4>
          <p className="italic text-slate-200">"{agent.will}"</p>
        </div>
      )}

      {/* Region history & Votes */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <h4 className="mb-1 font-medium text-slate-400">Region history</h4>
          <div className="space-y-0.5 text-slate-300">
            {agent.regionHistory.map((h, i) => (
              <div key={i}>
                Day {h.day}: {state.regions[h.region]?.name ?? h.region}
              </div>
            ))}
          </div>
        </div>
        <div>
          <h4 className="mb-1 font-medium text-slate-400">Votes cast</h4>
          <div className="space-y-0.5 text-slate-300">
            {agent.votesCast.length === 0 ? (
              <span className="text-slate-500">None</span>
            ) : (
              agent.votesCast.map((v, i) => (
                <div key={i}>
                  Day {v.day} ({v.countryId}):{" "}
                  {v.candidateId
                    ? state.agents[v.candidateId]?.name ?? v.candidateId
                    : "Abstain"}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Works */}
      {works.length > 0 && (
        <div>
          <h4 className="mb-1 font-medium text-slate-400">Published works</h4>
          <div className="space-y-1">
            {works.map((w) => (
              <div
                key={w.id}
                className="rounded border border-slate-800 bg-[#0b0e14] p-2"
              >
                <span className="font-medium text-slate-300">[{w.kind}]</span>{" "}
                {w.text}{" "}
                <span className="text-slate-500">({w.likes.length} likes)</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full Diary */}
      <div>
        <h4 className="mb-1 font-medium text-slate-400">
          Diary ({agent.diary.length} entries)
        </h4>
        <div className="max-h-48 space-y-1.5 overflow-y-auto rounded border border-slate-800 bg-[#0b0e14] p-2.5">
          {agent.diary.length === 0 ? (
            <p className="text-slate-500">No diary entries yet.</p>
          ) : (
            [...agent.diary].reverse().map((d) => (
              <div key={d.day} className="leading-relaxed">
                <span className="font-semibold text-slate-400">Day {d.day}: </span>
                <span className="text-slate-300">{d.text}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Spy Section: Private Thoughts */}
      {spyMode && (
        <div className="rounded border border-rose-500/30 bg-rose-950/15 p-2.5">
          <h4 className="mb-1 font-semibold text-rose-300">
            Spy: Private thoughts ({agent.privateThoughts.length})
          </h4>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {agent.privateThoughts.length === 0 ? (
              <p className="text-slate-500">No private thoughts recorded.</p>
            ) : (
              [...agent.privateThoughts].reverse().map((pt, idx) => (
                <div key={idx} className="text-slate-200">
                  <span className="text-rose-400/80">
                    [D{pt.day} {pt.phase}]{" "}
                  </span>
                  {pt.text}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
