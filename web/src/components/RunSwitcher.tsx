import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Layers, Play, Plus, Radio, Search } from "lucide-react";
import type { RunSummaryInfo } from "../../../contracts/stream.ts";
import { UI_STRINGS, type UiLang } from "../i18n.ts";

interface RunSwitcherProps {
  lang: UiLang;
  serverMode: "live" | "replay" | "static";
  runs: RunSummaryInfo[];
  selectedRunId: string | null;
  activeLiveRunId: string | null;
  highlightTour?: boolean;
  onSelectRun: (runId: string) => void;
  onResumeRun: (runId: string) => void;
  onOpenNewRun: () => void;
}

type RunFilter = "all" | "active" | "completed";

export const RunSwitcher: React.FC<RunSwitcherProps> = ({
  lang,
  serverMode,
  runs,
  selectedRunId,
  activeLiveRunId,
  highlightTour = false,
  onSelectRun,
  onResumeRun,
  onOpenNewRun,
}) => {
  const t = UI_STRINGS[lang];
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<RunFilter>("all");
  const [search, setSearch] = useState("");
  const [mobileTop, setMobileTop] = useState<number>(88);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const updateTop = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) setMobileTop(Math.round(rect.bottom + 8));
    };
    updateTop();
    window.addEventListener("resize", updateTop);
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("resize", updateTop);
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const currentRun = useMemo(
    () => runs.find((r) => r.runId === selectedRunId) ?? null,
    [runs, selectedRunId]
  );

  const filteredRuns = useMemo(() => {
    const q = search.trim().toLowerCase();
    return runs.filter((r) => {
      if (filter === "active") {
        if (r.status === "completed") return false;
      } else if (filter === "completed") {
        if (r.status !== "completed") return false;
      }
      if (!q) return true;
      return (
        r.runId.toLowerCase().includes(q) ||
        String(r.seed).includes(q) ||
        r.promptVariant.toLowerCase().includes(q) ||
        r.language.toLowerCase().includes(q) ||
        r.modelId.toLowerCase().includes(q)
      );
    });
  }, [runs, filter, search]);

  const statusTone = (run: RunSummaryInfo) => {
    if (run.isStopping) {
      return "border-amber-500/40 bg-amber-500/15 text-amber-200";
    }
    if (run.isActiveLive && !run.isPausedInMemory && run.status === "running") {
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
    }
    if (run.status === "paused" || run.isPausedInMemory || run.status === "initialized") {
      return "border-amber-500/40 bg-amber-500/15 text-amber-200";
    }
    if (run.status === "budget_stopped") {
      return "border-orange-500/40 bg-orange-500/15 text-orange-200";
    }
    if (run.status === "failed") {
      return "border-rose-500/40 bg-rose-500/15 text-rose-200";
    }
    return "border-sky-500/35 bg-sky-500/10 text-sky-300";
  };

  const statusText = (run: RunSummaryInfo) => {
    if (run.isStopping) return t.statusLabels.stopping;
    if (run.isActiveLive && run.isPausedInMemory) return t.statusLabels.paused;
    return t.statusLabels[run.status] ?? run.status;
  };

  if (serverMode === "static") return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={t.switcher.buttonLabel}
        className={`inline-flex items-center gap-2 rounded border bg-[#12161f] px-2.5 py-1 text-xs text-slate-200 transition hover:border-slate-600 ${
          highlightTour
            ? "border-sky-400 ring-2 ring-sky-400/50"
            : "border-slate-700/80"
        }`}
      >
        <Layers className="h-3.5 w-3.5 text-sky-300" />
        <span className="max-w-[14rem] truncate font-mono text-[11px] text-slate-100">
          {selectedRunId ?? t.switcher.buttonLabel}
        </span>
        {currentRun && (
          <span className="hidden font-mono text-[11px] tabular-nums text-slate-400 sm:inline">
            D{currentRun.currentDay}/{currentRun.targetDays}
          </span>
        )}
        {runs.length > 1 && (
          <span className="rounded bg-slate-800 px-1.5 py-0.2 font-mono text-[10px] text-slate-400">
            {runs.length}
          </span>
        )}
        <ChevronDown
          className={`h-3.5 w-3.5 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t.switcher.buttonLabel}
          style={{ "--switcher-top": `${mobileTop}px` } as React.CSSProperties}
          className="fixed left-3 right-3 top-[var(--switcher-top)] z-40 overflow-hidden rounded-lg border border-slate-700 bg-[#12161f] shadow-2xl sm:absolute sm:left-0 sm:right-auto sm:top-full sm:mt-2 sm:w-[28rem]"
        >
          <div className="border-b border-slate-800 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-100">
                {t.switcher.buttonLabel} ({runs.length})
              </span>
              {serverMode === "live" && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpenNewRun();
                  }}
                  className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/25"
                >
                  <Plus className="h-3 w-3" />
                  {t.controls.newSim}
                </button>
              )}
            </div>

            {runs.length > 0 && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t.switcher.searchPlaceholder}
                    className="w-full rounded border border-slate-700 bg-[#0b0e14] py-1 pl-7 pr-2 text-xs text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1 text-[11px]">
                  {(
                    [
                      ["all", t.switcher.allRuns],
                      ["active", t.switcher.liveRuns],
                      ["completed", t.switcher.completedRuns],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setFilter(key)}
                      className={`rounded px-2 py-1 transition ${
                        filter === key
                          ? "bg-slate-800 text-slate-100"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-slate-800/70">
            {runs.length === 0 ? (
              <div className="p-4 text-xs text-slate-400">
                <p className="font-medium text-slate-200">{t.switcher.emptyTitle}</p>
                <p className="mt-1 leading-relaxed">{t.switcher.emptyBody}</p>
              </div>
            ) : filteredRuns.length === 0 ? (
              <div className="p-4 text-xs text-slate-400">{t.switcher.noMatches}</div>
            ) : (
              filteredRuns.map((run) => {
                const isSelected = run.runId === selectedRunId;
                const isBgActive = run.runId === activeLiveRunId;
                const canResumeFromDisk =
                  serverMode === "live" &&
                  !run.isActiveLive &&
                  run.status !== "completed" &&
                  run.currentDay < run.targetDays;
                const canResumeInMem =
                  serverMode === "live" && run.isActiveLive && run.isPausedInMemory;

                return (
                  <div
                    key={run.runId}
                    className={`flex items-start justify-between gap-2 p-2.5 transition ${
                      isSelected ? "bg-slate-800/60" : "hover:bg-slate-800/30"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelectRun(run.runId);
                        setOpen(false);
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        {isBgActive && (
                          <Radio className="h-3 w-3 shrink-0 text-emerald-400" />
                        )}
                        <span className="truncate font-mono text-xs font-medium text-slate-100">
                          {run.runId}
                        </span>
                        <span
                          className={`rounded border px-1.5 py-0.2 text-[10px] font-medium ${statusTone(run)}`}
                        >
                          {statusText(run)}
                        </span>
                        {run.ventrianaExists && (
                          <span className="rounded border border-rose-500/35 bg-rose-500/10 px-1.5 py-0.2 text-[10px] text-rose-200">
                            {t.switcher.sovereignTag}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400">
                        <span className="font-mono tabular-nums text-slate-300">
                          {t.switcher.dayProgress(run.currentDay, run.targetDays)}
                        </span>
                        <span>s{run.seed}</span>
                        <span>{run.language.toUpperCase()}</span>
                        <span>{run.promptVariant}</span>
                        <span>{run.mockLlm ? "Mock" : run.modelId}</span>
                        {run.livingAgents !== null && (
                          <span>
                            {run.livingAgents} {t.switcher.livingSuffix}
                          </span>
                        )}
                      </div>
                    </button>

                    {(canResumeFromDisk || canResumeInMem) && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(false);
                          onResumeRun(run.runId);
                        }}
                        className="shrink-0 inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/15 px-2 py-1 text-[11px] font-medium text-sky-200 hover:bg-sky-500/25"
                      >
                        <Play className="h-3 w-3" />
                        {t.switcher.resumeAction}
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
