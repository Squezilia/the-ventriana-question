import React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyMetricsRow, WorldState } from "../../../contracts/types.ts";

interface ChartsPanelProps {
  stats: DailyMetricsRow[];
  state: WorldState;
}

export const ChartsPanel: React.FC<ChartsPanelProps> = ({ stats, state }) => {
  const partyData = Object.values(state.parties)
    .filter((p) => !p.dissolved)
    .map((p) => ({ name: p.name.slice(0, 18), members: p.memberIds.length }));

  const nationByCountry = (["lyria", "skalia", "ventriana"] as const)
    .filter((cid) => state.countries[cid].exists)
    .map((cid) => {
      const agents = Object.values(state.agents).filter(
        (a) => a.alive && state.regions[a.region]?.countryId === cid
      );
      return {
        country: state.countries[cid].name,
        Lyrians: agents.filter((a) => a.nation === "lyrians").length,
        Skalians: agents.filter((a) => a.nation === "skalians").length,
        Ventrians: agents.filter((a) => a.nation === "ventrians").length,
      };
    });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* 1. Ventrian Dispersion */}
      <div className="rounded-lg border border-slate-800 bg-[#12161f] p-4">
        <h3 className="mb-2 text-xs font-semibold text-slate-200">
          Ventrian dispersion & largest cluster
        </h3>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={stats}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="day" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip
                contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line
                type="monotone"
                dataKey="ventrianRegionsCount"
                name="Regions w/ Ventrians"
                stroke="#fb7185"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="largestVentrianCluster"
                name="Largest Cluster"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 2. Messages per day */}
      <div className="rounded-lg border border-slate-800 bg-[#12161f] p-4">
        <h3 className="mb-2 text-xs font-semibold text-slate-200">
          Messages per day
        </h3>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={stats}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="day" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip
                contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="postsCount" name="Posts" stroke="#38bdf8" dot={false} />
              <Line type="monotone" dataKey="dmsCount" name="DMs" stroke="#a78bfa" dot={false} />
              <Line type="monotone" dataKey="localChatCount" name="Local Chat" stroke="#34d399" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 3. Agents per nation per country */}
      <div className="rounded-lg border border-slate-800 bg-[#12161f] p-4">
        <h3 className="mb-2 text-xs font-semibold text-slate-200">
          Citizens per nation per country (Day {state.day})
        </h3>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={nationByCountry}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="country" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip
                contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Lyrians" fill="#38bdf8" />
              <Bar dataKey="Skalians" fill="#f59e0b" />
              <Bar dataKey="Ventrians" fill="#fb7185" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 4. Party sizes */}
      <div className="rounded-lg border border-slate-800 bg-[#12161f] p-4">
        <h3 className="mb-2 text-xs font-semibold text-slate-200">
          Active party sizes (Day {state.day})
        </h3>
        <div className="h-52">
          {partyData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-slate-500">
              No active political parties yet.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={partyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="name" stroke="#64748b" fontSize={11} />
                <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", fontSize: 12 }}
                />
                <Bar dataKey="members" fill="#818cf8" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
};
