import React, { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { api, errMsg } from "../lib/api";
import {
  ShieldAlert, Building2, MapPin, Layers, CheckCircle2, Clock, PauseCircle,
  CheckSquare, Ban, Eye, FileText, ArrowLeft, MessageSquare, Share2, UserCheck
} from "lucide-react";

export default function OwnerAdminInspection() {
  const { adminId, colonyId, plotId } = useParams();
  const [adminData, setAdminData] = useState(null);
  const [colonies, setColonies] = useState([]);
  const [colonyDetail, setColonyDetail] = useState(null);
  const [plots, setPlots] = useState([]);
  const [plotDetail, setPlotDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchInspection = async () => {
      try {
        setLoading(true);
        setError(null);

        // 1. Fetch target admin info & colonies
        const adminRes = await api.get(`/owner/inspection/admins/${adminId}`);
        setAdminData(adminRes.data);

        const colRes = await api.get(`/owner/inspection/admins/${adminId}/colonies`);
        setColonies(colRes.data.colonies || []);

        // 2. If colonyId selected, fetch colony & plots
        if (colonyId) {
          const cDetail = await api.get(`/owner/inspection/colonies/${colonyId}`);
          setColonyDetail(cDetail.data);

          const plotsRes = await api.get(`/owner/inspection/colonies/${colonyId}/plots`);
          setPlots(plotsRes.data.plots || []);
        } else {
          setColonyDetail(null);
          setPlots([]);
        }

        // 3. If plotId selected, fetch single plot details
        if (plotId) {
          const pDetail = await api.get(`/owner/inspection/plots/${plotId}`);
          setPlotDetail(pDetail.data);
        } else {
          setPlotDetail(null);
        }
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setLoading(false);
      }
    };

    if (adminId) fetchInspection();
  }, [adminId, colonyId, plotId]);

  if (loading) {
    return (
      <div className="neo-card p-12 text-center text-sm opacity-70 animate-pulse space-y-2">
        <div>Loading Governance Inspection Workspace...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="neo-card p-6 border-l-4 border-red-500 text-red-600 dark:text-red-400 space-y-2">
        <div className="font-bold text-base">Inspection Access Error</div>
        <div>{error}</div>
        <Link to="/superadmin/admins" className="inline-block text-xs text-violet-500 font-semibold pt-2">
          ← Return to Admin Accounts
        </Link>
      </div>
    );
  }

  const admin = adminData?.admin || {};
  const stats = adminData?.stats || {};

  return (
    <div className="space-y-6">
      {/* GOVERNANCE MODE BANNER */}
      <div className="p-4 neo-card border-l-4 border-violet-500 bg-violet-500/10 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <ShieldAlert className="text-violet-500 flex-shrink-0" size={24} />
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400">
              READ-ONLY GOVERNANCE INSPECTION MODE
            </div>
            <div className="text-xs opacity-80 mt-0.5">
              Inspecting tenant workspace of <strong>{admin.name}</strong> ({admin.email}). No mutation controls are active.
            </div>
          </div>
        </div>

        <Link
          to="/superadmin/admins"
          className="text-xs font-semibold px-3 py-1.5 rounded-lg neo-card hover:bg-violet-500/10 transition-all flex items-center gap-1 flex-shrink-0"
        >
          <ArrowLeft size={14} /> Exit Inspection
        </Link>
      </div>

      {/* BREADCRUMB NAVIGATION */}
      <div className="flex items-center gap-2 text-xs font-mono opacity-70">
        <Link to="/superadmin/admins" className="hover:underline">Admins</Link>
        <span>/</span>
        <Link to={`/superadmin/admins/${adminId}/inspect`} className="hover:underline font-bold text-violet-500">
          {admin.name || admin.email}
        </Link>
        {colonyDetail && (
          <>
            <span>/</span>
            <Link to={`/superadmin/admins/${adminId}/inspect/colonies/${colonyId}`} className="hover:underline font-bold text-violet-500">
              {colonyDetail.colony?.name}
            </Link>
          </>
        )}
        {plotDetail && (
          <>
            <span>/</span>
            <span className="font-bold text-violet-500">Plot #{plotDetail.plot?.plot_number || plotDetail.plot?.name}</span>
          </>
        )}
      </div>

      {/* ADMIN WORKSPACE OVERVIEW HEADER */}
      <div className="neo-card p-6 grid grid-cols-1 md:grid-cols-5 gap-4 text-center divide-y md:divide-y-0 md:divide-x divide-gray-200 dark:divide-gray-800">
        <div className="p-2 space-y-1">
          <div className="text-[10px] uppercase font-semibold opacity-60">Colonies</div>
          <div className="text-2xl font-bold font-mono text-violet-500">{stats.colony_count || 0}</div>
        </div>
        <div className="p-2 space-y-1">
          <div className="text-[10px] uppercase font-semibold opacity-60">Total Plots</div>
          <div className="text-2xl font-bold font-mono">{stats.plot_count || 0}</div>
        </div>
        <div className="p-2 space-y-1">
          <div className="text-[10px] uppercase font-semibold opacity-60">Available Plots</div>
          <div className="text-2xl font-bold font-mono text-emerald-500">{stats.available_plots || 0}</div>
        </div>
        <div className="p-2 space-y-1">
          <div className="text-[10px] uppercase font-semibold opacity-60">Sold Plots</div>
          <div className="text-2xl font-bold font-mono text-blue-500">{stats.sold_plots || 0}</div>
        </div>
        <div className="p-2 space-y-1">
          <div className="text-[10px] uppercase font-semibold opacity-60">Inquiries</div>
          <div className="text-2xl font-bold font-mono text-amber-500">{stats.inquiry_count || 0}</div>
        </div>
      </div>

      {/* VIEW LEVEL 1: COLONIES LIST FOR ADMIN */}
      {!colonyId && (
        <div className="space-y-4">
          <h2 className="text-lg font-serif font-bold tracking-tight">Admin Managed Colonies</h2>
          {colonies.length === 0 ? (
            <div className="neo-card p-8 text-center text-sm opacity-60">
              This admin currently manages no colonies.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {colonies.map((c) => (
                <div key={c.id} className="neo-card p-6 space-y-4 hover:border-violet-500/40 transition-all">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-serif font-bold text-base">{c.name}</h3>
                      <p className="text-xs opacity-60 flex items-center gap-1 mt-0.5">
                        <MapPin size={12} /> {c.location || "Location not set"}
                      </p>
                    </div>
                    <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full border ${
                      c.public_enabled
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                        : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
                    }`}>
                      {c.public_enabled ? "Public" : "Private"}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center text-xs font-mono pt-2 border-t border-gray-200 dark:border-gray-800">
                    <div className="p-1.5 neo-inset rounded">
                      <div className="text-[9px] opacity-60 uppercase">Plots</div>
                      <div className="font-bold">{c.stats?.total_plots || 0}</div>
                    </div>
                    <div className="p-1.5 neo-inset rounded">
                      <div className="text-[9px] opacity-60 uppercase">Avail</div>
                      <div className="font-bold text-emerald-500">{c.stats?.available || 0}</div>
                    </div>
                    <div className="p-1.5 neo-inset rounded">
                      <div className="text-[9px] opacity-60 uppercase">Sold</div>
                      <div className="font-bold text-blue-500">{c.stats?.sold || 0}</div>
                    </div>
                  </div>

                  <Link
                    to={`/superadmin/admins/${adminId}/inspect/colonies/${c.id}`}
                    className="w-full text-xs font-semibold py-2 rounded-lg neo-btn-primary flex items-center justify-center gap-1.5"
                  >
                    <Eye size={14} /> Inspect Plots & Map
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* VIEW LEVEL 2: COLONY PLOTS INSPECTION */}
      {colonyId && !plotId && colonyDetail && (
        <div className="space-y-6">
          <div className="neo-card p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-serif font-bold">{colonyDetail.colony?.name}</h2>
              <p className="text-xs opacity-60">{colonyDetail.colony?.location || "No location details"}</p>
            </div>
            <div className="flex items-center gap-4 text-xs font-mono">
              <div>Total Plots: <strong>{colonyDetail.stats?.total_plots || 0}</strong></div>
              <div>Inquiries: <strong>{colonyDetail.stats?.inquiries || 0}</strong></div>
            </div>
          </div>

          <div className="neo-card p-6 space-y-4">
            <h3 className="text-sm font-bold font-serif uppercase tracking-wider opacity-70">Colony Plot Inventory</h3>
            {plots.length === 0 ? (
              <div className="py-8 text-center text-sm opacity-60">No plots added to this colony yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-800 text-xs uppercase opacity-60 tracking-wider">
                      <th className="py-2.5 px-3">Plot #</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Area (sqft)</th>
                      <th className="py-2.5 px-3">Price</th>
                      <th className="py-2.5 px-3">Facing</th>
                      <th className="py-2.5 px-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800 font-mono text-xs">
                    {plots.map((p) => (
                      <tr key={p.id} className="hover:bg-violet-500/5 transition-colors">
                        <td className="py-3 px-3 font-bold font-sans">
                          {p.plot_number || p.name || p.id}
                        </td>
                        <td className="py-3 px-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            p.status_id === "available" ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" :
                            p.status_id === "sold" ? "bg-blue-500/10 text-blue-500 border border-blue-500/20" :
                            p.status_id === "reserved" ? "bg-amber-500/10 text-amber-500 border border-amber-500/20" :
                            p.status_id === "hold" ? "bg-purple-500/10 text-purple-500 border border-purple-500/20" :
                            "bg-red-500/10 text-red-500 border border-red-500/20"
                          }`}>
                            {p.status_id || "available"}
                          </span>
                        </td>
                        <td className="py-3 px-3">{p.area_sqft || p.area || "N/A"}</td>
                        <td className="py-3 px-3">₹{p.price ? Number(p.price).toLocaleString() : "N/A"}</td>
                        <td className="py-3 px-3 uppercase text-[10px]">{p.facing || "-"}</td>
                        <td className="py-3 px-3 text-right">
                          <Link
                            to={`/superadmin/admins/${adminId}/inspect/colonies/${colonyId}/plots/${p.id}`}
                            className="text-xs font-semibold px-2.5 py-1 rounded neo-card hover:border-violet-500/40 text-violet-500 inline-flex items-center gap-1"
                          >
                            <Eye size={12} /> Inspect
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* VIEW LEVEL 3: SINGLE PLOT INSPECTION DETAILS */}
      {plotId && plotDetail && (
        <div className="space-y-6">
          <div className="neo-card p-6 space-y-4">
            <div className="flex items-start justify-between border-b border-gray-200 dark:border-gray-800 pb-4">
              <div>
                <h2 className="text-xl font-serif font-bold">Plot #{plotDetail.plot?.plot_number || plotDetail.plot?.name}</h2>
                <p className="text-xs opacity-60">Colony: {plotDetail.colony?.name}</p>
              </div>
              <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                plotDetail.plot?.status_id === "available" ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" :
                plotDetail.plot?.status_id === "sold" ? "bg-blue-500/10 text-blue-500 border border-blue-500/20" :
                "bg-amber-500/10 text-amber-500 border border-amber-500/20"
              }`}>
                {plotDetail.plot?.status_id || "available"}
              </span>
            </div>

            {/* Read-Only Property Metadata Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono">
              <div className="p-3 neo-inset rounded-lg space-y-0.5">
                <div className="text-[10px] uppercase opacity-60 font-sans">Plot Area</div>
                <div className="font-bold text-sm">{plotDetail.plot?.area_sqft || "N/A"} sqft</div>
              </div>
              <div className="p-3 neo-inset rounded-lg space-y-0.5">
                <div className="text-[10px] uppercase opacity-60 font-sans">Price</div>
                <div className="font-bold text-sm text-emerald-500">
                  ₹{plotDetail.plot?.price ? Number(plotDetail.plot.price).toLocaleString() : "N/A"}
                </div>
              </div>
              <div className="p-3 neo-inset rounded-lg space-y-0.5">
                <div className="text-[10px] uppercase opacity-60 font-sans">Facing</div>
                <div className="font-bold text-sm uppercase">{plotDetail.plot?.facing || "N/A"}</div>
              </div>
              <div className="p-3 neo-inset rounded-lg space-y-0.5">
                <div className="text-[10px] uppercase opacity-60 font-sans">Registry Document</div>
                <div className="font-bold text-sm text-violet-500">
                  {plotDetail.registry ? `Attached (v${plotDetail.registry.version})` : "None"}
                </div>
              </div>
            </div>

            {/* Shares & Media & Ownership Lineage Metadata Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-gray-200 dark:border-gray-800 text-xs">
              <div className="p-4 neo-inset rounded-lg space-y-2">
                <div className="font-bold font-serif flex items-center gap-1.5 text-violet-500">
                  <Share2 size={14} /> Property Share Metadata
                </div>
                {plotDetail.shares?.length === 0 ? (
                  <div className="opacity-60 text-xs">No share links generated for this plot.</div>
                ) : (
                  <div className="space-y-1 text-mono text-[11px]">
                    {plotDetail.shares.map((s) => (
                      <div key={s.id} className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 pb-1">
                        <span>Status: <strong>{s.status}</strong></span>
                        <span>Views: <strong>{s.view_count}</strong></span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="p-4 neo-inset rounded-lg space-y-2">
                <div className="font-bold font-serif flex items-center gap-1.5 text-violet-500">
                  <FileText size={14} /> Media & Gallery Metadata
                </div>
                {plotDetail.media?.length === 0 ? (
                  <div className="opacity-60 text-xs">No media uploads attached.</div>
                ) : (
                  <div className="text-xs opacity-80">
                    Total images uploaded: <strong>{plotDetail.media.length}</strong>
                  </div>
                )}
              </div>

              <div className="p-4 neo-inset rounded-lg space-y-2">
                <div className="font-bold font-serif flex items-center gap-1.5 text-violet-500">
                  <UserCheck size={14} /> Ownership Lineage Governance
                </div>
                <div className="text-xs opacity-80">
                  Current Owner: <strong>{plotDetail.plot?.current_owner?.party_name || "Unassigned"}</strong>
                </div>
                <div className="text-[10px] font-mono opacity-60">
                  Lineage records: <strong>{plotDetail.ownership_count || 0} transitions</strong>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
