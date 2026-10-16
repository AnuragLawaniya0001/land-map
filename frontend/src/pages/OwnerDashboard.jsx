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
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Top Bar / Welcome */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: "0.8rem", color: "var(--owner-accent)", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Platform Governance
          </div>
          <h1 style={{ fontFamily: "Fraunces, serif", fontSize: "2rem", fontWeight: "800", margin: 0 }}>
            Welcome back, {data.user?.name || "Owner"}.
          </h1>
          <p style={{ color: "var(--owner-text-muted)", fontSize: "0.9rem", marginTop: "0.2rem" }}>
            Complete platform-wide monitoring over every admin, colony, plot, and public share link.
          </p>
        </div>
      </div>

      {/* Metric Cards Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1.25rem" }}>
        <div className="owner-card-neumorph" data-testid="owner-metric-admins">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", color: "var(--owner-text-muted)", marginBottom: "0.5rem" }}>
            <span style={{ fontSize: "0.8rem", fontWeight: "700", textTransform: "uppercase" }}>Total Admins</span>
            <Users size={18} style={{ color: "var(--owner-accent)" }} />
          </div>
          <div style={{ fontSize: "2rem", fontWeight: "800", color: "var(--owner-text-primary)" }}>
            {totals.admins || 0}
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--owner-text-muted)", marginTop: "0.25rem" }}>Registered platform tenants</div>
        </div>

        <div className="owner-card-neumorph" data-testid="owner-metric-colonies">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", color: "var(--owner-text-muted)", marginBottom: "0.5rem" }}>
            <span style={{ fontSize: "0.8rem", fontWeight: "700", textTransform: "uppercase" }}>Total Colonies</span>
            <MapPin size={18} style={{ color: "#38bdf8" }} />
          </div>
          <div style={{ fontSize: "2rem", fontWeight: "800", color: "var(--owner-text-primary)" }}>
            {totals.colonies || 0}
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--owner-text-muted)", marginTop: "0.25rem" }}>Imported GIS layouts</div>
        </div>

        <div className="owner-card-neumorph" data-testid="owner-metric-plots">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", color: "var(--owner-text-muted)", marginBottom: "0.5rem" }}>
            <span style={{ fontSize: "0.8rem", fontWeight: "700", textTransform: "uppercase" }}>Total Plots</span>
            <Layers size={18} style={{ color: "#a7f3d0" }} />
          </div>
          <div style={{ fontSize: "2rem", fontWeight: "800", color: "var(--owner-text-primary)" }}>
            {totals.plots || 0}
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--owner-text-muted)", marginTop: "0.25rem" }}>Tracked real-estate units</div>
        </div>

        <div className="owner-card-neumorph" data-testid="owner-metric-inquiries">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", color: "var(--owner-text-muted)", marginBottom: "0.5rem" }}>
            <span style={{ fontSize: "0.8rem", fontWeight: "700", textTransform: "uppercase" }}>Inquiries</span>
            <MessageSquare size={18} style={{ color: "#fef08a" }} />
          </div>
          <div style={{ fontSize: "2rem", fontWeight: "800", color: "var(--owner-text-primary)" }}>
            {inquiries.new || 0} <span style={{ fontSize: "1rem", color: "var(--owner-text-muted)", fontWeight: "500" }}>/ {inquiries.total || 0}</span>
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--owner-text-muted)", marginTop: "0.25rem" }}>New / Total customer leads</div>
        </div>
      </div>

      {/* Inventory Status Breakdown & Shares Section */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "1.5rem" }}>
        {/* Inventory Breakdown */}
        <div className="owner-card-neumorph">
          <h3 style={{ fontSize: "1.1rem", fontWeight: "700", marginBottom: "1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Layers size={18} style={{ color: "var(--owner-accent)" }} />
            Platform Inventory Breakdown
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "0.75rem", textAlign: "center" }}>
            <div className="owner-card-inset">
              <div style={{ fontSize: "0.75rem", color: "var(--owner-text-muted)", textTransform: "uppercase", fontWeight: "700" }}>Available</div>
              <div style={{ fontSize: "1.4rem", fontWeight: "800", color: "#4ade80", marginTop: "0.25rem" }}>{statusCounts.available || 0}</div>
            </div>
            <div className="owner-card-inset">
              <div style={{ fontSize: "0.75rem", color: "var(--owner-text-muted)", textTransform: "uppercase", fontWeight: "700" }}>Hold</div>
              <div style={{ fontSize: "1.4rem", fontWeight: "800", color: "#fb923c", marginTop: "0.25rem" }}>{statusCounts.hold || 0}</div>
            </div>
            <div className="owner-card-inset">
              <div style={{ fontSize: "0.75rem", color: "var(--owner-text-muted)", textTransform: "uppercase", fontWeight: "700" }}>Reserved</div>
              <div style={{ fontSize: "1.4rem", fontWeight: "800", color: "#facc15", marginTop: "0.25rem" }}>{statusCounts.reserved || 0}</div>
            </div>
            <div className="owner-card-inset">
              <div style={{ fontSize: "0.75rem", color: "var(--owner-text-muted)", textTransform: "uppercase", fontWeight: "700" }}>Sold</div>
              <div style={{ fontSize: "1.4rem", fontWeight: "800", color: "#f87171", marginTop: "0.25rem" }}>{statusCounts.sold || 0}</div>
            </div>
            <div className="owner-card-inset">
              <div style={{ fontSize: "0.75rem", color: "var(--owner-text-muted)", textTransform: "uppercase", fontWeight: "700" }}>Blocked</div>
              <div style={{ fontSize: "1.4rem", fontWeight: "800", color: "#94a3b8", marginTop: "0.25rem" }}>{statusCounts.blocked || 0}</div>
            </div>
          </div>
        </div>

        {/* Shares Overview */}
        <div className="owner-card-neumorph">
          <h3 style={{ fontSize: "1.1rem", fontWeight: "700", marginBottom: "1rem" }}>
            Public Share Tokens
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--owner-text-secondary)", fontSize: "0.9rem" }}>Active Shared Links</span>
              <span style={{ fontWeight: "800", color: "#34d399" }}>{shares.active || 0}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--owner-text-secondary)", fontSize: "0.9rem" }}>Total Generated</span>
              <span style={{ fontWeight: "800" }}>{shares.total || 0}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--owner-text-secondary)", fontSize: "0.9rem" }}>Registry Deeds Attached</span>
              <span style={{ fontWeight: "800", color: "#818cf8" }}>{totals.registry_docs || 0}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Platform Activity */}
      <div className="owner-card-neumorph">
        <h3 style={{ fontSize: "1.1rem", fontWeight: "700", marginBottom: "1rem" }}>
          Recent Platform Audit Activity
        </h3>
        {recentActivity.length === 0 ? (
          <div style={{ color: "var(--owner-text-muted)", fontSize: "0.85rem" }}>No recent activity records.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {recentActivity.map((act) => (
              <div key={act.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.6rem 0.8rem", background: "var(--owner-bg)", borderRadius: "8px", border: "1px solid var(--owner-border)", fontSize: "0.85rem" }}>
                <div>
                  <strong style={{ color: "var(--owner-accent)" }}>{act.user_name || "System"}</strong>: {act.action ? act.action.replaceAll("_", " ") : "Action"} on <code>{act.entity_type}</code>
                </div>
                <span style={{ color: "var(--owner-text-muted)", fontSize: "0.75rem" }}>
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
