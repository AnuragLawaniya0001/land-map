import { useEffect, useState } from "react";
import { useParams, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { PORTALS } from "@/lib/portal";
import PublicHome from "@/pages/PublicHome";
import PublicViewer from "@/pages/PublicViewer";
import AdminLogin from "@/pages/AdminLogin";
import AdminLayout from "@/pages/AdminLayout";
import AdminHome from "@/pages/AdminHome";
import AdminColonyMap from "@/pages/AdminColonyMap";
import AdminUsers from "@/pages/AdminUsers";
import AdminAudit from "@/pages/AdminAudit";
import AdminInquiries from "@/pages/AdminInquiries";
import SharedPropertyViewer from "@/pages/SharedPropertyViewer";
import OwnerLayout from "@/pages/OwnerLayout";
import OwnerDashboard from "@/pages/OwnerDashboard";
import OwnerAdmins from "@/pages/OwnerAdmins";
import OwnerColonies from "@/pages/OwnerColonies";
import OwnerInventory from "@/pages/OwnerInventory";
import OwnerInquiries from "@/pages/OwnerInquiries";
import OwnerAuditLog from "@/pages/OwnerAuditLog";
import OwnerAdminInspection from "@/pages/OwnerAdminInspection";
import AdminGisImportPreview from "@/pages/AdminGisImportPreview";
import AdminPublicPortal from "@/pages/AdminPublicPortal";
import PublicPortal from "@/pages/PublicPortal";
import PublicPreviewViewer from "@/pages/PublicPreviewViewer";
import CanonicalColonyMap from "@/pages/CanonicalColonyMap";
import AdminColonyShares from "@/pages/AdminColonyShares";
import SharedColonyViewer from "@/pages/SharedColonyViewer";
import "@/App.css";
import "@/map.css";

function PublicByOwner() {
  const { slug } = useParams();
  return <PublicHome ownerSlug={slug} />;
}

function OwnerRedirect() {
  const location = useLocation();
  const target = location.pathname.replace(/^\/owners?-panel/, "/superadmin") || "/superadmin";
  return <Navigate to={target} replace />;
}

function SuperAdminShell({ user, setUser }) {
  const base = "/superadmin";
  const location = useLocation();
  // Map viewport routes: /superadmin/colonies/:id or canonical 3D or GIS import
  const isMapView = /^\/superadmin\/colonies\/[^/]+/.test(location.pathname) || /canonical/.test(location.pathname) || /import/.test(location.pathname);

  if (isMapView) {
    return (
      <AdminLayout user={user} base={base} onLogout={() => setUser(false)}>
        <Routes>
          <Route path="colonies/:id" element={<AdminColonyMap user={user} />} />
          <Route path="colonies/:id/canonical" element={<CanonicalColonyMap />} />
          <Route path="colonies/:colonyId/import" element={<AdminGisImportPreview />} />
          <Route path="colonies/:colonyId/import/:importId" element={<AdminGisImportPreview />} />
          <Route path="admins/:adminId/inspect/colonies/:colonyId/canonical" element={<CanonicalColonyMap />} />
          <Route path="*" element={<Navigate to="colonies" replace />} />
        </Routes>
      </AdminLayout>
    );
  }

  return (
    <OwnerLayout user={user} base={base} onLogout={() => setUser(false)}>
      <Routes>
        <Route path="/" element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<OwnerDashboard user={user} />} />
        <Route path="colonies" element={<OwnerColonies user={user} />} />
        <Route path="admins" element={<OwnerAdmins />} />
        <Route path="admins/:adminId/inspect" element={<OwnerAdminInspection />} />
        <Route path="admins/:adminId/inspect/colonies/:colonyId" element={<OwnerAdminInspection />} />
        <Route path="admins/:adminId/inspect/colonies/:colonyId/plots/:plotId" element={<OwnerAdminInspection />} />
        <Route path="inventory" element={<OwnerInventory user={user} />} />
        <Route path="inquiries" element={<OwnerInquiries />} />
        <Route path="share-colonies" element={<AdminColonyShares user={user} />} />
        <Route path="audit" element={<OwnerAuditLog />} />
        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </OwnerLayout>
  );
}

function SuperAdminRoute({ user, setUser }) {
  const { pathname } = useLocation();
  const base = "/superadmin";
  const atRoot = pathname.replace(/\/+$/, "") === base || pathname === `${base}/login`;
  const isSuper = user && user.role === "super_admin";

  if (atRoot) {
    if (isSuper) return <Navigate to={`${base}/dashboard`} replace />;
    return <AdminLogin portal={PORTALS.super_admin} onLogin={setUser} currentUser={user || null} />;
  }

  if (!user) {
    return <Navigate to={`${base}/login`} replace />;
  }

  if (!isSuper) {
    return <Navigate to="/admin/dashboard" replace />;
  }

  return <SuperAdminShell user={user} setUser={setUser} />;
}

function AdminShell({ user, setUser }) {
  const base = "/admin";
  return (
    <AdminLayout user={user} base={base} onLogout={() => setUser(false)}>
      <Routes>
        <Route path="/" element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<AdminHome user={user} />} />
        <Route path="colonies" element={<OwnerColonies user={user} />} />
        <Route path="colonies/:id" element={<AdminColonyMap user={user} />} />
        <Route path="colonies/:id/canonical" element={<CanonicalColonyMap />} />
        <Route path="colonies/:colonyId/import" element={<AdminGisImportPreview />} />
        <Route path="colonies/:colonyId/import/:importId" element={<AdminGisImportPreview />} />
        <Route path="public-portal" element={<AdminPublicPortal />} />
        <Route path="inventory" element={<OwnerInventory user={user} />} />
        <Route path="inquiries" element={<AdminInquiries />} />
        <Route path="share-colonies" element={<AdminColonyShares user={user} />} />
        <Route path="audit" element={<AdminAudit />} />
        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </AdminLayout>
  );
}

function AdminRoute({ user, setUser }) {
  const { pathname } = useLocation();
  const base = "/admin";
  const atRoot = pathname.replace(/\/+$/, "") === base || pathname === `${base}/login`;
  const isAdmin = user && (user.role === "admin" || user.role === "super_admin");

  if (atRoot) {
    if (isAdmin) return <Navigate to={`${base}/dashboard`} replace />;
    return <AdminLogin portal={PORTALS.admin} onLogin={setUser} currentUser={user || null} />;
  }

  if (!user) {
    return <Navigate to={`${base}/login`} replace />;
  }

  return <AdminShell user={user} setUser={setUser} />;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api.get("/auth/me").then((r) => setUser(r.data)).catch(() => setUser(false)).finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="lm-loading">Starting LiveMap…</div>;

  return (
    <Routes>
      <Route path="/" element={<PublicHome />} />
      <Route path="/u/:slug" element={<PublicByOwner />} />
      <Route path="/project/:slug" element={<PublicViewer />} />
      <Route path="/share/:token" element={<SharedPropertyViewer />} />
      <Route path="/c/share/:token" element={<SharedColonyViewer />} />
      <Route path="/share-colony/:token" element={<SharedColonyViewer />} />
      <Route path="/preview/:previewToken" element={<PublicPreviewViewer />} />
      <Route path="/portal/:token" element={<PublicPortal />} />
      <Route path="/admin/*" element={<AdminRoute user={user} setUser={setUser} />} />
      <Route path="/superadmin/*" element={<SuperAdminRoute user={user} setUser={setUser} />} />
      <Route path="/owner-panel/*" element={<OwnerRedirect />} />
      <Route path="/owners-panel/*" element={<OwnerRedirect />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
