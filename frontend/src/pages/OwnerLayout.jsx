import { useState, useEffect } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { LayoutGrid, Map, Users, Layers, MessageSquare, FileClock, LogOut, Moon, Sun, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";

export default function OwnerLayout({ user, onLogout, children }) {
  const nav = useNavigate();
  const [theme, setTheme] = useState(() => localStorage.getItem("spacer_theme") || "dark");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("spacer_theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const logout = async () => {
    await api.post("/auth/logout").catch(() => {});
    onLogout();
    nav("/owner-panel/login");
  };

  return (
    <div className="owner-shell" data-theme={theme} data-testid="owner-control-shell">
      {/* Neomorphic Owner Sidebar */}
      <aside className="owner-sidebar">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Link to="/owner-panel/dashboard" className="owner-brand">
            <span>Spacer</span>
            <span className="owner-brand-badge">SUPER ADMIN</span>
          </Link>
        </div>
        <div style={{ fontSize: "0.75rem", color: "var(--owner-text-muted)", marginTop: "0.2rem", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Platform Owner Control
        </div>

        <nav className="owner-nav-group">
          <NavLink to="/owner-panel/dashboard" className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`} data-testid="owner-nav-dashboard">
            <LayoutGrid size={18} />
            <span>Overview</span>
          </NavLink>
          <NavLink to="/owner-panel/colonies" className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`} data-testid="owner-nav-colonies">
            <Map size={18} />
            <span>All Colonies</span>
          </NavLink>
          <NavLink to="/owner-panel/admins" className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`} data-testid="owner-nav-admins">
            <Users size={18} />
            <span>Admins</span>
          </NavLink>
          <NavLink to="/owner-panel/inventory" className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`} data-testid="owner-nav-inventory">
            <Layers size={18} />
            <span>Inventory</span>
          </NavLink>
          <NavLink to="/owner-panel/inquiries" className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`} data-testid="owner-nav-inquiries">
            <MessageSquare size={18} />
            <span>Inquiries</span>
          </NavLink>
          <NavLink to="/owner-panel/audit" className={({ isActive }) => `owner-nav-item ${isActive ? "active" : ""}`} data-testid="owner-nav-audit">
            <FileClock size={18} />
            <span>Audit Log</span>
          </NavLink>
        </nav>

        {/* Theme Toggle & User Info Footer */}
        <div style={{ marginTop: "auto", paddingTop: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <button
            onClick={toggleTheme}
            className="owner-btn-secondary"
            style={{ width: "100%", justifyContent: "center" }}
            data-testid="owner-theme-toggle"
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
          </button>

          <div className="owner-card-inset" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ overflow: "hidden" }}>
              <div style={{ fontWeight: "700", fontSize: "0.85rem", color: "var(--owner-text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {user.name}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--owner-text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {user.email}
              </div>
            </div>
            <button
              onClick={logout}
              style={{ background: "transparent", border: "none", color: "#fca5a5", cursor: "pointer", padding: "0.4rem" }}
              data-testid="owner-logout-btn"
              title="Logout"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main style={{ flex: 1, padding: "2rem", overflowY: "auto" }}>
        {children}
      </main>
    </div>
  );
}
