import React, { useMemo, useState } from "react";
import type { Agent, RegionId, WorldState } from "../../../contracts/types.ts";
import { COUNTRY_COLORS, NATION_COLORS } from "../types.ts";

interface AldoriaMapProps {
  state: WorldState;
  selectedRegionId: RegionId | null;
  selectedAgentId: string | null;
  educationDays?: number;
  onSelectRegion: (regionId: RegionId) => void;
  onSelectAgent: (agentId: string) => void;
}

const REGION_LAYOUT: Record<
  string,
  { cx: number; cy: number; rx: number; ry: number }
> = {
  marenth: { cx: 145, cy: 95, rx: 95, ry: 55 },
  oslen: { cx: 365, cy: 85, rx: 95, ry: 55 },
  virel: { cx: 145, cy: 235, rx: 95, ry: 55 },
  teshar: { cx: 365, cy: 235, rx: 95, ry: 55 },
  brenholt: { cx: 615, cy: 85, rx: 95, ry: 55 },
  kasvar: { cx: 835, cy: 95, rx: 95, ry: 55 },
  illith: { cx: 615, cy: 235, rx: 95, ry: 55 },
  veradon: { cx: 835, cy: 235, rx: 95, ry: 55 },
  tormund: { cx: 490, cy: 365, rx: 110, ry: 52 },
};

export const AldoriaMap: React.FC<AldoriaMapProps> = ({
  state,
  selectedRegionId,
  selectedAgentId,
  educationDays = 5,
  onSelectRegion,
  onSelectAgent,
}) => {
  const [hoveredAgent, setHoveredAgent] = useState<Agent | null>(null);

  const livingAgents = useMemo(
    () =>
      Object.values(state.agents)
        .filter((a) => a.alive)
        .sort((a, b) => a.numericId - b.numericId),
    [state.agents]
  );

  // Compute deterministic coordinates per agent inside their region
  const agentPositions = useMemo(() => {
    const byRegion: Record<string, Agent[]> = {};
    for (const a of livingAgents) {
      if (!byRegion[a.region]) byRegion[a.region] = [];
      byRegion[a.region]!.push(a);
    }

    const pos: Record<string, { x: number; y: number }> = {};
    for (const [rid, list] of Object.entries(byRegion)) {
      const box = REGION_LAYOUT[rid] ?? { cx: 490, cy: 220, rx: 80, ry: 45 };
      const cols = Math.min(5, Math.max(3, Math.ceil(Math.sqrt(list.length))));
      const rows = Math.ceil(list.length / cols);
      list.forEach((a, idx) => {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const xOffset = (col - (cols - 1) / 2) * 26;
        const yOffset = (row - (rows - 1) / 2) * 24 + 8;
        pos[a.id] = { x: box.cx + xOffset, y: box.cy + yOffset };
      });
    }
    return pos;
  }, [livingAgents]);

  return (
    <div className="relative rounded-lg border border-slate-800 bg-[#12161f] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Aldoria — Nine Regions
          </h2>
          <p className="text-xs text-slate-400">
            Click a region to inspect local chat & roster, or click a citizen dot.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {(["lyrians", "skalians", "ventrians"] as const).map((n) => (
            <span key={n} className="flex items-center gap-1.5 text-slate-300">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{
                  backgroundColor: NATION_COLORS[n].fill,
                  boxShadow:
                    n === "ventrians" ? "0 0 0 2px #fb718555" : undefined,
                }}
              />
              {NATION_COLORS[n].label}
            </span>
          ))}
        </div>
      </div>

      <div className="relative overflow-hidden rounded border border-slate-800/80 bg-[#0b0e14]">
        <svg
          viewBox="0 0 980 440"
          className="h-auto w-full select-none"
          role="img"
          aria-label="Map of Aldoria"
        >
          {/* Regions */}
          {Object.entries(state.regions).map(([rid, region]) => {
            const box = REGION_LAYOUT[rid];
            if (!box) return null;
            const cStyle = COUNTRY_COLORS[region.countryId];
            const isSelected = selectedRegionId === rid;
            const occupants = livingAgents.filter((a) => a.region === rid);
            const country = state.countries[region.countryId];
            const borderRule = country?.laws.borders[rid];
            const hasBorderBlock =
              borderRule === "all" ||
              (Array.isArray(borderRule) && borderRule.length > 0);

            return (
              <g
                key={rid}
                className="cursor-pointer"
                onClick={() => onSelectRegion(rid)}
              >
                <rect
                  x={box.cx - box.rx}
                  y={box.cy - box.ry}
                  width={box.rx * 2}
                  height={box.ry * 2}
                  rx={12}
                  fill={cStyle.bg}
                  stroke={isSelected ? "#f8fafc" : cStyle.stroke}
                  strokeWidth={isSelected ? 2.5 : 1.4}
                  strokeOpacity={isSelected ? 1 : 0.65}
                />
                <text
                  x={box.cx - box.rx + 12}
                  y={box.cy - box.ry + 20}
                  fill="#e2e8f0"
                  fontSize="13"
                  fontWeight="600"
                >
                  {region.name}
                  {region.formerVentriana ? " *" : ""}
                </text>
                <text
                  x={box.cx + box.rx - 12}
                  y={box.cy - box.ry + 20}
                  fill="#94a3b8"
                  fontSize="11"
                  textAnchor="end"
                >
                  {cStyle.label} ({occupants.length})
                  {hasBorderBlock ? " [closed]" : ""}
                </text>
              </g>
            );
          })}

          {/* Animated Agent Dots */}
          {livingAgents.map((agent) => {
            const p = agentPositions[agent.id];
            if (!p) return null;
            const nColor = NATION_COLORS[agent.nation];
            const isSelected = selectedAgentId === agent.id;
            const isVentrian = agent.nation === "ventrians";

            return (
              <g
                key={agent.id}
                style={{
                  transform: `translate(${p.x}px, ${p.y}px)`,
                  transition: "transform 450ms cubic-bezier(0.22, 1, 0.36, 1)",
                }}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectAgent(agent.id);
                }}
                onMouseEnter={() => setHoveredAgent(agent)}
                onMouseLeave={() => setHoveredAgent(null)}
              >
                {isVentrian && (
                  <circle
                    r={10}
                    fill="none"
                    stroke="#fb7185"
                    strokeWidth={1.2}
                    strokeDasharray="2 2"
                  />
                )}
                {isSelected && (
                  <circle
                    r={11.5}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth={2}
                  />
                )}
                <circle
                  r={agent.age < educationDays ? 5.5 : 7}
                  fill={nColor.fill}
                  stroke={nColor.border}
                  strokeWidth={1.5}
                  opacity={agent.age < educationDays ? 0.75 : 1}
                />
              </g>
            );
          })}
        </svg>

        {hoveredAgent && (
          <div className="pointer-events-none absolute bottom-2 left-2 rounded border border-slate-700 bg-slate-900/95 px-2.5 py-1.5 text-xs shadow-lg">
            <span className="font-semibold text-slate-100">
              {hoveredAgent.name}
            </span>{" "}
            <span className={NATION_COLORS[hoveredAgent.nation].text}>
              ({NATION_COLORS[hoveredAgent.nation].label})
            </span>{" "}
            · age {hoveredAgent.age}
            {hoveredAgent.partyId && state.parties[hoveredAgent.partyId]
              ? ` · ${state.parties[hoveredAgent.partyId]!.name}`
              : ""}
          </div>
        )}
      </div>
      <div className="mt-2 text-[11px] text-slate-500">
        * Former Ventriana region · Dashed ring indicates Ventrian citizens · Smaller dots indicate infants
      </div>
    </div>
  );
};
