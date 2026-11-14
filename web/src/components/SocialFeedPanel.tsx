import React, { useState } from "react";
import type { WorldState } from "../../../contracts/types.ts";
import { NATION_COLORS } from "../types.ts";

interface SocialFeedPanelProps {
  state: WorldState;
  spyMode: boolean;
  onSelectAgent: (agentId: string) => void;
}

export const SocialFeedPanel: React.FC<SocialFeedPanelProps> = ({
  state,
  spyMode,
  onSelectAgent,
}) => {
  const [tab, setTab] = useState<"feed" | "dms">("feed");

  const posts = [...state.posts].reverse().slice(0, 100);
  const dms = [...state.dms].reverse().slice(0, 100);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-[#12161f] p-4">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTab("feed")}
            className={`rounded px-2.5 py-1 text-xs font-medium ${
              tab === "feed"
                ? "bg-slate-800 text-slate-100"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Public feed ({state.posts.length})
          </button>
          {spyMode && (
            <button
              onClick={() => setTab("dms")}
              className={`rounded px-2.5 py-1 text-xs font-medium ${
                tab === "dms"
                  ? "bg-rose-950/60 text-rose-200 border border-rose-500/30"
                  : "text-rose-400 hover:text-rose-200"
              }`}
            >
              Spy: DMs ({state.dms.length})
            </button>
          )}
        </div>
      </div>

      <div className="max-h-96 space-y-2 overflow-y-auto pr-1 text-xs">
        {tab === "feed" &&
          (posts.length === 0 ? (
            <p className="text-slate-500">No public posts yet.</p>
          ) : (
            posts.map((p) => (
              <div
                key={p.id}
                className={`rounded border p-2.5 ${
                  p.censored
                    ? "border-rose-900/50 bg-rose-950/20 opacity-80"
                    : "border-slate-800 bg-[#0b0e14]"
                }`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => onSelectAgent(p.authorId)}
                      className={`font-semibold hover:underline ${NATION_COLORS[p.authorNation].text}`}
                    >
                      {p.authorName}
                    </button>
                    <span className="text-slate-500">
                      · Day {p.day} · {p.id}
                    </span>
                    {p.replyToId && (
                      <span className="text-slate-400">
                        (reply to {p.replyToId})
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {p.censored && (
                      <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-medium text-rose-300">
                        CENSORED ({p.censoredByCountry})
                      </span>
                    )}
                    <span className="text-slate-400">
                      ♥ {p.likes.length}
                    </span>
                  </div>
                </div>
                <p className="text-slate-200">{p.text}</p>
              </div>
            ))
          ))}

        {tab === "dms" &&
          spyMode &&
          (dms.length === 0 ? (
            <p className="text-slate-500">No direct messages sent yet.</p>
          ) : (
            dms.map((d) => (
              <div
                key={d.id}
                className="rounded border border-rose-500/25 bg-rose-950/15 p-2.5"
              >
                <div className="mb-1 flex items-center justify-between text-rose-200">
                  <span>
                    <button
                      onClick={() => onSelectAgent(d.fromId)}
                      className="font-semibold hover:underline"
                    >
                      {d.fromName}
                    </button>{" "}
                    to{" "}
                    <button
                      onClick={() => onSelectAgent(d.toId)}
                      className="font-semibold hover:underline"
                    >
                      {d.toName}
                    </button>
                  </span>
                  <span className="text-slate-400">Day {d.day}</span>
                </div>
                <p className="text-slate-200">{d.text}</p>
              </div>
            ))
          ))}
      </div>
    </div>
  );
};
