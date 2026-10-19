import { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { Users, MapPin, Layers, MessageSquare, Plus, CheckCircle, Clock, ShieldAlert, ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";

export default function OwnerDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const reload = () => {
    setLoading(true);
    api.get("/owner/dashboard")
      .then((res) => setData(res.data))
      .catch((e) => setErr(errMsg(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
  }, []);

  if (loading) {
    return <div style={{ color: "var(--owner-text-muted)", textAlign: "center", padding: "4rem" }}>Loading Platform Governance Metrics...</div>;
  }

  if (err || !data) {
    return <div style={{ background: "#7f1d1d", color: "#fca5a5", padding: "1rem", borderRadius: "8px" }}>{err || "Failed to load dashboard"}</div>;
  }

  const totals = data.totals || {};
  const statusCounts = data.status_counts || {};
  const inquiries = data.inquiries || {};
  const shares = data.shares || {};
  const recentActivity = data.recent_activity || [];

  return (
    <div className="lm-page-container" data-testid="owner-dashboard-page">
      {/* Top Bar / Welcome */}
      <header className="lm-modern-header">
        <div className="lm-modern-header-left">
          <span className="lm-modern-eyebrow">Platform Governance</span>
          <h1 className="lm-modern-title">
            Welcome back, {data.user?.name || "Owner"}.
          </h1>
          <p className="lm-modern-subtitle">
            Complete platform-wide monitoring over every admin workspace, colony layout, plot inventory, and public link.
          </p>
        </div>
      </header>

      {/* Metric Cards Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="lm-stat colonies" data-testid="owner-metric-admins">
          <div className="lm-stat-top">
            <span className="lm-stat-label">Total Admins</span>
            <div className="lm-stat-icon-wrap">
              <Users size={16} />
            </div>
          </div>
          <div className="lm-stat-val">
            {totals.admins || 0}
          </div>
          <div className="lm-stat-sub">Registered platform tenants</div>
        </div>

        <div className="lm-stat colonies" data-testid="owner-metric-colonies">
          <div className="lm-stat-top">
            <span className="lm-stat-label">Total Colonies</span>
            <div className="lm-stat-icon-wrap">
              <MapPin size={16} />
            </div>
          </div>
          <div className="lm-stat-val">
            {totals.colonies || 0}
          </div>
          <div className="lm-stat-sub">Imported GIS layouts</div>
        </div>

        <div className="lm-stat available" data-testid="owner-metric-plots">
          <div className="lm-stat-top">
            <span className="lm-stat-label">Total Plots</span>
            <div className="lm-stat-icon-wrap">
              <Layers size={16} />
            </div>
          </div>
          <div className="lm-stat-val">
            {totals.plots || 0}
          </div>
          <div className="lm-stat-sub">Tracked real-estate units</div>
        </div>

        <div className="lm-modern-card" data-testid="owner-metric-inquiries">
          <div className="flex items-center justify-between text-[#6B7280] mb-2">
            <span className="text-xs font-bold uppercase tracking-wider font-mono">Inquiries</span>
            <div className="p-2 rounded-lg bg-[#F4EFE6] text-[#173F35] border border-[#E8E2D6]">
              <MessageSquare size={16} />
            </div>
          </div>
          <div className="text-3xl font-extrabold text-[#172A25] font-mono tracking-tight">
            {inquiries.new || 0} <span className="text-sm text-[#6B7280] font-normal">/ {inquiries.total || 0}</span>
          </div>
          <div className="text-xs text-[#6B7280] mt-1">New / Total customer leads</div>
        </div>
      </div>

      {/* Inventory Status Breakdown & Shares Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Inventory Breakdown */}
        <div className="lm-modern-card lg:col-span-2">
          <h3 className="text-base font-bold text-[#172A25] mb-4 flex items-center gap-2">
            <Layers size={18} className="text-[#173F35]" />
            <span>Platform Inventory Breakdown</span>
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">
            <div className="bg-[#F6F4EE] border border-[#E8E2D6] rounded-xl p-3">
              <div className="text-[11px] text-[#047857] uppercase font-mono font-bold">Available</div>
              <div className="text-2xl font-extrabold text-[#172A25] font-mono mt-1">{statusCounts.available || 0}</div>
            </div>
            <div className="bg-[#F6F4EE] border border-[#E8E2D6] rounded-xl p-3">
              <div className="text-[11px] text-[#D97706] uppercase font-mono font-bold">Hold</div>
              <div className="text-2xl font-extrabold text-[#172A25] font-mono mt-1">{statusCounts.hold || 0}</div>
            </div>
            <div className="bg-[#F6F4EE] border border-[#E8E2D6] rounded-xl p-3">
              <div className="text-[11px] text-[#B45309] uppercase font-mono font-bold">Reserved</div>
              <div className="text-2xl font-extrabold text-[#172A25] font-mono mt-1">{statusCounts.reserved || 0}</div>
            </div>
            <div className="bg-[#F6F4EE] border border-[#E8E2D6] rounded-xl p-3">
              <div className="text-[11px] text-[#BE123C] uppercase font-mono font-bold">Sold</div>
              <div className="text-2xl font-extrabold text-[#172A25] font-mono mt-1">{statusCounts.sold || 0}</div>
            </div>
            <div className="bg-[#F6F4EE] border border-[#E8E2D6] rounded-xl p-3 col-span-2 sm:col-span-1">
              <div className="text-[11px] text-[#6B7280] uppercase font-mono font-bold">Blocked</div>
              <div className="text-2xl font-extrabold text-[#172A25] font-mono mt-1">{statusCounts.blocked || 0}</div>
            </div>
          </div>
        </div>

        {/* Shares Overview */}
        <div className="lm-modern-card">
          <h3 className="text-base font-bold text-[#172A25] mb-4 flex items-center gap-2">
            <span>Public Share Tokens</span>
          </h3>
          <div className="flex flex-col gap-3 text-xs">
            <div className="flex justify-between items-center py-2 border-b border-[#F0ECE1]">
              <span className="text-[#6B7280]">Active Shared Links</span>
              <span className="font-bold font-mono text-[#173F35] text-sm">{shares.active || 0}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-[#F0ECE1]">
              <span className="text-[#6B7280]">Total Generated</span>
              <span className="font-bold font-mono text-[#0D1B2A] text-sm">{shares.total || 0}</span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-[#6B7280]">Registry Deeds Attached</span>
              <span className="font-bold font-mono text-[#173F35] text-sm">{totals.registry_docs || 0}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Platform Activity */}
      <div className="lm-modern-card">
        <h3 className="text-base font-bold text-[#172A25] mb-4 flex items-center justify-between">
          <span>Recent Platform Audit Activity</span>
          <Link to="/superadmin/audit" className="text-xs text-[#173F35] hover:underline font-semibold">
            View All Audit Logs →
          </Link>
        </h3>
        {recentActivity.length === 0 ? (
          <div className="text-xs text-[#6B7280] py-6 text-center">No recent activity records.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {recentActivity.map((act) => (
              <div
                key={act.id}
                className="flex items-center justify-between p-3 bg-[#F6F4EE] border border-[#E8E2D6] rounded-xl text-xs hover:border-[#173F35]/40 transition-colors"
                data-testid={`owner-activity-row-${act.id}`}
              >
                <div>
                  <strong className="text-[#173F35]">{act.user_name || "System"}</strong>:{" "}
                  <span className="text-[#374151]">{act.action ? act.action.replaceAll("_", " ") : "Action"}</span> on{" "}
                  <code className="text-[#0D1B2A] font-mono text-[11px] bg-[#EAE5DB] px-1.5 py-0.5 rounded">{act.entity_type}</code>
                </div>
                <span className="text-[11px] text-[#6B7280] font-mono">
                  {new Date(act.created_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
