import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  ArrowRight,
  ShieldCheck,
  ShieldAlert,
  Eye,
  EyeOff,
  Crown,
  Lock,
  Mail,
  Compass,
  Layers,
  Sparkles,
  Share2,
} from "lucide-react";
import { api, errMsg } from "@/lib/api";

export default function AdminLogin({ portal, onLogin, currentUser }) {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isSuper = portal.role === "super_admin";
  const switching = currentUser
    ? `Currently signed in as ${currentUser.name} (${currentUser.role.replace("_", " ")}). Signing in switches to this portal.`
    : "";

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

  return (
    <main
      className="min-h-screen grid grid-cols-1 lg:grid-cols-12 bg-[#FAF8F5] text-[#172A25] font-sans"
      data-testid={`${portal.role}-login-page`}
    >
      {/* =====================================================================
          LEFT HERO SIDE: GIS & SPATIAL BRAND IDENTITY
          ===================================================================== */}
      <section className="lg:col-span-7 xl:col-span-7 bg-gradient-to-br from-[#0F2922] via-[#173F35] to-[#12362E] p-8 lg:p-14 xl:p-16 flex flex-col justify-between relative overflow-hidden text-white border-b lg:border-b-0 lg:border-r border-[#DCD2BE]">
        {/* Subtle geometric coordinate grid background */}
        <div
          className="absolute inset-0 pointer-events-none opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #FFFFFF 1px, transparent 1px), linear-gradient(to bottom, #FFFFFF 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />

        {/* Soft glowing ambient orbs */}
        <div className="absolute -top-32 -left-32 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-emerald-400/10 rounded-full blur-3xl pointer-events-none" />

        {/* Top Brand Bar */}
        <div className="relative z-10">
          <div className="flex items-center gap-3.5">
            <img
              src="/logo.png"
              alt="LiveMap"
              className="w-12 h-12 object-contain filter drop-shadow-md flex-shrink-0"
            />
            <div className="flex flex-col">
              <div className="flex items-center gap-2.5">
                <span
                  style={{
                    fontFamily: "'Plus Jakarta Sans', 'Inter', system-ui, sans-serif",
                    fontWeight: 900,
                    letterSpacing: "-0.035em",
                    color: "#FFFFFF",
                    fontSize: "2rem",
                    lineHeight: 1,
                    textRendering: "geometricPrecision",
                  }}
                >
                  LiveMap
                </span>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 whitespace-nowrap">
                  {isSuper ? "Super Admin" : "Developer Studio"}
                </span>
              </div>
              <span className="text-[11px] font-semibold text-emerald-200/70 uppercase tracking-widest mt-0.5">
                Platform Control Studio
              </span>
            </div>
          </div>
        </div>

        {/* Middle Hero Copy & Capabilities */}
        <div className="relative z-10 py-12 lg:py-0 my-auto max-w-xl space-y-6">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/10 backdrop-blur-md border border-white/15 text-emerald-200 text-xs font-bold tracking-wide shadow-sm">
            <Sparkles size={14} className="text-emerald-300" />
            <span>
              {isSuper
                ? "PLATFORM GOVERNANCE & GIS OVERSIGHT"
                : "REAL-TIME GIS MASTERPLANS & INVENTORY"}
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white leading-[1.12] tracking-tight">
            {isSuper ? (
              <>
                Govern Every Colony &amp;{" "}
                <span className="text-emerald-300 underline decoration-emerald-400/40 underline-offset-4">
                  Admin Workspace
                </span>
                .
              </>
            ) : (
              <>
                Manage, Plot &amp; Showcase Colonies with{" "}
                <span className="text-emerald-300 underline decoration-emerald-400/40 underline-offset-4">
                  Spatial Precision
                </span>
                .
              </>
            )}
          </h1>

          <p className="text-sm sm:text-base text-emerald-100/80 leading-relaxed font-normal">
            {isSuper
              ? "Full platform control for platform owners: supervise developer workspaces, review cadastral GIS alignments, calibrate CAD layouts, and audit compliance logs."
              : "Access your real-time colony masterplans, update live plot availability, configure device-restricted 2D/3D share links, and track buyer inquiries in one unified studio."}
          </p>

          {/* Value Proposition Highlights */}
          <div className="space-y-3 pt-3">
            <div className="flex items-center gap-3.5 p-3 rounded-2xl bg-white/[0.06] border border-white/10 backdrop-blur-sm transition hover:bg-white/10">
              <div className="w-9 h-9 rounded-xl bg-emerald-400/15 flex items-center justify-center text-emerald-300 shrink-0">
                <Compass size={18} />
              </div>
              <div>
                <h4 className="text-xs font-bold text-white">2D &amp; 3D Interactive Masterplans</h4>
                <p className="text-[11px] text-emerald-200/70">
                  Real-time vector boundaries, satellite basemaps, and smooth 3D plot exploration.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3.5 p-3 rounded-2xl bg-white/[0.06] border border-white/10 backdrop-blur-sm transition hover:bg-white/10">
              <div className="w-9 h-9 rounded-xl bg-emerald-400/15 flex items-center justify-center text-emerald-300 shrink-0">
                <Share2 size={18} />
              </div>
              <div>
                <h4 className="text-xs font-bold text-white">Device-Restricted Share Studio</h4>
                <p className="text-[11px] text-emerald-200/70">
                  Generate secure links for clients with strict device limits and instant breach killswitches.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3.5 p-3 rounded-2xl bg-white/[0.06] border border-white/10 backdrop-blur-sm transition hover:bg-white/10">
              <div className="w-9 h-9 rounded-xl bg-emerald-400/15 flex items-center justify-center text-emerald-300 shrink-0">
                <Layers size={18} />
              </div>
              <div>
                <h4 className="text-xs font-bold text-white">Live Plot Inventory &amp; Legal Registry</h4>
                <p className="text-[11px] text-emerald-200/70">
                  Instant status updates (Available, Booked, Sold) with legal deed PDF lineage tracking.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Status Indicator */}
        <div className="relative z-10 pt-4 flex items-center justify-between text-xs text-emerald-200/70">
          <div className="flex items-center gap-2 font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400"></span>
            </span>
            <span>Spatial GIS Engine Active</span>
          </div>
          <span className="text-[11px] opacity-75">Secure 256-Bit SSL</span>
        </div>
      </section>

      {/* =====================================================================
          RIGHT FORM PANEL: SECURE LOGIN CARD
          ===================================================================== */}
      <section className="lg:col-span-5 xl:col-span-5 flex items-center justify-center p-6 sm:p-10 lg:p-12 bg-[#FAF8F5]">
        <div className="w-full max-w-md bg-white rounded-3xl p-7 sm:p-9 shadow-xl border border-[#DCD2BE] space-y-6">
          {/* Card Header */}
          <div>
            <div className="flex items-center gap-3 mb-4">
              <img
                src="/logo.png"
                alt="LiveMap"
                className="w-11 h-11 object-contain drop-shadow-sm flex-shrink-0"
              />
              <div className="flex flex-col">
                <span
                  style={{
                    fontFamily: "'Plus Jakarta Sans', 'Inter', system-ui, sans-serif",
                    fontWeight: 900,
                    fontSize: "1.65rem",
                    color: "#0A1612",
                    letterSpacing: "-0.035em",
                    lineHeight: 1,
                    textRendering: "geometricPrecision",
                  }}
                >
                  LiveMap
                </span>
                <span className="text-[10px] font-bold text-[#5C6470] uppercase tracking-wider mt-1">
                  Spatial Intelligence Studio
                </span>
              </div>
            </div>

            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-[#F3EFE6] text-[#173F35] border border-[#DCD2BE] mb-3">
              {isSuper ? (
                <Crown size={13} className="text-amber-600" />
              ) : (
                <ShieldCheck size={13} className="text-[#173F35]" />
              )}
              <span>{isSuper ? "Restricted Platform Access" : "Private Developer Workspace"}</span>
            </div>

            <h2 className="text-2xl font-black text-[#172A25] tracking-tight">
              {isSuper ? "Owner Workspace Sign In" : "Developer Admin Sign In"}
            </h2>

            <p className="text-xs text-[#5C6470] mt-1.5 leading-relaxed">
              {isSuper
                ? "Authorized platform administrator credentials required to manage developer tenants and spatial governance."
                : "Sign in with your authorized credentials to access and manage your assigned colonies and plots."}
            </p>
          </div>

          {/* Form */}
          <form onSubmit={submit} data-testid="admin-login-form" className="space-y-4">
            {switching && (
              <div
                className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-800 font-medium"
                data-testid="switch-note"
              >
                {switching}
              </div>
            )}

            {error && (
              <div
                className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-start gap-2 font-medium"
                data-testid="admin-login-error"
              >
                <ShieldAlert size={16} className="text-rose-600 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Email Field */}
            <div className="space-y-1.5">
              <label htmlFor="admin-email-input" className="block text-xs font-bold text-[#172A25]">
                Email Address
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[#5C6470]">
                  <Mail size={16} />
                </div>
                <input
                  id="admin-email-input"
                  data-testid="admin-login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter email address"
                  autoComplete="username"
                  required
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#FAF8F5] border border-[#DCD2BE] text-xs font-bold text-[#172A25] outline-none transition focus:bg-white focus:border-[#173F35] focus:ring-2 focus:ring-[#173F35]/15"
                />
              </div>
            </div>

            {/* Password Field */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="admin-password-input" className="block text-xs font-bold text-[#172A25]">
                  Password
                </label>
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[#5C6470]">
                  <Lock size={16} />
                </div>
                <input
                  id="admin-password-input"
                  data-testid="admin-login-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  autoComplete="current-password"
                  required
                  className="w-full pl-10 pr-11 py-2.5 rounded-xl bg-[#FAF8F5] border border-[#DCD2BE] text-xs font-bold text-[#172A25] outline-none transition focus:bg-white focus:border-[#173F35] focus:ring-2 focus:ring-[#173F35]/15"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-[#5C6470] hover:text-[#172A25] transition"
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={busy}
              data-testid="admin-login-submit"
              className="w-full mt-2 py-3 px-5 rounded-xl bg-gradient-to-r from-[#173F35] to-[#0F2922] hover:from-[#1E5144] hover:to-[#173F35] text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-[#173F35]/20 transition-all transform active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              {busy ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    ></path>
                  </svg>
                  Authenticating…
                </span>
              ) : (
                <>
                  <span>{isSuper ? "Access Owner Workspace" : "Enter Developer Workspace"}</span>
                  <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>

          {/* Card Footer - Only shown for Super Admin */}
          {isSuper && (
            <div className="pt-4 border-t border-[#DCD2BE] flex flex-col items-center gap-2 text-center text-xs text-[#5C6470]">
              <span>
                Developer Account?{" "}
                <Link
                  to="/admin"
                  data-testid="switch-to-admin"
                  className="font-bold text-[#173F35] hover:underline"
                >
                  Go to Developer Admin Portal →
                </Link>
              </span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
