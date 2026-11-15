import React, { useMemo, useState } from "react";
import type { WorldState } from "../../../contracts/types.ts";
import { NATION_COLORS } from "../types.ts";

interface SocialFeedPanelProps {
  state: WorldState;
  spyMode: boolean;
  onSelectAgent: (agentId: string) => void;
}

const PAGE_SIZE = 60;

export const SocialFeedPanel: React.FC<SocialFeedPanelProps> = ({
  state,
  spyMode,
  onSelectAgent,
}) => {
  const [tab, setTab] = useState<"feed" | "dms">("feed");
  const [searchText, setSearchText] = useState("");
  const [dayFilter, setDayFilter] = useState<string>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const postById = useMemo(() => {
    const m = new Map<string, (typeof state.posts)[number]>();
    for (const p of state.posts) m.set(p.id, p);
    return m;
  }, [state.posts]);

  const availableDays = useMemo(() => {
    const s = new Set<number>();
    for (const p of state.posts) s.add(p.day);
    for (const d of state.dms) s.add(d.day);
    return [...s].sort((a, b) => b - a);
  }, [state.posts, state.dms]);

  const filteredPosts = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return [...state.posts]
      .reverse()
      .filter((p) => {
        if (dayFilter !== "all" && p.day !== Number(dayFilter)) return false;
        if (q) {
          const hay = `${p.id} ${p.authorName} ${p.authorNation} ${p.text}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
  }, [state.posts, searchText, dayFilter]);

  const filteredDms = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return [...state.dms]
      .reverse()
      .filter((d) => {
        if (dayFilter !== "all" && d.day !== Number(dayFilter)) return false;
        if (q) {
          const hay = `${d.id} ${d.fromName} ${d.toName} ${d.text}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
  }, [state.dms, searchText, dayFilter]);

  const posts = filteredPosts.slice(0, limit);
  const dms = filteredDms.slice(0, limit);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-[#12161f] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
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
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={dayFilter}
            onChange={(e) => {
              setDayFilter(e.target.value);
              setLimit(PAGE_SIZE);
            }}
            aria-label="Filter posts by day"
            className="rounded border border-slate-700 bg-[#0b0e14] px-2 py-1 text-slate-200"
          >
            <option value="all">All days</option>
            {availableDays.map((d) => (
              <option key={d} value={String(d)}>
                Day {d}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              setLimit(PAGE_SIZE);
            }}
            placeholder="Search author, #id, or text..."
            className="rounded border border-slate-700 bg-[#0b0e14] px-2 py-1 text-slate-200 placeholder:text-slate-500"
          />
        </div>
      </div>

      <div className="max-h-96 space-y-2 overflow-y-auto pr-1 text-xs">
        {tab === "feed" &&
          (posts.length === 0 ? (
            <p className="text-slate-500">
              {state.posts.length === 0 ? "No public posts yet." : "No posts match current filters."}
            </p>
          ) : (
            <>
              {posts.map((p) => {
                const parent = p.replyToId ? postById.get(p.replyToId) : null;
                return (
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
                    {parent && (
                      <div className="mb-1.5 border-l-2 border-slate-700 pl-2 text-[11px] text-slate-400">
                        Replying to <span className="text-slate-300">{parent.authorName}</span>: &ldquo;
                        {parent.text.slice(0, 90)}
                        {parent.text.length > 90 ? "..." : ""}&rdquo;
                      </div>
                    )}
                    <p className="text-slate-200">{p.text}</p>
                  </div>
                );
              })}
              {filteredPosts.length > posts.length && (
                <button
                  type="button"
                  onClick={() => setLimit((n) => n + PAGE_SIZE)}
                  className="w-full rounded border border-slate-700 bg-slate-800/70 py-1.5 text-center text-slate-300 hover:bg-slate-800"
                >
                  Show more posts ({filteredPosts.length - posts.length} remaining)
                </button>
              )}
            </>
          ))}

        {tab === "dms" &&
          spyMode &&
          (dms.length === 0 ? (
            <p className="text-slate-500">
              {state.dms.length === 0 ? "No direct messages sent yet." : "No DMs match current filters."}
            </p>
          ) : (
            <>
              {dms.map((d) => (
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
              ))}
              {filteredDms.length > dms.length && (
                <button
                  type="button"
                  onClick={() => setLimit((n) => n + PAGE_SIZE)}
                  className="w-full rounded border border-rose-500/30 bg-rose-950/30 py-1.5 text-center text-rose-200 hover:bg-rose-950/50"
                >
                  Show more DMs ({filteredDms.length - dms.length} remaining)
                </button>
              )}
            </>
          ))}
      </div>
    </div>
  );
};
