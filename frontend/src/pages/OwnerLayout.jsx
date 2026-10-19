import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import PlatformSidebar from "@/components/PlatformSidebar";

export default function OwnerLayout({ user, base, onLogout, children }) {
  const nav = useNavigate();
  const currentBase = base || "/superadmin";
  const [theme, setTheme] = useState(() => localStorage.getItem("livemap_theme") || "light");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("livemap_theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const logout = async () => {
    await api.post("/auth/logout").catch(() => {});
    onLogout();
    nav(`${currentBase}/login`);
  };

  return (
    <div className="owner-shell" data-theme={theme} data-testid="owner-control-shell">
      {/* Unified Platform Sidebar with Locked 220px Geometry */}
      <PlatformSidebar user={user} base={currentBase} onLogout={onLogout} />

      {/* Main Content Area - Anchored Scrolling */}
      <main className="owner-main-content" style={{ flex: 1, height: "100vh", overflowY: "auto", padding: "2rem" }}>
        {children}
      </main>
    </div>
  );
}
