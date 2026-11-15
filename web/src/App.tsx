import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  HelpCircle,
  Pause,
  Play,
  Plus,
  Radio,
  SkipForward,
  Square,
  X,
} from "lucide-react";
import type { SimEvent } from "../../contracts/events.ts";
import type {
  ConfigDefaultsResponse,
  RunHealthStats,
  RunSummaryInfo,
  StreamStateMessage,
} from "../../contracts/stream.ts";
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
import { DashboardOnboarding } from "./components/DashboardOnboarding.tsx";
import { ElectionsPanel } from "./components/ElectionsPanel.tsx";
import { EventLogPanel } from "./components/EventLogPanel.tsx";
import { GovernmentPanel } from "./components/GovernmentPanel.tsx";
import { NewRunModal } from "./components/NewRunModal.tsx";
import { RegionPanel } from "./components/RegionPanel.tsx";
import { RunHealthPanel } from "./components/RunHealthPanel.tsx";
import { RunSwitcher } from "./components/RunSwitcher.tsx";
import { SocialFeedPanel } from "./components/SocialFeedPanel.tsx";
import { UI_STRINGS, type UiLang } from "./i18n.ts";

type MainTab =
  | "overview"
  | "social"
  | "elections"
  | "government"
  | "charts"
  | "culture"
  | "events";

const UI_LANG_STORAGE_KEY = "ventriana_ui_lang_v1";

function onboardingKeyForMode(mode: "live" | "replay" | "static"): string {
  return mode === "live"
    ? "ventriana_onboarding_live_v1"
    : "ventriana_replay_onboarding_v1";
}

function readOnboardingDismissed(mode: "live" | "replay" | "static"): boolean {
  try {
    return window.localStorage.getItem(onboardingKeyForMode(mode)) === "dismissed";
  } catch {
    return false;
  }
}

function saveOnboardingDismissed(mode: "live" | "replay" | "static"): void {
  try {
    window.localStorage.setItem(onboardingKeyForMode(mode), "dismissed");
  } catch {
    // Ignore storage restriction on file:// or private windows
  }
}

function readStoredUiLang(): UiLang {
  try {
    const raw = window.localStorage.getItem(UI_LANG_STORAGE_KEY);
    return raw === "tr" ? "tr" : "en";
  } catch {
    return "en";
  }
}

function saveUiLang(lang: UiLang): void {
  try {
    window.localStorage.setItem(UI_LANG_STORAGE_KEY, lang);
  } catch {
    // Ignore storage restriction
  }
}

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
  cachedTokensTotal: 0,
  estimatedSecondsRemaining: null,
};

