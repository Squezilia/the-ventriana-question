import React, { useEffect, useState } from "react";
import { AlertTriangle, Dices, Play, X } from "lucide-react";
import type { ConfigDefaultsResponse, CreateRunRequest } from "../../../contracts/stream.ts";
import { UI_STRINGS, type UiLang } from "../i18n.ts";

interface NewRunModalProps {
  open: boolean;
  lang: UiLang;
  defaults: ConfigDefaultsResponse | null;
  activeLiveRunId: string | null;
  onClose: () => void;
  onCreated: (runId: string) => void;
}

export const NewRunModal: React.FC<NewRunModalProps> = ({
  open,
  lang,
  defaults,
  activeLiveRunId,
  onClose,
  onCreated,
}) => {
  const t = UI_STRINGS[lang];
  const [runId, setRunId] = useState("");
  const [seed, setSeed] = useState<number>(defaults?.seed ?? 42);
  const [days, setDays] = useState<number>(defaults?.days ?? 14);
  const [simLang, setSimLang] = useState<"en" | "tr">(defaults?.language ?? "en");
  const [promptVariant, setPromptVariant] = useState<string>(
    defaults?.promptVariant ?? "default"
  );
  const [mockLlm, setMockLlm] = useState<boolean>(
    defaults ? (defaults.hasGeminiKey ? defaults.mockLlm : true) : true
  );
  const [autoStart, setAutoStart] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [conflictRunId, setConflictRunId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRunId("");
    setErrorMsg(null);
    setConflictRunId(null);
    if (defaults) {
      setSeed(defaults.seed);
      setDays(defaults.days);
      setSimLang(defaults.language);
      setPromptVariant(defaults.promptVariant);
      setMockLlm(defaults.hasGeminiKey ? defaults.mockLlm : true);
    }
  }, [open, defaults]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  const variantsForLang = defaults?.availableVariants[simLang] ?? ["default"];

  const submitCreate = async (stopActive: boolean) => {
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const payload: CreateRunRequest = {
        ...(runId.trim() ? { runId: runId.trim() } : {}),
        seed,
        days,
        language: simLang,
        promptVariant,
        mockLlm,
        autoStart,
        stopActive,
      };
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.status === 409 && data.conflict) {
        setConflictRunId(data.activeRunId ?? activeLiveRunId ?? "active");
        setSubmitting(false);
        return;
      }
      if (!res.ok) {
        setErrorMsg(data.error ?? "Failed to create simulation.");
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      onCreated(data.run.runId);
    } catch {
      setErrorMsg("Network error while creating simulation.");
      setSubmitting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (activeLiveRunId && !conflictRunId) {
      setConflictRunId(activeLiveRunId);
      return;
    }
    void submitCreate(Boolean(conflictRunId));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.newRunModal.title}
        className="w-full max-w-lg overflow-hidden rounded-lg border border-slate-700 bg-[#12161f] shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              {t.newRunModal.title}
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              {t.newRunModal.subtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-5 text-xs">
          {/* Run ID */}
          <div>
            <label className="mb-1 block font-medium text-slate-300">
              {t.newRunModal.runIdLabel}
            </label>
            <input
              type="text"
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              placeholder={t.newRunModal.runIdPlaceholder}
              className="w-full rounded border border-slate-700 bg-[#0b0e14] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            />
          </div>

          {/* Seed & Days */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block font-medium text-slate-300">
                {t.newRunModal.seedLabel}
              </label>
              <div className="flex gap-1.5">
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value) || 0)}
                  className="w-full rounded border border-slate-700 bg-[#0b0e14] px-3 py-2 font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setSeed(Math.floor(Math.random() * 9000) + 100)}
                  title={t.newRunModal.randomizeSeed}
                  className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-2 text-slate-200 hover:bg-slate-700"
                >
                  <Dices className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1 block font-medium text-slate-300">
                {t.newRunModal.daysLabel}
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={days}
                  onChange={(e) =>
                    setDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))
                  }
                  className="w-full rounded border border-slate-700 bg-[#0b0e14] px-3 py-2 font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
                />
                {[3, 14, 56].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setDays(preset)}
                    className={`rounded border px-2 py-2 font-mono text-[11px] transition ${
                      days === preset
                        ? "border-sky-500/60 bg-sky-500/15 text-sky-200"
                        : "border-slate-700 bg-[#0b0e14] text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {preset}d
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Language & Prompt Variant */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block font-medium text-slate-300">
                {t.newRunModal.languageLabel}
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {(["en", "tr"] as const).map((code) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => {
                      setSimLang(code);
                      const avail = defaults?.availableVariants[code] ?? ["default"];
                      if (!avail.includes(promptVariant)) {
                        setPromptVariant(avail[0] ?? "default");
                      }
                    }}
                    className={`rounded border py-2 font-medium transition ${
                      simLang === code
                        ? "border-sky-500/60 bg-sky-500/15 text-sky-200"
                        : "border-slate-700 bg-[#0b0e14] text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {code === "en" ? "English (EN)" : "Türkçe (TR)"}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block font-medium text-slate-300">
                {t.newRunModal.variantLabel}
              </label>
              <select
                value={promptVariant}
                onChange={(e) => setPromptVariant(e.target.value)}
                className="w-full rounded border border-slate-700 bg-[#0b0e14] px-3 py-2 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
              >
                {variantsForLang.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* LLM Backend */}
          <div>
            <label className="mb-1 block font-medium text-slate-300">
              {t.newRunModal.backendLabel}
            </label>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setMockLlm(true)}
                className={`rounded border px-3 py-2 text-left transition ${
                  mockLlm
                    ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-200"
                    : "border-slate-700 bg-[#0b0e14] text-slate-400 hover:text-slate-200"
                }`}
              >
                {t.newRunModal.mockOption}
              </button>
              <button
                type="button"
                disabled={!defaults?.hasGeminiKey}
                onClick={() => setMockLlm(false)}
                className={`rounded border px-3 py-2 text-left transition ${
                  !mockLlm
                    ? "border-sky-500/60 bg-sky-500/15 text-sky-200"
                    : "border-slate-700 bg-[#0b0e14] text-slate-400 hover:text-slate-200"
                } ${!defaults?.hasGeminiKey ? "cursor-not-allowed opacity-45" : ""}`}
              >
                {t.newRunModal.geminiOption(defaults?.modelId ?? "gemini")}
              </button>
            </div>
            {!defaults?.hasGeminiKey && (
              <p className="mt-1 text-[11px] text-amber-300/90">
                {t.newRunModal.missingKeyHint}
              </p>
            )}
          </div>

          {/* Launch Mode */}
          <div>
            <label className="mb-1 block font-medium text-slate-300">
              {t.newRunModal.startModeLabel}
            </label>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setAutoStart(true)}
                className={`rounded border px-3 py-2 text-left transition ${
                  autoStart
                    ? "border-sky-500/60 bg-sky-500/15 text-sky-200"
                    : "border-slate-700 bg-[#0b0e14] text-slate-400 hover:text-slate-200"
                }`}
              >
                {t.newRunModal.startNow}
              </button>
              <button
                type="button"
                onClick={() => setAutoStart(false)}
                className={`rounded border px-3 py-2 text-left transition ${
                  !autoStart
                    ? "border-amber-500/60 bg-amber-500/15 text-amber-200"
                    : "border-slate-700 bg-[#0b0e14] text-slate-400 hover:text-slate-200"
                }`}
              >
                {t.newRunModal.startPaused}
              </button>
            </div>
          </div>

          {errorMsg && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200">
              {errorMsg}
            </div>
          )}

          {conflictRunId && (
            <div className="space-y-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-amber-100">
              <div className="flex items-center gap-1.5 font-semibold text-amber-200">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{t.newRunModal.conflictTitle}</span>
              </div>
              <p className="leading-relaxed text-amber-100/90">
                {t.newRunModal.conflictBody(conflictRunId)}
              </p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-slate-800 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-slate-700 bg-slate-800/70 px-3 py-1.5 text-slate-300 hover:bg-slate-800"
            >
              {t.newRunModal.cancel}
            </button>
            {conflictRunId ? (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void submitCreate(true)}
                className="inline-flex items-center gap-1.5 rounded border border-amber-500/50 bg-amber-500/20 px-3.5 py-1.5 font-medium text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                {submitting ? t.newRunModal.submitting : t.newRunModal.confirmStopAndStart}
              </button>
            ) : (
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-1.5 rounded border border-emerald-500/50 bg-emerald-500/20 px-3.5 py-1.5 font-medium text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                {submitting ? t.newRunModal.submitting : t.newRunModal.submit}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
