import { Link, NavLink, useNavigate, useLocation } from "react-router-dom";
import { LayoutGrid, Map, Users, FileClock, LogOut, ShieldCheck, Copy, Crown, MessageSquare, Globe, Compass, Check } from "lucide-react";
import { api } from "@/lib/api";
import { useState } from "react";

export default function AdminLayout({ user, base, onLogout, children }) {
  const nav = useNavigate();
  const location = useLocation();
  const [copied, setCopied] = useState(false);
  const isSuper = user.role === "super_admin";
  const shareLink = isSuper ? `${window.location.origin}/` : `${window.location.origin}/u/${user.slug}`;

  // Detect whether we are on a colony map page (e.g. /superadmin/colonies/:id or /admin/colonies/:id/canonical)
  const isColonyMapView = /\/colonies\/[^/]+(\/canonical)?$/.test(location.pathname);

  const copyShare = async () => {
    await navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const logout = async () => {
    await api.post("/auth/logout").catch(() => {});
    onLogout();
    nav(base);
  };

  if (isColonyMapView) {
    return (
      <div className={`lm-admin lm-gis-immersive ${isSuper ? "super" : ""}`} data-testid={`${user.role}-shell`}>
        {/* Floating Left GIS Micro-Dock */}
        <aside className="lm-gis-floating-dock" aria-label="GIS Quick Navigation">
          <Link to={`${base}/dashboard`} className="lm-gis-dock-brand" title="LiveMap GIS - Dashboard">
            <span className="lm-brand-dot animate-pulse" />
            <Compass size={22} className="lm-gis-dock-compass" />
          </Link>

          <nav className="lm-gis-dock-nav">
            <NavLink to={`${base}/dashboard`} className="lm-gis-dock-item" title="Overview Dashboard" data-testid="nav-dashboard">
              <LayoutGrid size={18} />
              <span className="lm-gis-dock-tip">Overview</span>
            </NavLink>
            <NavLink to={`${base}/colonies`} className="lm-gis-dock-item" title={isSuper ? "All Colonies" : "My Colonies"} data-testid="nav-colonies">
              <Map size={18} />
              <span className="lm-gis-dock-tip">{isSuper ? "Colonies" : "My Colonies"}</span>
            </NavLink>
            <NavLink to={`${base}/public-portal`} className="lm-gis-dock-item" title="Public Portal" data-testid="nav-public-portal">
              <Globe size={18} />
              <span className="lm-gis-dock-tip">Portal</span>
            </NavLink>
            <NavLink to={`${base}/inquiries`} className="lm-gis-dock-item" title="Inquiries" data-testid="nav-inquiries">
              <MessageSquare size={18} />
              <span className="lm-gis-dock-tip">Inquiries</span>
            </NavLink>
            {isSuper && (
              <NavLink to={`${base}/admins`} className="lm-gis-dock-item" title="Admin Management" data-testid="nav-users">
                <Users size={18} />
                <span className="lm-gis-dock-tip">Admins</span>
              </NavLink>
            )}
            <NavLink to={`${base}/audit`} className="lm-gis-dock-item" title="Audit Trail" data-testid="nav-audit">
              <FileClock size={18} />
              <span className="lm-gis-dock-tip">Audit</span>
            </NavLink>
          </nav>

          <div className="lm-gis-dock-bottom">
            <button className={`lm-gis-dock-item ${copied ? "copied" : ""}`} onClick={copyShare} title={copied ? "Link Copied!" : "Copy Public Link"} data-testid="copy-share-link">
              {copied ? <Check size={18} className="text-emerald-400" /> : <Copy size={18} />}
              <span className="lm-gis-dock-tip">{copied ? "Copied!" : "Share Link"}</span>
            </button>
            <div className="lm-gis-dock-item lm-gis-dock-avatar" title={`${user.name} (${user.role})`}>
              <div className="lm-avatar sm">{user.name?.[0]?.toUpperCase()}</div>
              <span className="lm-gis-dock-tip">{user.name}</span>
            </div>
            <button className="lm-gis-dock-item text-rose-400 hover:text-rose-300" onClick={logout} title="Sign Out" data-testid="admin-logout">
              <LogOut size={18} />
              <span className="lm-gis-dock-tip">Logout</span>
            </button>
          </div>
        </aside>

        {/* Full Bleed Main GIS Viewport */}
        <main className="lm-gis-viewport-main">{children}</main>
      </div>
    );
  }

  return (
    <div className={`lm-admin ${isSuper ? "super" : ""}`} data-testid={`${user.role}-shell`}>
      <aside className="lm-admin-side">
        <Link to={`${base}/dashboard`} className="lm-brand"><span className="lm-brand-dot" />LiveMap</Link>
        <div className="lm-side-tag">{isSuper ? <><Crown size={10} /> SUPER ADMIN</> : "ADMIN WORKSPACE"}</div>

        <nav className="lm-side-nav">
          <NavLink to={`${base}/dashboard`} className="lm-side-link" data-testid="nav-dashboard"><LayoutGrid size={16} /> Overview</NavLink>
          <NavLink to={`${base}/colonies`} className="lm-side-link" data-testid="nav-colonies"><Map size={16} /> {isSuper ? "All colonies" : "My colonies"}</NavLink>
          <NavLink to={`${base}/public-portal`} className="lm-side-link" data-testid="nav-public-portal"><Globe size={16} /> Public Portal</NavLink>
          <NavLink to={`${base}/inquiries`} className="lm-side-link" data-testid="nav-inquiries"><MessageSquare size={16} /> Inquiries</NavLink>
          {isSuper && <NavLink to={`${base}/admins`} className="lm-side-link" data-testid="nav-users"><Users size={16} /> Admins</NavLink>}
          <NavLink to={`${base}/audit`} className="lm-side-link" data-testid="nav-audit"><FileClock size={16} /> Audit log</NavLink>
        </nav>

        <div className="lm-share-card" data-testid="share-card">
          <div className="lm-share-head"><ShieldCheck size={12} /><span>{isSuper ? "PLATFORM PUBLIC PAGE" : "YOUR PUBLIC LINK"}</span></div>
          <p>{isSuper ? "Lists every published colony on LiveMap." : "Shows only the colonies you add. No login option is shown to visitors."}</p>
          <button className="lm-share-btn" onClick={copyShare} data-testid="copy-share-link"><Copy size={12} /> {copied ? "Copied!" : "Copy link"}</button>
          <code className="lm-share-url">{shareLink.replace(window.location.origin, "")}</code>
        </div>

        <div className="lm-access-card" data-testid="access-card">
          <div className="lm-share-head"><span>{isSuper ? "FULL CONTROL" : "YOUR ACCESS"}</span></div>
          <ul>
            {isSuper ? (
              <>
                <li>Create & manage admins</li>
                <li>View / edit every colony</li>
                <li>Delete colonies</li>
                <li>Platform-wide audit log</li>
              </>
            ) : (
              <>
                <li>Add colonies under your link</li>
                <li>Edit only your own colonies</li>
                <li>Plot status & registry PDFs</li>
                <li>No access to other admins</li>
              </>
            )}
          </ul>
        </div>

        <div className="lm-side-foot">
          <div className="lm-side-user">
            <div className="lm-avatar">{user.name?.[0]?.toUpperCase()}</div>
            <div><b>{user.name}</b><small>{user.email}</small></div>
          </div>
          <button className="lm-icon-btn" onClick={logout} data-testid="admin-logout"><LogOut size={14} /></button>
        </div>
      </aside>
      <main className="lm-admin-main">{children}</main>
    </div>
  );
}
