import React from "react";
import type { RunHealthStats } from "../../../contracts/stream.ts";
import type { PhaseName, RunMetadata } from "../../../contracts/types.ts";
import { UI_STRINGS, type UiLang } from "../i18n.ts";

interface RunHealthPanelProps {
  health: RunHealthStats;
  lang?: UiLang;
  currentDay?: number;
  targetDays?: number;
  currentPhase?: PhaseName;
  status?: RunMetadata["status"];
  isPaused?: boolean;
  isStopping?: boolean;
  highlightTour?: boolean;
}

const PHASES: readonly PhaseName[] = [
  "rollover",
  "morning",
  "local_chat",
  "evening",
  "end_of_day",
];

export const RunHealthPanel: React.FC<RunHealthPanelProps> = ({
  health,
  lang = "en",
  currentDay,
  targetDays,
  currentPhase,
  status,
  isPaused = false,
  isStopping = false,
  highlightTour = false,
}) => {
  const t = UI_STRINGS[lang];
  const eta =
    health.estimatedSecondsRemaining !== null
      ? `${Math.ceil(health.estimatedSecondsRemaining / 60)}m`
      : "—";
  const cachedTokens = health.cachedTokensTotal ?? 0;
  const cachePct =
    health.promptTokensTotal > 0
      ? Math.round((cachedTokens / health.promptTokensTotal) * 100)
      : 0;

  const activePhaseIdx = currentPhase ? PHASES.indexOf(currentPhase) : -1;
  const progressPct =
    currentDay !== undefined && targetDays && targetDays > 0
      ? Math.min(100, Math.round(((currentDay + (activePhaseIdx + 1) / PHASES.length) / targetDays) * 100))
      : null;

  return (
    <div
      className={`rounded-lg border bg-[#12161f] p-4 text-xs transition ${
        highlightTour ? "border-sky-400 ring-2 ring-sky-400/50" : "border-slate-800"
      }`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
        <div className="flex items-center gap-2.5">
          <h3 className="text-sm font-semibold text-slate-100">
            {lang === "tr" ? "Koşu Sağlığı (Canlı)" : "Run Health (Live)"}
          </h3>
          {status && (
            <span className="rounded border border-slate-700 bg-[#0b0e14] px-2 py-0.5 font-mono text-[11px] text-slate-300">
              {isStopping
                ? t.statusLabels.stopping
                : isPaused
                  ? t.statusLabels.paused
                  : t.statusLabels[status] ?? status}
            </span>
          )}
        </div>

        {currentPhase && (
          <div className="flex flex-wrap items-center gap-1">
            {PHASES.map((p, idx) => {
              const isCurrent = p === currentPhase;
              const isDone = activePhaseIdx > idx;
              return (
                <span
                  key={p}
                  className={`rounded px-2 py-0.5 text-[11px] transition ${
                    isCurrent
                      ? "border border-emerald-500/50 bg-emerald-500/15 font-medium text-emerald-200"
                      : isDone
                        ? "bg-slate-800/80 text-slate-300"
                        : "bg-[#0b0e14] text-slate-500"
                  }`}
                >
                  {t.phases[p]}
                </span>
              );
            })}
            {progressPct !== null && (
              <span className="ml-1 font-mono text-[11px] tabular-nums text-slate-400">
                {progressPct}%
              </span>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-9">
        <Metric label={lang === "tr" ? "Çağrı / dk" : "Calls / min"} value={health.callsLastMinute} />
        <Metric label={lang === "tr" ? "Toplam çağrı" : "Total calls"} value={health.totalCalls} />
        <Metric
          label={lang === "tr" ? "Kısıtlanan" : "Throttled"}
          value={health.throttledCount}
          warn={health.throttledCount > 0}
        />
        <Metric
          label="429s"
          value={health.rateLimit429Count}
          warn={health.rateLimit429Count > 0}
        />
        <Metric label={lang === "tr" ? "Tekrar" : "Retries"} value={health.retryCount} />
        <Metric
          label={lang === "tr" ? "Geçersiz JSON" : "Invalid JSON"}
          value={health.invalidOutputCount}
          warn={health.invalidOutputCount > 0}
        />
        <Metric
          label={lang === "tr" ? "Güvenlik engeli" : "Safety blocks"}
          value={health.safetyBlockCount}
          warn={health.safetyBlockCount > 0}
        />
        <Metric
          label={lang === "tr" ? "Token (girdi/çıktı)" : "Tokens (in/out)"}
          value={`${(health.promptTokensTotal / 1000).toFixed(1)}k / ${(health.completionTokensTotal / 1000).toFixed(1)}k (ETA ${eta})`}
        />
        <Metric
          label={lang === "tr" ? "Önbellek" : "Cached prompt"}
          value={`${(cachedTokens / 1000).toFixed(1)}k (${cachePct}%)`}
        />
      </div>
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string | number; warn?: boolean }> = ({
  label,
  value,
  warn,
}) => (
  <div className="rounded border border-slate-800 bg-[#0b0e14] p-2">
    <div className="text-[11px] text-slate-400">{label}</div>
    <div className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${warn ? "text-amber-300" : "text-slate-100"}`}>
      {value}
    </div>
  </div>
);
