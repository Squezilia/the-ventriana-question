import React, { useEffect, useMemo, useRef, useState } from "react";
import type { SimEvent } from "../../contracts/events.ts";
import type { RunHealthStats, StreamStateMessage } from "../../contracts/stream.ts";
import type {
  DailyMetricsRow,
  PhaseName,
  RegionId,
  RunMetadata,
  WorldState,
} from "../../contracts/types.ts";
import { AgentPanel } from "./components/AgentPanel.tsx";
import { AldoriaMap } from "./components/AldoriaMap.tsx";
import { ChartsPanel } from "./components/ChartsPanel.tsx";
import { CulturePanel } from "./components/CulturePanel.tsx";
import { ElectionsPanel } from "./components/ElectionsPanel.tsx";
import { EventLogPanel } from "./components/EventLogPanel.tsx";
import { GovernmentPanel } from "./components/GovernmentPanel.tsx";
import { RegionPanel } from "./components/RegionPanel.tsx";
import { RunHealthPanel } from "./components/RunHealthPanel.tsx";
import { SocialFeedPanel } from "./components/SocialFeedPanel.tsx";

type MainTab = "overview" | "social" | "elections" | "government" | "charts" | "culture" | "events";

const EMPTY_HEALTH: RunHealthStats = {
  callsLastMinute: 0,
  totalCalls: 0,
  throttledCount: 0,
  rateLimit429Count: 0,
  retryCount: 0,
  invalidOutputCount: 0,
  safetyBlockCount: 0,
  promptTokensTotal: 0,
  completionTokensTotal: 0,
  estimatedSecondsRemaining: null,
};

