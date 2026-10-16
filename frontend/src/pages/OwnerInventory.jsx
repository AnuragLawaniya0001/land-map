import React, { useState, useEffect } from "react";
import { api, errMsg } from "../lib/api";
import { Layers, CheckCircle2, Clock, PauseCircle, CheckSquare, Ban } from "lucide-react";

export default function OwnerInventory() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        setLoading(true);
        const res = await api.get("/owner/dashboard");
        setData(res.data.inventory);
        setError(null);
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setLoading(false);
      }
    };

    fetchMetrics();
  }, []);

  if (loading) return <div className="neo-card p-12 text-center text-sm opacity-70 animate-pulse">Loading inventory metrics...</div>;
  if (error) return <div className="neo-card p-6 border-l-4 border-red-500 text-red-600 dark:text-red-400">{error}</div>;

  const total = data?.totalPlots || 0;
  const statuses = [
    { label: "Available", count: data?.availablePlots || 0, color: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", icon: CheckCircle2 },
    { label: "Reserved / Booked", count: data?.reservedPlots || 0, color: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", icon: Clock },
    { label: "Hold", count: data?.holdPlots || 0, color: "bg-purple-500", text: "text-purple-600 dark:text-purple-400", icon: PauseCircle },
    { label: "Sold", count: data?.soldPlots || 0, color: "bg-blue-500", text: "text-blue-600 dark:text-blue-400", icon: CheckSquare },
    { label: "Blocked", count: data?.blockedPlots || 0, color: "bg-red-500", text: "text-red-600 dark:text-red-400", icon: Ban },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-serif tracking-tight">Platform Inventory</h1>
        <p className="text-sm opacity-70">Complete platform-wide plot status and distribution breakdown</p>
      </div>

      <div className="neo-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-serif font-bold text-lg">Total Registered Plots</h3>
          <span className="text-2xl font-bold font-mono text-violet-500">{total}</span>
        </div>

        {/* Status Distribution Bar */}
        {total > 0 && (
          <div className="w-full h-4 neo-inset rounded-full overflow-hidden flex p-0.5 gap-0.5">
            {statuses.map((s, idx) => {
              const pct = ((s.count / total) * 100).toFixed(1);
              if (s.count === 0) return null;
              return (
                <div
                  key={idx}
                  style={{ width: `${pct}%` }}
                  className={`h-full ${s.color} transition-all relative group`}
                  title={`${s.label}: ${s.count} (${pct}%)`}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {statuses.map((s, idx) => {
          const Icon = s.icon;
          const pct = total > 0 ? ((s.count / total) * 100).toFixed(1) : 0;
          return (
            <div key={idx} className="neo-card p-6 flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase opacity-70">
                  <Icon size={16} className={s.text} />
                  <span>{s.label}</span>
                </div>
                <div className={`text-3xl font-bold font-mono ${s.text}`}>{s.count}</div>
                <div className="text-xs opacity-60 font-mono">{pct}% of total inventory</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
