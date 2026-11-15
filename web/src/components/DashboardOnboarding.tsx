import React, { useMemo } from "react";
import {
  Activity,
  BookOpen,
  Compass,
  Eye,
  EyeOff,
  Layers,
  Map,
  Play,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import type { SimEvent } from "../../../contracts/events.ts";
import type { DailyMetricsRow, WorldState } from "../../../contracts/types.ts";
import type { UiLang } from "../i18n.ts";

export type OnboardingTarget =
  | "timeline"
  | "switcher"
  | "controls"
  | "health"
  | "map"
  | "spy"
  | "tabs"
  | "government";

export interface MilestoneJump {
  label: string;
  day: number;
  tab?: "overview" | "social" | "elections" | "government" | "charts" | "culture" | "events";
}

interface DashboardOnboardingProps {
  mode: "live" | "replay" | "static";
  lang: UiLang;
  selectedRunId: string | null;
  runsCount: number;
  currentDay: number;
  targetDays?: number;
  availableDays: number[];
  state: WorldState | null;
  events: SimEvent[];
  stats: DailyMetricsRow[];
  noPrivate: boolean;
  showBriefing: boolean;
  tourStep: number | null;
  onDismissBriefing: () => void;
  onStartTour: () => void;
  onStepChange: (step: number | null) => void;
  onJumpTo: (day: number, tab?: MilestoneJump["tab"]) => void;
  onSelectTab?: (tab: MilestoneJump["tab"]) => void;
  onOpenNewRun?: () => void;
}

interface TourStepDef {
  id: OnboardingTarget;
  badge: string;
  title: string;
  body: string;
  tip: string;
  targetTab?: MilestoneJump["tab"];
}

export const DashboardOnboarding: React.FC<DashboardOnboardingProps> = ({
  mode,
  lang,
  selectedRunId,
  runsCount,
  currentDay,
  targetDays,
  availableDays,
  state,
  events,
  stats,
  noPrivate,
  showBriefing,
  tourStep,
  onDismissBriefing,
  onStartTour,
  onStepChange,
  onJumpTo,
  onSelectTab,
  onOpenNewRun,
}) => {
  const isTr = lang === "tr";
  const minDay = availableDays[0] ?? 0;
  const maxDay = availableDays[availableDays.length - 1] ?? currentDay;

  const milestones = useMemo<MilestoneJump[]>(() => {
    if (mode === "live") return [];
    const out: MilestoneJump[] = [];
    const seenDays = new Set<string>();

    const pushUnique = (item: MilestoneJump) => {
      const k = `${item.label}:${item.day}`;
      if (!seenDays.has(k)) {
        seenDays.add(k);
        out.push(item);
      }
    };

    const indepEv = events.find(
      (e) => e.type === "independence_declared" && e.payload.succeeded
    );
    if (indepEv) {
      pushUnique({
        label: isTr
          ? `Ventriana Bağımsızlığı · Gün ${indepEv.day}`
          : `Ventriana Independence · Day ${indepEv.day}`,
        day: indepEv.day,
        tab: "overview",
      });
    }

    const currEv = events.find((e) => e.type === "curriculum_changed");
    if (currEv) {
      pushUnique({
        label: isTr
          ? `Müfredat Değişikliği · Gün ${currEv.day}`
          : `Curriculum Rewrite · Day ${currEv.day}`,
        day: currEv.day,
        tab: "government",
      });
    }

    const elecEv = events.find((e) => e.type === "election_completed");
    if (elecEv) {
      pushUnique({
        label: isTr
          ? `Seçim Sonucu · Gün ${elecEv.day}`
          : `Election Result · Day ${elecEv.day}`,
        day: elecEv.day,
        tab: "elections",
      });
    }

    if (out.length === 0) {
      pushUnique({
        label: isTr ? `Başlangıç · Gün ${minDay}` : `Genesis · Day ${minDay}`,
        day: minDay,
        tab: "overview",
      });
      if (maxDay > minDay) {
        pushUnique({
          label: isTr ? `Son Kayıt · Gün ${maxDay}` : `Latest Snapshot · Day ${maxDay}`,
          day: maxDay,
          tab: "overview",
        });
      }
    }

    return out.slice(0, 3);
  }, [mode, events, minDay, maxDay, isTr]);

  const tourSteps: TourStepDef[] = useMemo(() => {
    if (mode === "live") {
      if (isTr) {
        return [
          {
            id: "switcher",
            badge: "Adım 1 / 5 · Simülasyonlar",
            title: "Simülasyonlar arasında geçiş yapın",
            body: "Üst bardaki simülasyon seçiciden kayıtlı tüm koşuları inceleyebilir, tamamlanmış arşivlere göz atabilir veya + Yeni Simülasyon ile farklı seed/dil ayarlarıyla yeni bir dünya başlatabilirsiniz.",
            tip: "Başka bir simülasyonu incelerken çalışan canlı simülasyon arka planda güvenle akmaya devam eder.",
            targetTab: "overview",
          },
          {
            id: "controls",
            badge: "Adım 2 / 5 · Canlı Kontrol",
            title: "Başlatma, Duraklatma, Durdurma ve Devam Ettirme",
            body: "Çalışan bir simülasyonu Duraklat ile bekletebilir, Faz İlerlet ile tek faz adım adım çalıştırabilir, Durdur ile checkpoint alıp slotu boşaltabilirsiniz. Durdurulmuş koşular Devam Et ile kaldığı günden sürer.",
            tip: "Canlı akış sırasında geçmiş günlere göz atarsanız üstteki Canlıya Dön butonuyla anlık akışı yeniden yakalarsınız.",
            targetTab: "overview",
          },
          {
            id: "health",
            badge: "Adım 3 / 5 · Sağlık & Fazlar",
            title: "Günlük 5 fazı ve API sağlığını izleyin",
            body: "Koşu Sağlığı paneli gün içindeki 5 fazı (Gün Geçişi → Sabah → Bölge Sohbeti → Akşam → Gün Sonu), dakikalık çağrı hızını, önbellek oranını ve tahmini süreyi gösterir.",
            tip: "Mock LLM ile anlık ücretsiz deneme yapabilir veya .env içindeki Gemini anahtarıyla gerçek ajanları izleyebilirsiniz.",
            targetTab: "overview",
          },
          {
            id: "map",
            badge: "Adım 4 / 5 · Harita & Vatandaşlar",
            title: "Dokuz bölgeyi ve 27 vatandaşı keşfedin",
            body: "Haritadaki herhangi bir bölgeye tıklayarak meydan sohbetini ve nüfus listesini açın; bir vatandaş noktasına tıklayarak yaşam öyküsünü, günlüğünü, oylarını ve vasiyetini okuyun.",
            tip: "Kesik halkalı noktalar devletsiz Ventriana halkını, küçük noktalar ise eğitim çağındaki gençleri gösterir.",
            targetTab: "overview",
          },
          {
            id: "spy",
            badge: "Adım 5 / 5 · Casus Modu & Tarih",
            title: "İç sesleri ve yeniden yazılan müfredatı yakalayın",
            body: "Sağ üstteki Casus (Spy) düğmesini açarak liderlerin gizli düşüncelerini (private_thought) ve özel mesajlarını (DM) herkese açık sözleriyle karşılaştırın. Hükümet & Müfredat sekmesinde okul kitaplarındaki kelime farklarını görün.",
            tip: "Bir başkan seçildikten sonra okul müfredatını değiştirdiğinde bir sonraki nesil bu yeni tarihle büyür.",
            targetTab: "government",
          },
        ];
      }

      return [
        {
          id: "switcher",
          badge: "Step 1 of 5 · Switcher",
          title: "Switch between simulations anytime",
          body: "Open the simulation switcher in the header to inspect any stored run, compare seeds or prompt variants, or click New simulation to launch a fresh Aldoria timeline.",
          tip: "Inspecting an archived run keeps any active live simulation running safely in the background.",
          targetTab: "overview",
        },
        {
          id: "controls",
          badge: "Step 2 of 5 · Live Controls",
          title: "Start, Pause, Step, Stop & Resume",
          body: "Pause holds before the next phase, Step phase advances one deterministic phase at a time, and Stop saves a clean checkpoint and frees the live slot. Any paused or stopped run can be Resumed from disk.",
          tip: "If you scrub back to inspect an earlier day while live, click Follow Live in the bar to snap back to the current phase.",
          targetTab: "overview",
        },
        {
          id: "health",
          badge: "Step 3 of 5 · Run Health",
          title: "Track the 5-phase daily cycle & API limits",
          body: "Run Health displays the current daily phase (Rollover, Morning, Local Chat, Evening, End of Day), calls per minute, prompt cache hit rate, retries, and token totals.",
          tip: "Use Mock LLM for instant deterministic dry runs, or Gemini when GEMINI_API_KEY is configured.",
          targetTab: "overview",
        },
        {
          id: "map",
          badge: "Step 4 of 5 · Cartography",
          title: "Inspect the Nine Regions & Citizen Nodes",
          body: "Click any region to open its local square chat and roster, or select any citizen dot to read their worldview, diary, moves, votes, and inheritance will.",
          tip: "Dashed rings mark Ventrian citizens, smaller dots mark young citizens in education, and * marks former Ventriana territory.",
          targetTab: "overview",
        },
        {
          id: "spy",
          badge: "Step 5 of 5 · Spy & Curriculum",
          title: "Compare public speech against private schemes",
          body: "Toggle Spy mode in the header to expose each citizen's private_thought monologues and encrypted DMs, then check Government & Curriculum to view word-level textbook rewrites.",
          tip: "Every newly educated generation forms its worldview from the curriculum in force when they come of age.",
          targetTab: "government",
        },
      ];
    }

    // Replay / Static mode (preserving existing 4-step tour structure)
    if (isTr) {
      return [
        {
          id: "timeline",
          badge: "Adım 1 / 4 · Zaman Çizelgesi",
          title: "Tarihi gün gün ileri geri sarın",
          body: "Üstteki gün kaydırıcısını, Oynat butonunu veya klavye kısayollarını (Sol/Sağ oklar ve Boşluk) kullanarak sınırların, nüfusun ve ittifakların değişimini izleyin.",
          tip: "Tüm grafikler ve olay günlükleri seçtiğiniz güne göre otomatik filtrelenir.",
          targetTab: "overview",
        },
        {
          id: "map",
          badge: "Adım 2 / 4 · Harita",
          title: "Dokuz bölgeyi ve vatandaş düğümlerini okuyun",
          body: "Herhangi bir bölgeye tıklayarak meydan sohbetini açın veya bir vatandaş noktasına tıklayıp günlüğünü, bölge geçmişini ve vasiyetini inceleyin.",
          tip: "Kesik halkalar Ventriana halkını, küçük noktalar eğitimdeki çocukları ve * eski Ventriana topraklarını gösterir.",
          targetTab: "overview",
        },
        {
          id: "spy",
          badge: "Adım 3 / 4 · Açık vs. Gizli",
          title: noPrivate ? "Gizlilik Korumalı Dışa Aktarım" : "Söylemler ile İç Dünyayı Karşılaştırın",
          body: noPrivate
            ? "Bu arşiv --no-private ile dışa aktarılmıştır; gizli düşünceler ve DM'ler çıkarılmıştır."
            : "Sağ üstteki Casus (Spy) modunu açarak vatandaşların gizli düşüncelerini (private_thought) ve özel mesajlarını herkese açık mesajlarıyla yan yana görün.",
          tip: noPrivate
            ? "Gizli içeriklerle incelemek için replay-build komutunu --no-private olmadan çalıştırın."
            : "Liderlerin açık akışta söyledikleriyle özel mesajlarda planladıkları arasındaki farklara dikkat edin.",
          targetTab: "social",
        },
        {
          id: "government",
          badge: "Adım 4 / 4 · Hafıza & Metrikler",
          title: "Değişen müfredatları ve dağılımı inceleyin",
          body: "Seçilen başkanlar okul kitaplarını yeniden yazabilir, sınırları kapatabilir, sansür uygulayabilir veya ulusal marş seçebilir. Hükümet & Müfredat ve Grafikler sekmelerine göz atın.",
          tip: "Yeşil ve kırmızı vurgular ardışık okul müfredatları arasındaki kelime farklarını gösterir.",
          targetTab: "government",
        },
      ];
    }

    return [
      {
        id: "timeline",
        badge: "Step 1 of 4 · Timeline",
        title: "Scrub history day by day",
        body: "Use the header day slider, Play button, or keyboard shortcuts (Left/Right arrows to step, Space to play/pause) to watch borders, populations, and alliances shift over time.",
        tip: "All charts and event logs automatically sync to the day you are inspecting.",
        targetTab: "overview",
      },
      {
        id: "map",
        badge: "Step 2 of 4 · Cartography",
        title: "Read the Nine Regions & Citizen Nodes",
        body: "Click any region to open its square chat and roster, or select any citizen dot to read their life history, diary, regional moves, and inheritance will.",
        tip: "Dashed rings mark Ventrian citizens, smaller dots mark young citizens in education, and * marks former Ventriana territory.",
        targetTab: "overview",
      },
      {
        id: "spy",
        badge: "Step 3 of 4 · Public vs. Private",
        title: noPrivate ? "Privacy Redaction Active" : "Compare Speech vs. Inner Thought",
        body: noPrivate
          ? "This archive was exported with --no-private: private thoughts and direct messages are stripped so public diplomacy, votes, and works can be shared safely."
          : "Toggle Spy mode in the top-right to reveal each citizen's private inner monologue (private_thought) and encrypted Direct Messages alongside their public statements.",
        tip: noPrivate
          ? "Re-run `replay-build` without `--no-private` if you want full introspective dossiers."
          : "Look for divergences between what leaders promise on the feed and what they scheme in private.",
        targetTab: "social",
      },
      {
        id: "government",
        badge: "Step 4 of 4 · Memory & Metrics",
        title: "Inspect Rewritten Curricula & Dispersion",
        body: "Winning presidents can rewrite school textbooks, close regional borders, censor posts, or adopt anthems. Switch to Government & Curriculum or Charts to compare generational memory edits against dispersion trends.",
        tip: "Green and rose highlights show inline word-level edits across successive school curricula.",
        targetTab: "government",
      },
    ];
  }, [mode, isTr, noPrivate]);

  const livingCount = useMemo(
    () => (state ? Object.values(state.agents).filter((a) => a.alive).length : 0),
    [state]
  );
  const lastStat = stats[stats.length - 1];
  const independenceOccurred = useMemo(
    () =>
      events.some(
        (e) => e.type === "independence_declared" && e.payload.succeeded
      ),
    [events]
  );

  const activeTourStep = tourStep !== null ? tourSteps[tourStep] ?? null : null;

  const stepIcon = (target: OnboardingTarget) => {
    switch (target) {
      case "switcher":
        return <Layers className="h-4 w-4 text-sky-300" />;
      case "controls":
        return <Play className="h-4 w-4 text-emerald-300" />;
      case "health":
        return <Activity className="h-4 w-4 text-emerald-300" />;
      case "timeline":
        return <Compass className="h-4 w-4 text-sky-300" />;
      case "map":
        return <Map className="h-4 w-4 text-amber-300" />;
      case "spy":
        return noPrivate ? (
          <EyeOff className="h-4 w-4 text-slate-300" />
        ) : (
          <Eye className="h-4 w-4 text-rose-300" />
        );
      case "government":
        return <BookOpen className="h-4 w-4 text-emerald-300" />;
      default:
        return <Sparkles className="h-4 w-4 text-sky-300" />;
    }
  };

  const applyStepTarget = (nextIdx: number) => {
    onStepChange(nextIdx);
    const tab = tourSteps[nextIdx]?.targetTab;
    if (tab) {
      if (mode === "live" && onSelectTab) {
        onSelectTab(tab);
      } else {
        onJumpTo(currentDay, tab);
      }
    }
  };

  const briefingAriaLabel =
    mode === "live"
      ? isTr
        ? "Canlı kontrol brifingi"
        : "Live dashboard briefing"
      : isTr
        ? "Tekrar arşiv brifingi"
        : "Replay archive briefing";

  const tourAriaLabel =
    mode === "live"
      ? isTr
        ? "Canlı dashboard rehber turu"
        : "Live dashboard guided tour"
      : isTr
        ? "Tekrar rehber turu"
        : "Replay guided tour";

  return (
    <>
      {/* Non-blocking Briefing Strip */}
      {showBriefing && tourStep === null && (
        <section
          aria-label={briefingAriaLabel}
          className="relative overflow-hidden rounded-lg border border-slate-700/80 bg-[#12161f]/95 shadow-lg"
        >
          <div
            className="h-0.5 w-full"
            style={{
              background:
                "linear-gradient(90deg, #38bdf8 0%, #f59e0b 50%, #fb7185 100%)",
            }}
          />
          <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 font-medium text-sky-300">
                  <Sparkles className="h-3 w-3" />
                  {mode === "live"
                    ? isTr
                      ? "Canlı Kontrol Brifingi"
                      : "Live Control Briefing"
                    : isTr
                      ? "Arşiv Brifingi"
                      : "Archive Briefing"}
                </span>
                <span className="text-slate-400">
                  {mode === "live" ? (
                    <>
                      {selectedRunId ? (
                        <span className="font-mono text-slate-300">{selectedRunId}</span>
                      ) : isTr ? (
                        "Yeni oturuma hazır"
                      ) : (
                        "Ready for a new run"
                      )}
                      {state && (
                        <>
                          {" · "}
                          {isTr ? `Gün ${currentDay}` : `Day ${currentDay}`}
                          {targetDays ? `/${targetDays}` : ""}
                          {" · "}
                          {isTr
                            ? `${livingCount} vatandaş hayatta`
                            : `${livingCount} citizens living`}
                        </>
                      )}
                      {runsCount > 0 && (
                        <>
                          {" · "}
                          {isTr
                            ? `${runsCount} kayıtlı simülasyon`
                            : `${runsCount} stored runs`}
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      {minDay === maxDay
                        ? isTr
                          ? `Gün ${minDay}`
                          : `Day ${minDay}`
                        : isTr
                          ? `Gün ${minDay}–${maxDay}`
                          : `Days ${minDay}–${maxDay}`}
                      {state && (
                        <>
                          {" · "}
                          {isTr
                            ? `${livingCount} vatandaş hayatta`
                            : `${livingCount} citizens living`}
                        </>
                      )}
                      {lastStat
                        ? isTr
                          ? ` · ${stats.length} günlük kayıt`
                          : ` · ${stats.length} daily checkpoints`
                        : ""}
                      {independenceOccurred
                        ? isTr
                          ? " · Egemen Ventriana kuruldu"
                          : " · Sovereign Ventriana emerged"
                        : ""}
                    </>
                  )}
                </span>
                {noPrivate && (
                  <span className="rounded border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-[11px] text-slate-300">
                    {isTr ? "Gizlilik Korumalı Dışa Aktarım" : "Privacy Redacted Export"}
                  </span>
                )}
              </div>

              <h2 className="text-sm font-semibold text-slate-100">
                {isTr
                  ? "Dokuz bölünmüş vilayette üç millet — hafızayı, koalisyonları ve bağımsızlığı canlı izleyin."
                  : "Three nations across nine partitioned provinces — trace memory, coalitions, and self-determination."}
              </h2>

              <p className="max-w-3xl text-xs leading-relaxed text-slate-300">
                {mode === "live"
                  ? isTr
                    ? "Yeni bir simülasyon başlatın, faz bazında duraklatıp devam ettirin ve çalışan koşuyu kaybetmeden diğer simülasyonlar arasında geçiş yapın. Seçilen başkanlar okul müfredatlarını yeniden yazarken devletsiz Ventriana halkı asimilasyon veya bağımsızlık arasında karar verir."
                    : "Launch new simulations, pause or step phase-by-phase, and switch freely between stored runs without interrupting background live streams. Elected presidents rewrite school curricula while stateless Ventrians debate assimilation or independence."
                  : isTr
                    ? "Ventriana'nın Lyria ve Skalia arasında bölünmesinin ardından devletsiz Ventrianlar asimilasyon veya bağımsızlık tartışırken seçilen başkanlar her yeni nesil için okul müfredatını şekillendirir."
                    : "Following Ventriana's partition between Lyria and Skalia, stateless Ventrians debate assimilation or independence while elected presidents reshape school curricula for every coming-of-age generation."}
              </p>

              {milestones.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[11px]">
                  <span className="text-slate-400">
                    {isTr ? "Atla:" : "Jump to:"}
                  </span>
                  {milestones.map((m) => (
                    <button
                      key={`${m.label}-${m.day}`}
                      type="button"
                      onClick={() => onJumpTo(m.day, m.tab)}
                      className="rounded border border-slate-700 bg-[#0b0e14] px-2 py-0.5 text-slate-200 transition hover:border-sky-500/50 hover:text-sky-200"
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {mode === "live" && onOpenNewRun && (
                <button
                  type="button"
                  onClick={onOpenNewRun}
                  className="inline-flex items-center gap-1 rounded border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/25"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {isTr ? "Yeni Simülasyon" : "New Simulation"}
                </button>
              )}
              <button
                type="button"
                onClick={onStartTour}
                className="rounded border border-sky-500/50 bg-sky-500/15 px-3 py-1.5 text-xs font-medium text-sky-200 transition hover:bg-sky-500/25"
              >
                {isTr ? "Rehber Turunu Başlat" : "Start Guided Tour"}
              </button>
              <button
                type="button"
                onClick={onDismissBriefing}
                aria-label="Dismiss briefing"
                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800/60 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800 hover:text-slate-100"
              >
                <X className="h-3.5 w-3.5" />
                {isTr ? "Kapat" : "Dismiss"}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Non-blocking Floating Guided Tour Card */}
      {activeTourStep && tourStep !== null && (
        <aside
          role="dialog"
          aria-label={tourAriaLabel}
          className="fixed bottom-4 right-4 z-30 w-[min(25rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-slate-600/80 bg-[#12161f]/95 shadow-2xl backdrop-blur"
        >
          <div
            className="h-0.5 w-full"
            style={{
              background:
                "linear-gradient(90deg, #38bdf8 0%, #f59e0b 50%, #fb7185 100%)",
            }}
          />
          <div className="space-y-2.5 p-4 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-medium text-slate-300">
                {stepIcon(activeTourStep.id)}
                <span>{activeTourStep.badge}</span>
              </div>
              <button
                type="button"
                onClick={() => onStepChange(null)}
                aria-label="Close guided tour"
                className="rounded p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                {activeTourStep.title}
              </h3>
              <p className="mt-1 leading-relaxed text-slate-300">
                {activeTourStep.body}
              </p>
            </div>

            <div className="rounded border border-slate-800 bg-[#0b0e14] px-2.5 py-1.5 text-[11px] text-slate-400">
              {activeTourStep.tip}
            </div>

            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-1">
                {tourSteps.map((s, idx) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-label={`Go to tour step ${idx + 1}`}
                    onClick={() => applyStepTarget(idx)}
                    className={`h-1.5 rounded-full transition-all ${
                      idx === tourStep
                        ? "w-5 bg-sky-400"
                        : "w-2 bg-slate-700 hover:bg-slate-500"
                    }`}
                  />
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                {tourStep > 0 && (
                  <button
                    type="button"
                    onClick={() => applyStepTarget(tourStep - 1)}
                    className="rounded border border-slate-700 bg-slate-800/70 px-2.5 py-1 text-slate-300 hover:bg-slate-800"
                  >
                    {isTr ? "Geri" : "Back"}
                  </button>
                )}
                {tourStep < tourSteps.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => applyStepTarget(tourStep + 1)}
                    className="rounded border border-sky-500/50 bg-sky-500/20 px-2.5 py-1 font-medium text-sky-200 hover:bg-sky-500/30"
                  >
                    {isTr ? "Sonraki adım" : "Next step"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onStepChange(null);
                      onDismissBriefing();
                    }}
                    className="rounded border border-emerald-500/50 bg-emerald-500/20 px-2.5 py-1 font-medium text-emerald-200 hover:bg-emerald-500/30"
                  >
                    {isTr ? "Turu bitir" : "Finish tour"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </aside>
      )}
    </>
  );
};