export const App: React.FC = () => {
  const embedded = window.__VENTRIANA_REPLAY_DATA__;
  const [mode, setMode] = useState<"live" | "replay" | "static">(
    embedded ? "static" : "replay"
  );
  const [metadata, setMetadata] = useState<RunMetadata | null>(
    embedded?.metadata ?? null
  );
  const [state, setState] = useState<WorldState | null>(() => {
    if (!embedded) return null;
    const days = Object.keys(embedded.snapshots).map(Number).sort((a, b) => a - b);
    const lastDay = days[days.length - 1] ?? 0;
    return embedded.snapshots[lastDay] ?? null;
  });
  const [events, setEvents] = useState<SimEvent[]>(embedded?.events ?? []);
  const [stats, setStats] = useState<DailyMetricsRow[]>(embedded?.stats ?? []);
  const [health, setHealth] = useState<RunHealthStats>(EMPTY_HEALTH);
  const [phase, setPhase] = useState<PhaseName>("rollover");
  const [connected, setConnected] = useState<boolean>(Boolean(embedded));

  // Selection & UI controls
  const [selectedRegionId, setSelectedRegionId] = useState<RegionId | null>("teshar");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [spyMode, setSpyMode] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<MainTab>("overview");

  // Replay controls
  const availableDays = useMemo(() => {
    if (embedded) {
      return Object.keys(embedded.snapshots).map(Number).sort((a, b) => a - b);
    }
    return stats.map((s) => s.day);
  }, [embedded, stats]);

  const [replayDay, setReplayDay] = useState<number>(
    availableDays[availableDays.length - 1] ?? 0
  );
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playSpeedMs, setPlaySpeedMs] = useState<number>(800);
  const playTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch initial state & connect SSE when not in static mode
  useEffect(() => {
    if (embedded) return;

    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let hasOpenedOnce = false;

    const loadInitial = async () => {
      try {
        const res = await fetch("/api/run");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setMode(data.mode);
        setMetadata(data.metadata);
        if (data.latestState) {
          setState(data.latestState);
          setPhase(data.latestState.phase);
          setReplayDay(data.latestState.day);
        }
        setEvents(data.events ?? []);
        setStats(data.stats ?? []);
        if (data.health) setHealth(data.health);
      } catch {
        // ignore
      }
    };

    const connectStream = () => {
      if (cancelled) return;
      es = new EventSource("/api/stream");
      es.onopen = () => {
        setConnected(true);
        if (hasOpenedOnce) {
          loadInitial();
        }
        hasOpenedOnce = true;
      };
      es.onmessage = (msgEvent) => {
        try {
          const msg = JSON.parse(msgEvent.data) as StreamStateMessage;
          if (msg.type === "init" || msg.type === "state_update") {
            if (msg.state) {
              setState(msg.state);
              setPhase(msg.phase);
              setReplayDay(msg.day);
            }
            if (msg.stats) setStats(msg.stats);
            if (msg.health) setHealth(msg.health);
            setMetadata((prev) => (prev ? { ...prev, status: msg.status } : prev));
          } else if (msg.type === "event" && msg.event) {
            setEvents((prev) => [...prev, msg.event!]);
          }
        } catch {
          // ignore malformed chunk
        }
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!cancelled) {
          reconnectTimer = setTimeout(connectStream, 2000);
        }
      };
    };

    loadInitial();
    connectStream();

    return () => {
      cancelled = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [embedded]);

  // Load snapshot when replayDay changes in replay or static mode
  useEffect(() => {
    if (mode === "live") return;
    if (embedded) {
      const snap = embedded.snapshots[replayDay];
      if (snap) {
        setState(snap);
        setPhase(snap.phase);
      }
      return;
    }
    let cancelled = false;
    fetch(`/api/snapshot/${replayDay}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((snap) => {
        if (!cancelled && snap) {
          setState(snap);
          setPhase(snap.phase);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [replayDay, mode, embedded]);

  // Replay playback loop
  useEffect(() => {
    if (playTimerRef.current) {
      clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    if (!isPlaying || mode === "live" || availableDays.length === 0) return;

    playTimerRef.current = setInterval(() => {
      setReplayDay((prev) => {
        const idx = availableDays.indexOf(prev);
        if (idx < 0 || idx >= availableDays.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return availableDays[idx + 1]!;
      });
    }, playSpeedMs);

    return () => {
      if (playTimerRef.current) clearInterval(playTimerRef.current);
    };
  }, [isPlaying, playSpeedMs, mode, availableDays]);

  const termDays = metadata?.config.TERM_DAYS ?? 7;
  const currentDay = state?.day ?? 0;
  const daysToElection = (termDays - (currentDay % termDays)) % termDays;
  const canSpy = !embedded?.noPrivate;

  const sendControl = async (action: "start" | "pause" | "resume" | "step") => {
    await fetch(`/api/control/${action}`, { method: "POST" });
  };

  if (!state) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0e1116] text-slate-300">
        Loading Aldoria simulation state...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0e1116] text-slate-100">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-[#0e1116]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-base font-bold tracking-tight text-slate-100 sm:text-lg">
                Ventriana Sorunu · The Ventrian Question
              </h1>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  mode === "live"
                    ? connected
                      ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                      : "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                    : "bg-sky-500/15 text-sky-300 border border-sky-500/30"
                }`}
              >
                {mode === "live"
                  ? connected
                    ? "LIVE"
                    : "RECONNECTING"
                  : mode === "static"
                  ? "STATIC REPLAY"
                  : "REPLAY"}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Aldoria · Day <strong className="text-slate-200">{currentDay}</strong> · Phase{" "}
              <strong className="text-slate-200">{phase}</strong> · Next election:{" "}
              <strong className="text-slate-200">
                {daysToElection === 0 ? "Today" : `in ${daysToElection}d`}
              </strong>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* Live controls */}
            {mode === "live" && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => sendControl("start")}
                  className="rounded border border-emerald-600/50 bg-emerald-600/20 px-2.5 py-1 text-emerald-200 hover:bg-emerald-600/30"
                >
                  Start
                </button>
                <button
                  onClick={() => sendControl("pause")}
                  className="rounded border border-amber-600/50 bg-amber-600/20 px-2.5 py-1 text-amber-200 hover:bg-amber-600/30"
                >
                  Pause
                </button>
                <button
                  onClick={() => sendControl("resume")}
                  className="rounded border border-sky-600/50 bg-sky-600/20 px-2.5 py-1 text-sky-200 hover:bg-sky-600/30"
                >
                  Resume
                </button>
                <button
                  onClick={() => sendControl("step")}
                  className="rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-slate-200 hover:bg-slate-700"
                >
                  Step phase
                </button>
              </div>
            )}

            {/* Replay controls */}
            {mode !== "live" && availableDays.length > 0 && (
              <div className="flex items-center gap-2 rounded border border-slate-800 bg-[#12161f] px-2.5 py-1">
                <button
                  onClick={() => setIsPlaying((p) => !p)}
                  className="rounded bg-slate-800 px-2 py-0.5 text-slate-200 hover:bg-slate-700"
                >
                  {isPlaying ? "Pause" : "Play"}
                </button>
                <input
                  type="range"
                  min={availableDays[0] ?? 0}
                  max={availableDays[availableDays.length - 1] ?? 0}
                  value={replayDay}
                  onChange={(e) => {
                    setIsPlaying(false);
                    setReplayDay(Number(e.target.value));
                  }}
                  aria-label="Replay day slider"
                  className="w-28 accent-rose-500 sm:w-40"
                />
                <span className="w-12 text-right font-mono text-slate-300">
                  D{replayDay}
                </span>
                <select
                  value={playSpeedMs}
                  onChange={(e) => setPlaySpeedMs(Number(e.target.value))}
                  className="rounded border border-slate-700 bg-[#0b0e14] px-1.5 py-0.5 text-slate-300"
                >
                  <option value={1200}>1x</option>
                  <option value={600}>2x</option>
                  <option value={250}>4x</option>
                </select>
              </div>
            )}

            {/* Spy toggle */}
            {canSpy && (
              <button
                onClick={() => setSpyMode((s) => !s)}
                className={`rounded border px-2.5 py-1 font-medium transition ${
                  spyMode
                    ? "border-rose-500/60 bg-rose-500/20 text-rose-200"
                    : "border-slate-700 bg-slate-800/70 text-slate-300 hover:bg-slate-800"
                }`}
              >
                {spyMode ? "Spy: ON" : "Spy: OFF"}
              </button>
            )}
          </div>
        </div>

        {/* Navigation tabs */}
        <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 text-xs">
          {(
            [
              ["overview", "Map & Citizens"],
              ["social", "Social Feed"],
              ["elections", "Elections"],
              ["government", "Government & Curriculum"],
              ["charts", "Charts"],
              ["culture", "Culture Hall"],
              ["events", "Event Log"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`whitespace-nowrap rounded px-3 py-1.5 font-medium transition ${
                activeTab === key
                  ? "bg-slate-800 text-slate-100"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-4">
        {mode === "live" && <RunHealthPanel health={health} />}

        {activeTab === "overview" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            <div className="lg:col-span-7 space-y-4">
              <AldoriaMap
                state={state}
                selectedRegionId={selectedRegionId}
                selectedAgentId={selectedAgentId}
                onSelectRegion={(rid) => setSelectedRegionId(rid)}
                onSelectAgent={(aid) => setSelectedAgentId(aid)}
              />
              <RegionPanel
                state={state}
                regionId={selectedRegionId}
                onSelectAgent={(aid) => setSelectedAgentId(aid)}
              />
            </div>
            <div className="lg:col-span-5">
              <AgentPanel
                state={state}
                agentId={selectedAgentId}
                spyMode={spyMode && canSpy}
              />
            </div>
          </div>
        )}

        {activeTab === "social" && (
          <SocialFeedPanel
            state={state}
            spyMode={spyMode && canSpy}
            onSelectAgent={(aid) => {
              setSelectedAgentId(aid);
              setActiveTab("overview");
            }}
          />
        )}

        {activeTab === "elections" && (
          <ElectionsPanel
            state={state}
            onSelectAgent={(aid) => {
              setSelectedAgentId(aid);
              setActiveTab("overview");
            }}
          />
        )}

        {activeTab === "government" && (
          <GovernmentPanel
            state={state}
            onSelectAgent={(aid) => {
              setSelectedAgentId(aid);
              setActiveTab("overview");
            }}
          />
        )}

        {activeTab === "charts" && <ChartsPanel stats={stats} state={state} />}

        {activeTab === "culture" && (
          <CulturePanel
            state={state}
            onSelectAgent={(aid) => {
              setSelectedAgentId(aid);
              setActiveTab("overview");
            }}
          />
        )}

        {activeTab === "events" && (
          <EventLogPanel
            events={events}
            state={state}
            spyMode={spyMode && canSpy}
          />
        )}
      </main>
    </div>
  );
};