export const App: React.FC = () => {
  const embedded = window.__VENTRIANA_REPLAY_DATA__;
  const [serverMode, setServerMode] = useState<"live" | "replay" | "static">(
    embedded ? "static" : "replay"
  );
  const [uiLang, setUiLang] = useState<UiLang>(() => readStoredUiLang());
  const t = UI_STRINGS[uiLang];

  // Multi-run Control Center state
  const [runs, setRuns] = useState<RunSummaryInfo[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    embedded?.metadata?.runId ?? null
  );
  const [activeLiveRunId, setActiveLiveRunId] = useState<string | null>(null);
  const [configDefaults, setConfigDefaults] = useState<ConfigDefaultsResponse | null>(
    null
  );
  const [newRunModalOpen, setNewRunModalOpen] = useState(false);
  const [resumeConflict, setResumeConflict] = useState<{
    activeRunId: string;
    targetRunId: string;
    days?: number;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [bootLoaded, setBootLoaded] = useState<boolean>(Boolean(embedded));

  // Currently inspected run state
  const [metadata, setMetadata] = useState<RunMetadata | null>(
    embedded?.metadata ?? null
  );
  const [state, setState] = useState<WorldState | null>(() => {
    if (!embedded) return null;
    const days = Object.keys(embedded.snapshots)
      .map(Number)
      .sort((a, b) => a - b);
    const lastDay = days[days.length - 1] ?? 0;
    return embedded.snapshots[lastDay] ?? null;
  });
  const [events, setEvents] = useState<SimEvent[]>(embedded?.events ?? []);
  const [stats, setStats] = useState<DailyMetricsRow[]>(embedded?.stats ?? []);
  const [snapshotDays, setSnapshotDays] = useState<number[]>(() =>
    embedded
      ? Object.keys(embedded.snapshots)
          .map(Number)
          .sort((a, b) => a - b)
      : []
  );
  const [health, setHealth] = useState<RunHealthStats>(EMPTY_HEALTH);
  const [phase, setPhase] = useState<PhaseName>("rollover");
  const [isPausedLive, setIsPausedLive] = useState<boolean>(false);
  const [isStoppingLive, setIsStoppingLive] = useState<boolean>(false);
  const [connected, setConnected] = useState<boolean>(Boolean(embedded));

  // Selection & UI controls
  const [selectedRegionId, setSelectedRegionId] = useState<RegionId | null>("teshar");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [spyMode, setSpyMode] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<MainTab>("overview");

  // Onboarding state
  const [briefingOpen, setBriefingOpen] = useState<boolean>(() =>
    embedded ? !readOnboardingDismissed("static") : false
  );
  const [tourStep, setTourStep] = useState<number | null>(null);
  const onboardingInitializedRef = useRef<boolean>(Boolean(embedded));

  // Replay & Follow-Live state
  const availableDays = useMemo(() => {
    if (embedded) {
      return Object.keys(embedded.snapshots)
        .map(Number)
        .sort((a, b) => a - b);
    }
    const daySet = new Set<number>(snapshotDays);
    for (const s of stats) daySet.add(s.day);
    return [...daySet].sort((a, b) => a - b);
  }, [embedded, snapshotDays, stats]);

  const [replayDay, setReplayDay] = useState<number>(
    availableDays[availableDays.length - 1] ?? 0
  );
  const [latestLiveDay, setLatestLiveDay] = useState<number>(0);
  const [followLive, setFollowLive] = useState<boolean>(true);
  const followLiveRef = useRef<boolean>(true);
  followLiveRef.current = followLive;

  const selectedRunIdRef = useRef<string | null>(selectedRunId);
  selectedRunIdRef.current = selectedRunId;

  const loadSeqRef = useRef<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playSpeedMs, setPlaySpeedMs] = useState<number>(800);
  const playTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isViewingActiveLive =
    serverMode === "live" &&
    Boolean(selectedRunId) &&
    selectedRunId === activeLiveRunId;

  const isViewingLiveOrPausedActive =
    isViewingActiveLive ||
    (serverMode === "live" &&
      (metadata?.status === "running" || metadata?.status === "initialized"));

  const applyRunData = useCallback(
    (
      data: {
        mode?: "live" | "replay";
        metadata: RunMetadata | null;
        latestState: WorldState | null;
        events?: SimEvent[];
        stats?: DailyMetricsRow[];
        health?: RunHealthStats;
        availableDays?: number[];
        isPaused?: boolean;
        isStopping?: boolean;
        activeRunId?: string | null;
      },
      options?: { preserveFollowState?: boolean }
    ) => {
      if (data.mode) setServerMode(data.mode);
      if (data.activeRunId !== undefined) {
        setActiveLiveRunId(data.activeRunId ?? null);
      }
      setMetadata(data.metadata);
      if (data.metadata?.runId) {
        setSelectedRunId(data.metadata.runId);
      }
      if (data.availableDays) {
        setSnapshotDays([...data.availableDays].sort((a, b) => a - b));
      }
      setEvents(data.events ?? []);
      setStats(data.stats ?? []);
      setHealth(data.health ?? EMPTY_HEALTH);
      setIsPausedLive(Boolean(data.isPaused));
      setIsStoppingLive(Boolean(data.isStopping));

      if (data.latestState) {
        setLatestLiveDay(data.latestState.day);
        if (!options?.preserveFollowState || followLiveRef.current) {
          setState(data.latestState);
          setPhase(data.latestState.phase);
          setReplayDay(data.latestState.day);
        }
      } else {
        setState(null);
        setPhase("rollover");
        setReplayDay(0);
        setLatestLiveDay(0);
      }

      if (data.mode && !onboardingInitializedRef.current) {
        onboardingInitializedRef.current = true;
        setBriefingOpen(!readOnboardingDismissed(data.mode));
      }
    },
    []
  );

  const refreshRunsAndDefaults = useCallback(async () => {
    if (embedded) return;
    try {
      const [runsRes, defRes] = await Promise.all([
        fetch("/api/runs"),
        fetch("/api/config/defaults").catch(() => null),
      ]);
      if (runsRes.ok) {
        const runsData = await runsRes.json();
        setRuns(runsData.runs ?? []);
        setActiveLiveRunId(runsData.activeRunId ?? null);
        if (runsData.mode) setServerMode(runsData.mode);
      }
      if (defRes && defRes.ok) {
        const defData = (await defRes.json()) as ConfigDefaultsResponse;
        setConfigDefaults(defData);
      }
    } catch {
      // ignore transient poll failure
    }
  }, [embedded]);

  const loadRunById = useCallback(
    async (
      targetRunId?: string | null,
      options?: { preserveFollowState?: boolean }
    ): Promise<"live" | "replay" | null> => {
      if (embedded) return "static" as unknown as null;
      const seq = ++loadSeqRef.current;
      try {
        const url = targetRunId
          ? `/api/runs/${encodeURIComponent(targetRunId)}`
          : "/api/run";
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (seq !== loadSeqRef.current) return null;
        applyRunData(data, options);
        if (data.mode !== "live") {
          setConnected(true);
        }
        return data.mode ?? null;
      } catch {
        return null;
      } finally {
        if (seq === loadSeqRef.current) {
          setBootLoaded(true);
        }
      }
    },
    [embedded, applyRunData]
  );

  // Initial boot load
  useEffect(() => {
    if (embedded) return;
    void Promise.all([loadRunById(null), refreshRunsAndDefaults()]);
  }, [embedded, loadRunById, refreshRunsAndDefaults]);

  // SSE subscription in live mode (scoped to selectedRunId + global runs_updated)
  useEffect(() => {
    if (embedded || !bootLoaded || serverMode !== "live") return;

    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let hasOpenedOnce = false;

    const streamUrl = selectedRunId
      ? `/api/stream?runId=${encodeURIComponent(selectedRunId)}`
      : "/api/stream";

    const connectStream = () => {
      if (cancelled) return;
      es = new EventSource(streamUrl);
      es.onopen = () => {
        setConnected(true);
        if (hasOpenedOnce) {
          void loadRunById(selectedRunIdRef.current, { preserveFollowState: true });
          void refreshRunsAndDefaults();
        }
        hasOpenedOnce = true;
      };
      es.onmessage = (msgEvent) => {
        try {
          const msg = JSON.parse(msgEvent.data) as StreamStateMessage;
          if (msg.type === "runs_updated") {
            if (msg.runs) setRuns(msg.runs);
            if (msg.activeRunId !== undefined) {
              setActiveLiveRunId(msg.activeRunId ?? null);
            }
            return;
          }

          if (msg.activeRunId !== undefined) {
            setActiveLiveRunId(msg.activeRunId ?? null);
          }

          const currentTarget = selectedRunIdRef.current;
          const matchesViewed = !currentTarget || msg.runId === currentTarget;
          if (!matchesViewed) return;

          if (msg.type === "status") {
            setMetadata((prev) =>
              prev ? { ...prev, status: msg.status } : prev
            );
            if (msg.isPaused !== undefined) setIsPausedLive(msg.isPaused);
            if (msg.isStopping !== undefined) setIsStoppingLive(msg.isStopping);
            if (msg.health) setHealth(msg.health);
            return;
          }

          if (msg.type === "init" || msg.type === "state_update") {
            setLatestLiveDay(msg.day);
            setSnapshotDays((prev) =>
              prev.includes(msg.day) ? prev : [...prev, msg.day].sort((a, b) => a - b)
            );
            if (msg.stats) setStats(msg.stats);
            if (msg.health) setHealth(msg.health);
            if (msg.isPaused !== undefined) setIsPausedLive(msg.isPaused);
            if (msg.isStopping !== undefined) setIsStoppingLive(msg.isStopping);
            setMetadata((prev) =>
              prev ? { ...prev, status: msg.status } : prev
            );

            if (msg.state && followLiveRef.current) {
              setState(msg.state);
              setPhase(msg.phase);
              setReplayDay(msg.day);
            }
          } else if (msg.type === "event" && msg.event) {
            setEvents((prev) => {
              if (prev.length > 0 && prev[prev.length - 1]?.id === msg.event!.id) {
                return prev;
              }
              return [...prev, msg.event!];
            });
          }
        } catch {
          // ignore malformed SSE chunk
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

    connectStream();

    return () => {
      cancelled = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [embedded, bootLoaded, serverMode, selectedRunId, loadRunById, refreshRunsAndDefaults]);

  // Load snapshot when scrubbing replayDay (in replay/static mode OR when user scrubbed back from Follow Live)
  useEffect(() => {
    const shouldFetchHistorical =
      serverMode !== "live" || (isViewingActiveLive && !followLive) || (!isViewingActiveLive && Boolean(selectedRunId));
    if (!shouldFetchHistorical) return;

    if (embedded) {
      const snap = embedded.snapshots[replayDay];
      if (snap) {
        setState(snap);
        setPhase(snap.phase);
      }
      return;
    }

    if (!selectedRunId) return;
    let cancelled = false;
    fetch(`/api/runs/${encodeURIComponent(selectedRunId)}/snapshot/${replayDay}`)
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
  }, [replayDay, serverMode, embedded, selectedRunId, isViewingActiveLive, followLive]);

  // Replay playback loop (inactive runs or paused historical scrubbing)
  useEffect(() => {
    if (playTimerRef.current) {
      clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    if (!isPlaying || (isViewingActiveLive && followLive) || availableDays.length === 0) {
      return;
    }

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
  }, [isPlaying, playSpeedMs, isViewingActiveLive, followLive, availableDays]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (tourStep !== null) {
          setTourStep(null);
          return;
        }
        if (briefingOpen) {
          setBriefingOpen(false);
          saveOnboardingDismissed(serverMode);
        }
        return;
      }

      if (isViewingActiveLive && followLive) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (availableDays.length === 0) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIsPlaying(false);
        if (isViewingActiveLive) setFollowLive(false);
        setReplayDay((prev) => {
          const idx = availableDays.indexOf(prev);
          if (idx <= 0) return availableDays[0]!;
          return availableDays[idx - 1]!;
        });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setIsPlaying(false);
        if (isViewingActiveLive) setFollowLive(false);
        setReplayDay((prev) => {
          const idx = availableDays.indexOf(prev);
          if (idx < 0) return availableDays[0]!;
          if (idx >= availableDays.length - 1) return prev;
          return availableDays[idx + 1]!;
        });
      } else if (e.key === " " && !isViewingActiveLive) {
        e.preventDefault();
        setIsPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    serverMode,
    isViewingActiveLive,
    followLive,
    availableDays,
    tourStep,
    briefingOpen,
  ]);

  const handleSelectRun = (runId: string) => {
    setActionError(null);
    setIsPlaying(false);
    setFollowLive(true);
    setSelectedRunId(runId);
    void loadRunById(runId);
  };

  const handleResumeRun = async (
    targetRunId: string,
    opts?: { days?: number; stopActive?: boolean }
  ) => {
    setActionError(null);
    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(targetRunId)}/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts ?? {}),
        }
      );
      const data = await res.json();
      if (res.status === 409 && data.conflict) {
        setResumeConflict({
          activeRunId: data.activeRunId ?? activeLiveRunId ?? "active",
          targetRunId,
          days: opts?.days,
        });
        return;
      }
      if (!res.ok) {
        setActionError(data.error ?? "Failed to resume simulation.");
        return;
      }
      setResumeConflict(null);
      setFollowLive(true);
      setIsPlaying(false);
      setSelectedRunId(targetRunId);
      setActiveLiveRunId(targetRunId);
      setIsPausedLive(false);
      await Promise.all([loadRunById(targetRunId), refreshRunsAndDefaults()]);
    } catch {
      setActionError("Network error while resuming simulation.");
    }
  };

  const sendControl = async (
    action: "start" | "pause" | "resume" | "step" | "stop"
  ) => {
    setActionError(null);
    const targetId = selectedRunId ?? activeLiveRunId;
    try {
      if (action === "resume" && targetId && targetId !== activeLiveRunId) {
        await handleResumeRun(targetId);
        return;
      }
      const res = await fetch(`/api/control/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(targetId ? { runId: targetId } : {}),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setActionError(data.error ?? `Control action '${action}' failed.`);
        return;
      }
      if (action === "pause") {
        setIsPausedLive(true);
      } else if (action === "resume" || action === "start") {
        setIsPausedLive(false);
      } else if (action === "stop") {
        setIsStoppingLive(false);
        setIsPausedLive(true);
        await refreshRunsAndDefaults();
        if (targetId) await loadRunById(targetId);
      }
    } catch {
      setActionError("Network error sending simulation command.");
    }
  };

  const handleReturnToLive = () => {
    if (!activeLiveRunId) return;
    setIsPlaying(false);
    setFollowLive(true);
    if (selectedRunId !== activeLiveRunId) {
      setSelectedRunId(activeLiveRunId);
      void loadRunById(activeLiveRunId);
    } else {
      void loadRunById(activeLiveRunId);
    }
  };

  const termDays = metadata?.config.TERM_DAYS ?? 7;
  const educationDays = metadata?.config.EDUCATION_DAYS ?? 5;
  const currentDay = state?.day ?? 0;
  const targetDays = metadata?.config.SIM_DAYS;
  const daysToElection = (termDays - (currentDay % termDays)) % termDays;
  const canSpy = !embedded?.noPrivate;

  // Scope events & charts to inspected day when not following live tip
  const isAtLiveTip = isViewingActiveLive && followLive;
  const visibleEvents = useMemo(
    () => (isAtLiveTip ? events : events.filter((e) => e.day <= currentDay)),
    [isAtLiveTip, events, currentDay]
  );
  const visibleStats = useMemo(
    () => (isAtLiveTip ? stats : stats.filter((s) => s.day <= currentDay)),
    [isAtLiveTip, stats, currentDay]
  );

  const activeTourTarget = (() => {
    if (tourStep === null) return null;
    if (serverMode === "live") {
      return tourStep === 0
        ? "switcher"
        : tourStep === 1
          ? "controls"
          : tourStep === 2
            ? "health"
            : tourStep === 3
              ? "map"
              : tourStep === 4
                ? "spy"
                : null;
    }
    return tourStep === 0
      ? "timeline"
      : tourStep === 1
        ? "map"
        : tourStep === 2
          ? "spy"
          : tourStep === 3
            ? "tabs"
            : null;
  })();

  const runStatusBadge = (() => {
    if (!metadata) return null;
    if (isStoppingLive) {
      return {
        label: t.statusLabels.stopping,
        cls: "border-amber-500/40 bg-amber-500/15 text-amber-200",
      };
    }
    if (isViewingActiveLive && isPausedLive) {
      return {
        label: t.statusLabels.paused,
        cls: "border-amber-500/40 bg-amber-500/15 text-amber-200",
      };
    }
    const st = metadata.status;
    if (st === "running") {
      return {
        label: t.statusLabels.running,
        cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
      };
    }
    if (st === "paused" || st === "initialized") {
      return {
        label: t.statusLabels[st],
        cls: "border-amber-500/40 bg-amber-500/15 text-amber-200",
      };
    }
    if (st === "budget_stopped") {
      return {
        label: t.statusLabels.budget_stopped,
        cls: "border-orange-500/40 bg-orange-500/15 text-orange-200",
      };
    }
    if (st === "failed") {
      return {
        label: t.statusLabels.failed,
        cls: "border-rose-500/40 bg-rose-500/15 text-rose-200",
      };
    }
    return {
      label: t.statusLabels.completed,
      cls: "border-sky-500/35 bg-sky-500/10 text-sky-300",
    };
  })();

  const showReplayScrubber =
    availableDays.length > 0 &&
    (serverMode !== "live" ||
      !isViewingActiveLive ||
      !followLive ||
      availableDays.length > 1);

  const canResumeViewedFromDisk =
    serverMode === "live" &&
    Boolean(metadata) &&
    !isViewingActiveLive &&
    metadata?.status !== "completed" &&
    (metadata?.lastCompletedDay ?? 0) < (targetDays ?? 0);

  if (!bootLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0e1116] text-sm text-slate-300">
        Loading Aldoria simulation state...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0e1116] text-slate-100">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-[#0e1116]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-bold tracking-tight text-slate-100 sm:text-lg">
                {t.title}
              </h1>
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  serverMode === "live"
                    ? connected
                      ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                      : "border-amber-500/30 bg-amber-500/15 text-amber-300"
                    : "border-sky-500/30 bg-sky-500/15 text-sky-300"
                }`}
              >
                {serverMode === "live"
                  ? connected
                    ? t.liveBadge
                    : t.reconnectingBadge
                  : serverMode === "static"
                    ? t.staticReplayBadge
                    : t.replayBadge}
              </span>
              {runStatusBadge && (
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${runStatusBadge.cls}`}
                >
                  {runStatusBadge.label}
                </span>
              )}
              <RunSwitcher
                lang={uiLang}
                serverMode={serverMode}
                runs={runs}
                selectedRunId={selectedRunId}
                activeLiveRunId={activeLiveRunId}
                highlightTour={activeTourTarget === "switcher"}
                onSelectRun={handleSelectRun}
                onResumeRun={(rid) => void handleResumeRun(rid)}
                onOpenNewRun={() => setNewRunModalOpen(true)}
              />
            </div>

            {state && (
              <p className="mt-1 text-xs text-slate-400">
                {t.subtitlePrefix} · {t.dayLabel}{" "}
                <strong className="font-mono tabular-nums text-slate-200">
                  {currentDay}
                  {targetDays ? `/${targetDays}` : ""}
                </strong>{" "}
                · {t.phaseLabel}{" "}
                <strong className="text-slate-200">{t.phases[phase] ?? phase}</strong> ·{" "}
                {t.nextElection}:{" "}
                <strong className="text-slate-200">
                  {daysToElection === 0 ? t.today : t.inDays(daysToElection)}
                </strong>
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* Live Simulation Controls */}
            {serverMode === "live" && (
              <div
                className={`flex flex-wrap items-center gap-1.5 rounded border p-1 transition ${
                  activeTourTarget === "controls"
                    ? "border-sky-400 ring-2 ring-sky-400/50"
                    : "border-slate-800 bg-[#12161f]"
                }`}
              >
                {isViewingLiveOrPausedActive && (
                  <>
                    {(metadata?.status === "initialized" || isPausedLive) ? (
                      <button
                        type="button"
                        disabled={isStoppingLive}
                        onClick={() =>
                          void sendControl(
                            metadata?.status === "initialized" ? "start" : "resume"
                          )
                        }
                        className="inline-flex items-center gap-1 rounded border border-emerald-600/50 bg-emerald-600/20 px-2.5 py-1 text-emerald-200 hover:bg-emerald-600/30 disabled:opacity-45"
                      >
                        <Play className="h-3 w-3" />
                        {metadata?.status === "initialized"
                          ? t.controls.start
                          : t.controls.resume}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isStoppingLive}
                        onClick={() => void sendControl("pause")}
                        className="inline-flex items-center gap-1 rounded border border-amber-600/50 bg-amber-600/20 px-2.5 py-1 text-amber-200 hover:bg-amber-600/30 disabled:opacity-45"
                      >
                        <Pause className="h-3 w-3" />
                        {t.controls.pause}
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={isStoppingLive}
                      onClick={() => void sendControl("step")}
                      className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-slate-200 hover:bg-slate-700 disabled:opacity-45"
                    >
                      <SkipForward className="h-3 w-3" />
                      {t.controls.step}
                    </button>

                    <button
                      type="button"
                      disabled={isStoppingLive}
                      onClick={() => void sendControl("stop")}
                      className="inline-flex items-center gap-1 rounded border border-rose-600/50 bg-rose-600/15 px-2.5 py-1 text-rose-200 hover:bg-rose-600/25 disabled:opacity-45"
                    >
                      <Square className="h-3 w-3" />
                      {t.controls.stop}
                    </button>
                  </>
                )}

                {canResumeViewedFromDisk && selectedRunId && (
                  <button
                    type="button"
                    onClick={() => void handleResumeRun(selectedRunId)}
                    className="inline-flex items-center gap-1 rounded border border-sky-500/50 bg-sky-500/20 px-2.5 py-1 text-sky-200 hover:bg-sky-500/30"
                  >
                    <Play className="h-3 w-3" />
                    {t.controls.resume}
                  </button>
                )}

                {metadata?.status === "completed" && !isViewingActiveLive && selectedRunId && (
                  <button
                    type="button"
                    onClick={() =>
                      void handleResumeRun(selectedRunId, {
                        days: (targetDays ?? currentDay + 1) + 7,
                      })
                    }
                    className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-sky-200 hover:bg-sky-500/25"
                  >
                    <Play className="h-3 w-3" />
                    {t.controls.extend}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setNewRunModalOpen(true)}
                  className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 font-medium text-emerald-200 hover:bg-emerald-500/25"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t.controls.newSim}
                </button>
              </div>
            )}

            {/* Replay / Historical Day Scrubber */}
            {showReplayScrubber && (
              <div
                className={`flex items-center gap-2 rounded border bg-[#12161f] px-2.5 py-1 transition ${
                  activeTourTarget === "timeline"
                    ? "border-sky-400 ring-2 ring-sky-400/50"
                    : "border-slate-800"
                }`}
              >
                {(!isViewingActiveLive || !followLive) && (
                  <button
                    type="button"
                    onClick={() => setIsPlaying((p) => !p)}
                    className="rounded bg-slate-800 px-2 py-0.5 text-slate-200 hover:bg-slate-700"
                  >
                    {isPlaying ? t.replay.pause : t.replay.play}
                  </button>
                )}
                <input
                  type="range"
                  min={availableDays[0] ?? 0}
                  max={availableDays[availableDays.length - 1] ?? 0}
                  value={replayDay}
                  onChange={(e) => {
                    setIsPlaying(false);
                    if (isViewingActiveLive) setFollowLive(false);
                    setReplayDay(Number(e.target.value));
                  }}
                  aria-label="Replay day slider"
                  className="w-24 accent-rose-500 sm:w-36"
                />
                <span className="w-10 text-right font-mono tabular-nums text-slate-300">
                  D{replayDay}
                </span>
                {(!isViewingActiveLive || !followLive) && (
                  <select
                    value={playSpeedMs}
                    onChange={(e) => setPlaySpeedMs(Number(e.target.value))}
                    aria-label="Replay playback speed"
                    className="rounded border border-slate-700 bg-[#0b0e14] px-1.5 py-0.5 text-slate-300"
                  >
                    <option value={1200}>1x</option>
                    <option value={600}>2x</option>
                    <option value={250}>4x</option>
                  </select>
                )}
                {isViewingActiveLive && !followLive && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsPlaying(false);
                      setFollowLive(true);
                      void loadRunById(activeLiveRunId);
                    }}
                    className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/25"
                  >
                    <Radio className="h-3 w-3" />
                    {t.controls.followLive} (D{latestLiveDay})
                  </button>
                )}
              </div>
            )}

            {/* Spy toggle */}
            {canSpy && state && (
              <button
                type="button"
                onClick={() => setSpyMode((s) => !s)}
                className={`rounded border px-2.5 py-1 font-medium transition ${
                  spyMode
                    ? "border-rose-500/60 bg-rose-500/20 text-rose-200"
                    : "border-slate-700 bg-slate-800/70 text-slate-300 hover:bg-slate-800"
                } ${activeTourTarget === "spy" ? "ring-2 ring-rose-400/60" : ""}`}
              >
                {spyMode ? t.spyOn : t.spyOff}
              </button>
            )}

            {/* UI Language toggle (EN / TR) */}
            <button
              type="button"
              onClick={() => {
                const next: UiLang = uiLang === "en" ? "tr" : "en";
                setUiLang(next);
                saveUiLang(next);
              }}
              aria-label="Switch dashboard language"
              className="rounded border border-slate-700 bg-slate-800/70 px-2 py-1 font-mono text-[11px] text-slate-300 hover:border-slate-500 hover:text-slate-100"
            >
              {uiLang === "en" ? "EN / TR" : "TR / EN"}
            </button>

            {/* Onboarding Guide button (always available across Live, Replay, Static) */}
            <button
              type="button"
              onClick={() => {
                if (tourStep !== null) {
                  setTourStep(null);
                } else if (briefingOpen) {
                  setTourStep(0);
                } else {
                  setBriefingOpen(true);
                }
              }}
              aria-label={
                serverMode === "live"
                  ? "Open dashboard guide"
                  : "Open archive guide"
              }
              className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800/70 px-2.5 py-1 text-slate-200 transition hover:border-sky-500/50 hover:text-sky-200"
            >
              <HelpCircle className="h-3.5 w-3.5 text-sky-300" />
              {t.guideButton}
            </button>
          </div>
        </div>

        {/* Navigation tabs (shown when a run state is loaded) */}
        {state && (
          <div
            className={`mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 text-xs ${
              activeTourTarget === "tabs" ? "rounded ring-1 ring-emerald-400/50" : ""
            }`}
          >
            {(
              [
                ["overview", t.tabs.overview],
                ["social", t.tabs.social],
                ["elections", t.tabs.elections],
                ["government", t.tabs.government],
                ["charts", t.tabs.charts],
                ["culture", t.tabs.culture],
                ["events", t.tabs.events],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
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
        )}
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-4">
        {/* Background live notification strip when inspecting a different run */}
        {serverMode === "live" &&
          activeLiveRunId &&
          activeLiveRunId !== selectedRunId && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-100">
              <div className="flex items-center gap-2">
                <Radio className="h-3.5 w-3.5 text-emerald-400" />
                <span>
                  {t.controls.liveInBackground}:{" "}
                  <strong className="font-mono">{activeLiveRunId}</strong>
                </span>
              </div>
              <button
                type="button"
                onClick={handleReturnToLive}
                className="rounded border border-emerald-400/50 bg-emerald-500/20 px-2.5 py-1 font-medium text-emerald-100 hover:bg-emerald-500/30"
              >
                {t.controls.returnToLive}
              </button>
            </div>
          )}

        {/* Action error feedback */}
        {actionError && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{actionError}</span>
            </div>
            <button
              type="button"
              onClick={() => setActionError(null)}
              aria-label="Dismiss error"
              className="rounded p-1 text-rose-300 hover:bg-rose-500/20"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Resume conflict confirmation banner */}
        {resumeConflict && (
          <div className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-100 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-amber-200">
                <AlertTriangle className="h-4 w-4" />
                <span>{t.newRunModal.confirmResumeConflictTitle}</span>
              </div>
              <p className="text-amber-100/90">
                {t.newRunModal.confirmResumeConflictBody(
                  resumeConflict.activeRunId,
                  resumeConflict.targetRunId
                )}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setResumeConflict(null)}
                className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-slate-200 hover:bg-slate-700"
              >
                {t.newRunModal.cancel}
              </button>
              <button
                type="button"
                onClick={() =>
                  void handleResumeRun(resumeConflict.targetRunId, {
                    days: resumeConflict.days,
                    stopActive: true,
                  })
                }
                className="rounded border border-amber-500/50 bg-amber-500/25 px-3 py-1.5 font-medium text-amber-100 hover:bg-amber-500/35"
              >
                {t.newRunModal.confirmStopAndResume}
              </button>
            </div>
          </div>
        )}

        {/* Unified Mode-Aware Onboarding */}
        <DashboardOnboarding
          mode={serverMode}
          lang={uiLang}
          selectedRunId={selectedRunId}
          runsCount={runs.length}
          currentDay={currentDay}
          targetDays={targetDays}
          availableDays={availableDays}
          state={state}
          events={events}
          stats={stats}
          noPrivate={Boolean(embedded?.noPrivate)}
          showBriefing={briefingOpen}
          tourStep={tourStep}
          onDismissBriefing={() => {
            setBriefingOpen(false);
            saveOnboardingDismissed(serverMode);
          }}
          onStartTour={() => {
            setBriefingOpen(false);
            saveOnboardingDismissed(serverMode);
            if (state) setActiveTab("overview");
            setTourStep(0);
          }}
          onStepChange={(next) => {
            setTourStep(next);
            if (next === null) saveOnboardingDismissed(serverMode);
          }}
          onJumpTo={(day, tab) => {
            setIsPlaying(false);
            if (isViewingActiveLive) setFollowLive(false);
            setReplayDay(day);
            if (tab) setActiveTab(tab);
          }}
          onSelectTab={(tab) => {
            if (tab && state) setActiveTab(tab);
          }}
          onOpenNewRun={
            serverMode === "live" ? () => setNewRunModalOpen(true) : undefined
          }
        />

        {/* Run Health (shown in Live mode whenever a run exists or is initializing) */}
        {serverMode === "live" && (selectedRunId || isViewingActiveLive) && (
          <RunHealthPanel
            health={health}
            lang={uiLang}
            currentDay={currentDay}
            targetDays={targetDays}
            currentPhase={phase}
            status={metadata?.status}
            isPaused={isPausedLive}
            isStopping={isStoppingLive}
            highlightTour={activeTourTarget === "health"}
          />
        )}

        {/* Empty workspace state or Genesis-in-progress state */}
        {!state ? (
          selectedRunId ? (
            <section className="rounded-lg border border-slate-800 bg-[#12161f] p-6 text-xs">
              <h2 className="text-sm font-semibold text-slate-100">
                {t.emptyState.initializingTitle}
              </h2>
              <p className="mt-1 max-w-2xl leading-relaxed text-slate-300">
                {t.emptyState.initializingBody}
              </p>
              {events.length > 0 && (
                <div className="mt-4 max-h-48 overflow-y-auto rounded border border-slate-800 bg-[#0b0e14] p-3 font-mono text-[11px] text-slate-300 space-y-1">
                  {events.slice(-15).map((ev) => (
                    <div key={ev.id}>
                      [D{ev.day} {ev.phase}] {ev.type} {ev.actor ?? ""}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <section className="rounded-lg border border-slate-800 bg-[#12161f] p-8 text-left">
              <h2 className="text-base font-semibold text-slate-100">
                {t.emptyState.title}
              </h2>
              <p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-300">
                {t.emptyState.body}
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2.5 text-xs">
                {serverMode === "live" && (
                  <button
                    type="button"
                    onClick={() => setNewRunModalOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded border border-emerald-500/50 bg-emerald-500/20 px-3.5 py-2 font-medium text-emerald-100 hover:bg-emerald-500/30"
                  >
                    <Plus className="h-4 w-4" />
                    {t.emptyState.ctaStart}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setBriefingOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-slate-800/70 px-3.5 py-2 text-slate-200 hover:bg-slate-800"
                >
                  <HelpCircle className="h-4 w-4 text-sky-300" />
                  {t.emptyState.ctaGuide}
                </button>
              </div>
            </section>
          )
        ) : (
          <>
            {activeTab === "overview" && (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                <div
                  className={`lg:col-span-7 space-y-4 rounded-lg transition ${
                    activeTourTarget === "map" ? "ring-2 ring-amber-400/50" : ""
                  }`}
                >
                  <AldoriaMap
                    state={state}
                    selectedRegionId={selectedRegionId}
                    selectedAgentId={selectedAgentId}
                    educationDays={educationDays}
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

            {activeTab === "charts" && (
              <ChartsPanel stats={visibleStats} state={state} />
            )}

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
                events={visibleEvents}
                state={state}
                spyMode={spyMode && canSpy}
              />
            )}
          </>
        )}
      </main>

      {/* New Simulation Modal */}
      {newRunModalOpen && (
        <NewRunModal
          open={newRunModalOpen}
          lang={uiLang}
          defaults={configDefaults}
          activeLiveRunId={activeLiveRunId}
          onClose={() => setNewRunModalOpen(false)}
          onCreated={(newRunId) => {
            setNewRunModalOpen(false);
            setFollowLive(true);
            setIsPlaying(false);
            setSelectedRunId(newRunId);
            setActiveLiveRunId(newRunId);
            void Promise.all([loadRunById(newRunId), refreshRunsAndDefaults()]);
          }}
        />
      )}
    </div>
  );
};
