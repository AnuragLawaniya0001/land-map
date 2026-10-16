import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { ArrowRight, ArrowUpRight, ShieldCheck, ShieldAlert, Eye, EyeOff, Building2, MapPin } from "lucide-react";
import { api, errMsg } from "@/lib/api";

export default function AdminLogin({ portal, onLogin, currentUser }) {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isSuper = portal.role === "super_admin";
  const switching = currentUser ? `Currently signed in as ${currentUser.name} (${currentUser.role.replace("_", " ")}). Signing in switches to this portal.` : "";

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (currentUser) await api.post("/auth/logout").catch(() => {});
      const r = await api.post("/auth/login", { email, password, portal: portal.role });
      await onLogin(r.data.user);
      nav(`${portal.base}/dashboard`, { replace: true });
    } catch (x) {
      setError(errMsg(x));
    } finally {
      setBusy(false);
    }
  };

  if (isSuper) {
    return (
      <main className="owner-login-shell" data-testid="super_admin-login-page">
        {/* Left Side: Brand & GIS Visual Identity */}
        <section className="owner-login-hero">
          <div className="owner-hero-bg-grid" />
          <div className="owner-hero-content">
            <div className="owner-hero-brand">
              <span className="owner-hero-logo"><Building2 size={24} /></span>
              <span className="owner-hero-title">Jasjot Sir Spacer Land</span>
            </div>

            <div className="owner-hero-tagline">
              <span className="owner-tag-badge">PLATFORM GOVERNANCE</span>
              <h1>Interactive Land Intelligence & Colony Control</h1>
              <p>
                Platform Owner Workspace for multi-tenant developer administration, colony inspection, GIS spatial oversight, and compliance audit logs.
              </p>
            </div>

            <div className="owner-hero-footer">
              <div className="owner-meta-pill">
                <MapPin size={14} className="text-emerald-400" />
                <span>Spatial Microservices Active</span>
              </div>
            </div>
          </div>
        </section>

        {/* Right Side: Secure Owner Workspace Sign In Form */}
        <section className="owner-login-form-panel">
          <div className="owner-login-card">
            <div className="owner-login-header">
              <span className="owner-badge">
                <ShieldAlert size={14} /> Restricted Access
              </span>
              <h2>Owner Workspace</h2>
              <p>Sign in with your platform owner credentials</p>
            </div>

            <form onSubmit={submit} data-testid="admin-login-form" className="space-y-4">
              {switching && <div className="owner-switch-note" data-testid="switch-note">{switching}</div>}
              
              <div className="owner-input-group">
                <label htmlFor="owner-email">Email Address</label>
                <input
                  id="owner-email"
                  data-testid="admin-login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter email address"
                  autoComplete="username"
                  required
                />
              </div>

              <div className="owner-input-group">
                <label htmlFor="owner-password">Password</label>
                <div className="relative">
                  <input
                    id="owner-password"
                    data-testid="admin-login-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password"
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    className="owner-password-toggle"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {error && <div className="owner-error-alert" data-testid="admin-login-error">{error}</div>}

              <button type="submit" disabled={busy} className="owner-submit-btn" data-testid="admin-login-submit">
                {busy ? "Authenticating…" : "Access Owner Workspace"}
                <ArrowRight size={18} />
              </button>
            </form>

            <div className="owner-login-footer">
              <span>Admin account? </span>
              <Link to="/admin" className="owner-link" data-testid="switch-to-admin">
                Go to Developer Admin Portal
              </Link>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className={`lm-login ${isSuper ? "super" : ""}`} data-testid={`${portal.role}-login-page`}>
      <section className="lm-login-art">
        <span className="lm-brand"><span className="lm-brand-dot" /> LiveMap</span>
        <div className="lm-login-copy">
          <p className="lm-eyebrow">{portal.eyebrow}</p>
          <h1>{portal.headline[0]} <em>{portal.headline[1]}</em><br />{portal.headline[2]}</h1>
          <p>{portal.blurb}</p>
        </div>
        <div className="lm-login-grid" />
      </section>

      <section className="lm-login-panel">
        <div className="lm-login-card">
          <div className="lm-login-badge">
            {isSuper ? <Crown size={14} /> : <ShieldCheck size={14} />} {isSuper ? "Restricted" : "Private"}
          </div>
          <h2>{portal.title}</h2>
          <p className="lm-muted">{portal.hint}</p>
          <form onSubmit={submit} data-testid="admin-login-form">
            {switching && <div className="lm-switch-note" data-testid="switch-note">{switching}</div>}
            <label>
              Email
              <input data-testid="admin-login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </label>
            <label>
              Password
              <input data-testid="admin-login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            {error && <div className="lm-error" data-testid="admin-login-error">{error}</div>}
            <button type="submit" disabled={busy} className="lm-btn-primary full" data-testid="admin-login-submit">
              {busy ? "Signing in…" : isSuper ? "Enter super admin" : "Enter workspace"}
              <ArrowUpRight size={16} />
            </button>
          </form>
          <p className="lm-login-hint">
            {isSuper ? (
              <>Admin account? <Link to="/admin" className="lm-text-link" data-testid="switch-to-admin">Admin portal</Link></>
            ) : (
              <>Platform owner? <Link to="/superadmin" className="lm-text-link" data-testid="switch-to-superadmin">Super admin portal</Link></>
            )}
          </p>
        </div>
      </section>
    </main>
  );
}
