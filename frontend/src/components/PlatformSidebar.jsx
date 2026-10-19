import { Link, NavLink, useNavigate } from "react-router-dom";
import {
  LayoutGrid,
  Map,
  Users,
  Layers,
  MessageSquare,
  FileClock,
  LogOut,
  ShieldCheck,
  Compass,
  Share2,
} from "lucide-react";
import { api } from "@/lib/api";

export default function PlatformSidebar({ user, base, onLogout }) {
  const nav = useNavigate();
  const currentBase = base || (user?.role === "super_admin" ? "/superadmin" : "/admin");
  const isSuper = user?.role === "super_admin";

  const handleLogout = async () => {
    await api.post("/auth/logout").catch(() => {});
    if (onLogout) onLogout();
    nav(`${currentBase}/login`);
  };

  return (
    <aside
      className="owner-sidebar"
      style={{
        width: "236px",
        minWidth: "236px",
        maxWidth: "236px",
        boxSizing: "border-box",
        flexShrink: 0,
      }}
      aria-label="Platform Studio Navigation"
    >
      {/* Brand Header */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", paddingBottom: "0.85rem", borderBottom: "1px solid rgba(220, 210, 190, 0.7)" }}>
        <Link
          to={`${currentBase}/dashboard`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            textDecoration: "none",
          }}
        >
          <img
            src="/logo.png"
            alt="LiveMap"
            style={{
              width: "42px",
              height: "42px",
              objectFit: "contain",
              flexShrink: 0,
              filter: "drop-shadow(0 2px 5px rgba(23, 63, 53, 0.15))",
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
            <span
              style={{
                color: "#0A1612",
                fontWeight: 900,
                fontSize: "1.35rem",
                letterSpacing: "-0.035em",
                lineHeight: 1.1,
                fontFamily: "'Plus Jakarta Sans', 'Inter', system-ui, sans-serif",
                textRendering: "geometricPrecision",
              }}
            >
              LiveMap
            </span>
            <div style={{ display: "flex", alignItems: "center", marginTop: "0.25rem" }}>
              <span
                style={{
                  fontSize: "0.62rem",
                  fontWeight: 800,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  background: isSuper ? "#173F35" : "#E8F0EC",
                  color: isSuper ? "#FFFFFF" : "#173F35",
                  border: isSuper ? "1px solid #173F35" : "1px solid #C2E3D4",
                  padding: "0.15rem 0.5rem",
                  borderRadius: "999px",
                  whiteSpace: "nowrap",
                  display: "inline-block",
                  lineHeight: 1.2,
                }}
              >
                {isSuper ? "Super Admin" : "Admin"}
              </span>
            </div>
          </div>
        </Link>
        <div
          style={{
            fontSize: "0.65rem",
            color: "#5C6470",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            paddingLeft: "2px",
            marginTop: "0.1rem",
          }}
        >
          {isSuper ? "Platform Control Studio" : "Developer Workspace"}
        </div>
      </div>

      {/* Nav Items */}
      <nav className="owner-nav-group">
        <NavLink
          to={`${currentBase}/dashboard`}
          className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`}
          data-testid="owner-nav-dashboard"
        >
          <LayoutGrid size={18} />
          <span>Overview</span>
        </NavLink>

        <NavLink
          to={`${currentBase}/colonies`}
          className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`}
          data-testid="owner-nav-colonies"
        >
          <Map size={18} />
          <span>{isSuper ? "All Colonies" : "My Colonies"}</span>
        </NavLink>

        {isSuper && (
          <NavLink
            to={`${currentBase}/admins`}
            className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`}
            data-testid="owner-nav-admins"
          >
            <Users size={18} />
            <span>Admins</span>
          </NavLink>
        )}

        <NavLink
          to={`${currentBase}/inventory`}
          className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`}
          data-testid="owner-nav-inventory"
        >
          <Layers size={18} />
          <span>Inventory</span>
        </NavLink>

        <NavLink
          to={`${currentBase}/inquiries`}
          className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`}
          data-testid="owner-nav-inquiries"
        >
          <MessageSquare size={18} />
          <span>Inquiries</span>
        </NavLink>

        <NavLink
          to={`${currentBase}/share-colonies`}
          className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`}
          data-testid="owner-nav-share-colonies"
        >
          <Share2 size={18} />
          <span>Share Colony</span>
        </NavLink>

        <NavLink
          to={`${currentBase}/audit`}
          className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`}
          data-testid="owner-nav-audit"
        >
          <FileClock size={18} />
          <span>Audit Log</span>
        </NavLink>
      </nav>

      {/* Unified Bottom Footer: User Profile Card with Logout */}
      <div
        style={{
          marginTop: "auto",
          paddingTop: "1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        <div
          className="owner-card-inset"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.75rem",
            background: "#F7F3EB",
            borderColor: "#DCD2BE",
            padding: "0.6rem 0.75rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", overflow: "hidden" }}>
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "999px",
                background: "#173F35",
                border: "1px solid #173F35",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: "800",
                fontSize: "0.8rem",
                color: "#FFFFFF",
                flexShrink: 0,
              }}
            >
              {(user?.name || "A")[0].toUpperCase()}
            </div>
            <div style={{ overflow: "hidden" }}>
              <div
                style={{
                  fontWeight: "700",
                  fontSize: "0.82rem",
                  color: "var(--owner-text-primary, #172A25)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {user?.name || "Admin"}
              </div>
              <div
                style={{
                  fontSize: "0.72rem",
                  color: "var(--owner-text-muted, #5C6470)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {user?.email || "admin@livemap.com"}
              </div>
            </div>
          </div>
          <button
            onClick={handleLogout}
            style={{
              background: "rgba(239, 68, 68, 0.12)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              color: "#f87171",
              cursor: "pointer",
              padding: "0.45rem",
              borderRadius: "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 0.2s ease",
              flexShrink: 0,
            }}
            data-testid="owner-logout-btn"
            title="Logout"
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}
