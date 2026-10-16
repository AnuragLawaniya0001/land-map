import React, { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { api, errMsg } from "@/lib/api";
import { Building2, MapPin, Layers, ShieldAlert, ArrowRight, CheckCircle2, Lock } from "lucide-react";
import InteractiveMap from "@/components/InteractiveMap";

export default function PublicPortal() {
  const { token } = useParams();
  const [session, setSession] = useState(null);
  const [colonies, setColonies] = useState([]);
  const [selectedColony, setSelectedColony] = useState(null);
  const [plotsData, setPlotsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Initialize Public Portal Session
  useEffect(() => {
    const initSession = async () => {
      try {
        setLoading(true);
        setError(null);

        // 1. Establish session via token
        const res = await api.post(`/public/portal/${token}/session`);
        setSession(res.data.session);

        // 2. Fetch public colonies for the portal
        const colRes = await api.get("/public/portal/session/colonies");
        setColonies(colRes.data.colonies || []);
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setLoading(false);
      }
    };

    if (token) initSession();
  }, [token]);

  // Load plots when colony selected
  const handleSelectColony = async (colonyId) => {
    try {
      const res = await api.get(`/public/portal/session/colonies/${colonyId}/plots`);
      setPlotsData(res.data);
      setSelectedColony(colonyId);
    } catch (err) {
      alert(errMsg(err));
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-violet-500 border-t-transparent" />
          <div className="text-sm font-mono opacity-70">Validating Public Portal Session...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full p-8 rounded-2xl bg-slate-900 border border-slate-800 text-center space-y-4">
          <ShieldAlert className="mx-auto text-red-500" size={48} />
          <h1 className="text-xl font-serif font-bold text-red-400">Portal Link Unavailable</h1>
          <p className="text-xs opacity-70">{error}</p>
          <div className="pt-2 text-[11px] opacity-50 font-mono">
            This public access link has either expired, exceeded the maximum device limit (5 devices max), or been revoked by the administrator.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 space-y-6 p-4 sm:p-8">
      {/* HEADER */}
      <header className="flex items-center justify-between max-w-6xl mx-auto border-b border-slate-800 pb-4">
        <div>
          <span className="text-[10px] uppercase font-mono tracking-widest text-violet-400">PUBLIC PROPERTY PORTAL</span>
          <h1 className="text-xl font-bold font-serif">Property Showcase</h1>
        </div>
        <span className="text-xs font-mono px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          ● CONTROLLED SESSION ACTIVE
        </span>
      </header>

      <main className="max-w-6xl mx-auto space-y-6">
        {/* COLONY SELECTION GRID */}
        {!selectedColony && (
          <div className="space-y-4">
            <h2 className="text-lg font-serif font-bold">Public Colonies Showcase</h2>
            {colonies.length === 0 ? (
              <div className="p-12 text-center text-sm opacity-60 bg-slate-900 rounded-xl border border-slate-800">
                No public colonies available in this showcase.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {colonies.map((c) => (
                  <div key={c.id} className="p-6 rounded-xl bg-slate-900 border border-slate-800 space-y-4 hover:border-violet-500/40 transition-all">
                    <div>
                      <h3 className="font-serif font-bold text-lg text-slate-100">{c.name}</h3>
                      <p className="text-xs opacity-60 flex items-center gap-1 mt-0.5">
                        <MapPin size={12} /> {c.location || "Location not specified"}
                      </p>
                    </div>

                    <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-800">
                      <span className="opacity-70">Available Inventory:</span>
                      <span className="font-mono font-bold text-emerald-400">{c.available_plots} plots</span>
                    </div>

                    <button
                      onClick={() => handleSelectColony(c.id)}
                      className="w-full text-xs font-semibold py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white flex items-center justify-center gap-1.5 transition-all"
                    >
                      Explore Public Layout <ArrowRight size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* SELECTED COLONY PLOTS VIEW */}
        {selectedColony && plotsData && (
          <div className="space-y-6">
            <button
              onClick={() => setSelectedColony(null)}
              className="text-xs font-semibold text-violet-400 hover:underline flex items-center gap-1"
            >
              ← Back to All Showcase Colonies
            </button>

            <div className="p-6 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-serif font-bold">{plotsData.colony?.name}</h2>
                <p className="text-xs opacity-60">{plotsData.colony?.location}</p>
              </div>
              <div className="text-xs font-mono">
                Total Plots: <strong>{plotsData.plots?.length || 0}</strong>
              </div>
            </div>

            {/* PLOT LIST TABLE */}
            <div className="p-6 rounded-xl bg-slate-900 border border-slate-800 space-y-4">
              <h3 className="text-xs font-mono uppercase tracking-wider opacity-70">Public Property Inventory</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs uppercase opacity-60 font-mono">
                      <th className="py-2.5 px-3">Plot #</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Area (sqft)</th>
                      <th className="py-2.5 px-3">Price</th>
                      <th className="py-2.5 px-3">Facing</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 font-mono text-xs">
                    {plotsData.plots?.map((p) => (
                      <tr key={p.id} className="hover:bg-slate-800/50">
                        <td className="py-3 px-3 font-bold text-slate-200">Plot {p.number}</td>
                        <td className="py-3 px-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            p.status_id === "available" ? "bg-emerald-500/10 text-emerald-400" : "bg-blue-500/10 text-blue-400"
                          }`}>
                            {p.status_id}
                          </span>
                        </td>
                        <td className="py-3 px-3">{p.area_sqft || "N/A"}</td>
                        <td className="py-3 px-3 text-emerald-400">
                          {p.price ? `₹${Number(p.price).toLocaleString()}` : "Contact for Price"}
                        </td>
                        <td className="py-3 px-3 uppercase text-[10px]">{p.facing || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
