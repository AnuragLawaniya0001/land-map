import { useLocation } from "react-router-dom";
import PlatformSidebar from "@/components/PlatformSidebar";

export default function AdminLayout({ user, base, onLogout, children }) {
  const location = useLocation();
  const isSuper = user?.role === "super_admin";

  // Detect whether we are on a colony map page (e.g. /superadmin/colonies/:id or /admin/colonies/:id/canonical)
  const isColonyMapView = /\/colonies\/[^/]+(\/canonical)?$/.test(location.pathname);

  if (isColonyMapView) {
    return (
      <div className={`lm-admin lm-gis-immersive ${isSuper ? "super" : ""}`} data-testid={`${user.role}-shell`}>
        {/* Unified Platform Sidebar with Locked 220px Geometry */}
        <PlatformSidebar user={user} base={base} onLogout={onLogout} />

        {/* Full Bleed Main GIS Viewport */}
        <main className="lm-gis-viewport-main">{children}</main>
      </div>
    );
  }

  return (
    <div className={`lm-admin ${isSuper ? "super" : ""}`} data-testid={`${user.role}-shell`}>
      {/* Unified Platform Sidebar with Locked 220px Geometry */}
      <PlatformSidebar user={user} base={base} onLogout={onLogout} />

      <main className="lm-admin-main">{children}</main>
    </div>
  );
}
