import React from "react";
import type { RunHealthStats } from "../../../contracts/stream.ts";

interface RunHealthPanelProps {
  health: RunHealthStats;
}

export const RunHealthPanel: React.FC<RunHealthPanelProps> = ({ health }) => {
  const eta =
    health.estimatedSecondsRemaining !== null
      ? `${Math.ceil(health.estimatedSecondsRemaining / 60)}m`
      : "—";

  return (
    <div className="rounded-lg border border-slate-800 bg-[#12161f] p-4 text-xs">
      <div className="mb-3 border-b border-slate-800 pb-2">
        <h3 className="text-sm font-semibold text-slate-100">
          Run Health (Live)
        </h3>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <Metric label="Calls / min" value={health.callsLastMinute} />
        <Metric label="Total calls" value={health.totalCalls} />
        <Metric label="Throttled" value={health.throttledCount} warn={health.throttledCount > 0} />
        <Metric label="429s" value={health.rateLimit429Count} warn={health.rateLimit429Count > 0} />
        <Metric label="Retries" value={health.retryCount} />
        <Metric label="Invalid JSON" value={health.invalidOutputCount} warn={health.invalidOutputCount > 0} />
        <Metric label="Safety blocks" value={health.safetyBlockCount} warn={health.safetyBlockCount > 0} />
        <Metric
          label="Tokens (in/out)"
          value={`${(health.promptTokensTotal / 1000).toFixed(1)}k / ${(health.completionTokensTotal / 1000).toFixed(1)}k (ETA ${eta})`}
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
    <div className={`mt-0.5 text-sm font-semibold ${warn ? "text-amber-300" : "text-slate-100"}`}>
      {value}
    </div>
  </div>
);
