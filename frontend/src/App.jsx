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
import "@/App.css";
import "@/map.css";

function PublicByOwner() {
  const { slug } = useParams();
  return <PublicHome ownerSlug={slug} />;
}

function OwnerPortalShell({ user, setUser }) {
  return (
    <OwnerLayout user={user} onLogout={() => setUser(false)}>
      <Routes>
        <Route path="/" element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<OwnerDashboard user={user} />} />
        <Route path="admins" element={<OwnerAdmins />} />
        <Route path="admins/:adminId/inspect" element={<OwnerAdminInspection />} />
        <Route path="admins/:adminId/inspect/colonies/:colonyId" element={<OwnerAdminInspection />} />
        <Route path="admins/:adminId/inspect/colonies/:colonyId/plots/:plotId" element={<OwnerAdminInspection />} />
        <Route path="colonies" element={<OwnerColonies />} />
        <Route path="colonies/:id/canonical" element={<CanonicalColonyMap />} />
        <Route path="admins/:adminId/inspect/colonies/:colonyId/canonical" element={<CanonicalColonyMap />} />
        <Route path="inventory" element={<OwnerInventory />} />
        <Route path="inquiries" element={<OwnerInquiries />} />
        <Route path="audit" element={<OwnerAuditLog />} />
        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </OwnerLayout>
  );
}

function OwnerRoute({ user, setUser }) {
  const { pathname } = useLocation();
  const base = "/owner-panel";
  const atRoot = pathname.replace(/\/+$/, "") === base || pathname === `${base}/login`;
  const matches = user && user.role === "super_admin";
  if (atRoot) {
    if (matches) return <Navigate to={`${base}/dashboard`} replace />;
    return <AdminLogin portal={PORTALS.owner} onLogin={setUser} currentUser={user || null} />;
  }
  if (!matches) return <Navigate to={base} replace />;
  return <OwnerPortalShell user={user} setUser={setUser} />;
}

function PortalShell({ portal, user, setUser }) {
  return (
    <AdminLayout user={user} base={portal.base} onLogout={() => setUser(false)}>
      <Routes>
        <Route path="/" element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<AdminHome user={user} />} />
        <Route path="colonies" element={<AdminHome user={user} />} />
        <Route path="colonies/:id" element={<AdminColonyMap user={user} />} />
        <Route path="colonies/:id/canonical" element={<CanonicalColonyMap />} />
        <Route path="colonies/:colonyId/import" element={<AdminGisImportPreview />} />
        <Route path="colonies/:colonyId/import/:importId" element={<AdminGisImportPreview />} />
        <Route path="public-portal" element={<AdminPublicPortal />} />
        <Route path="inquiries" element={<AdminInquiries />} />
        {portal.role === "super_admin" && <Route path="admins" element={<AdminUsers />} />}
        <Route path="audit" element={<AdminAudit />} />
        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </AdminLayout>
  );
}

function PortalRoute({ portal, user, setUser }) {
  const { pathname } = useLocation();
  const atRoot = pathname.replace(/\/+$/, "") === portal.base || pathname === `${portal.base}/login`;
  const matches = user && user.role === portal.role;
  if (atRoot) {
    if (matches) return <Navigate to={`${portal.base}/dashboard`} replace />;
    return <AdminLogin portal={portal} onLogin={setUser} currentUser={user || null} />;
  }
  if (!matches) return <Navigate to={portal.base} replace />;
  return <PortalShell portal={portal} user={user} setUser={setUser} />;
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
      <Route path="/preview/:previewToken" element={<PublicPreviewViewer />} />
      <Route path="/portal/:token" element={<PublicPortal />} />
      <Route path="/admin/*" element={<PortalRoute portal={PORTALS.admin} user={user} setUser={setUser} />} />
      <Route path="/superadmin/*" element={<PortalRoute portal={PORTALS.super_admin} user={user} setUser={setUser} />} />
      <Route path="/owner-panel/*" element={<OwnerRoute user={user} setUser={setUser} />} />
      <Route path="/owners-panel/*" element={<Navigate to="/owner-panel" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
