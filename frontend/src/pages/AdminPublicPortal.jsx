import React, { useState, useEffect } from "react";
import { api, errMsg } from "@/lib/api";
import {
  Globe, ShieldAlert, Clock, Smartphone, Copy, Check, RefreshCw, XCircle, AlertTriangle
} from "lucide-react";

export default function AdminPublicPortal() {
  const [portal, setPortal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form states
  const [accessMode, setAccessMode] = useState("TIME_BASED"); // TIME_BASED or DEVICE_BASED
  const [durationMinutes, setDurationMinutes] = useState(10);
  const [maxDevices, setMaxDevices] = useState(5);
  const [newPortalUrl, setNewPortalUrl] = useState("");

  const fetchPortal = async () => {
    try {
      setLoading(true);
      const res = await api.get("/admin/public-portal");
      setPortal(res.data.portal);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPortal();
  }, []);

  const handleGeneratePortal = async (e) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    setNewPortalUrl("");

    try {
      const res = await api.post("/admin/public-portal", {
        access_mode: accessMode,
        duration_minutes: durationMinutes,
        max_devices: maxDevices,
      });

      const fullUrl = `${window.location.origin}${res.data.portal.portal_url}`;
      setNewPortalUrl(fullUrl);
      fetchPortal();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async () => {
    if (!window.confirm("Revoke active public portal? All active public sessions will immediately lose access.")) return;
    try {
      await api.post("/admin/public-portal/revoke");
      fetchPortal();
      setNewPortalUrl("");
    } catch (err) {
      alert(errMsg(err));
    }
  };

  const handleCopy = () => {
    if (!newPortalUrl) return;
    navigator.clipboard.writeText(newPortalUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div className="lm-page-container" data-testid="admin-public-portal-page">
      <header className="lm-modern-header">
        <div className="lm-modern-header-left">
          <span className="lm-modern-eyebrow">Controlled Public Access</span>
          <h1 className="lm-modern-title">Multi-Colony Showcase Portal</h1>
          <p className="lm-modern-subtitle">
            Generate controlled, time-based or device-limited public showcase links for your active colonies.
          </p>
        </div>
      </header>

      {loading ? (
        <div className="lm-modern-card p-12 text-center text-sm text-slate-400 animate-pulse">
          Loading public portal status...
        </div>
      ) : (
        <div className="space-y-6 max-w-4xl">
          {/* CURRENT PORTAL STATUS CARD */}
          {portal && (
            <div className="lm-modern-card space-y-4">
              <div className="flex items-center justify-between border-b border-[#E8E2D5] pb-3">
                <div className="flex items-center gap-2">
                  <Globe className="text-[#164E3F]" size={18} />
                  <h2 className="font-serif font-bold text-base text-[#0F1E36]">Active Showcase Configuration</h2>
                </div>
                <span className={`lm-badge ${
                  portal.status === "ACTIVE" ? "lm-badge-success" :
                  portal.status === "DEVICE_LIMIT_BREACHED" ? "lm-badge-danger" :
                  "lm-badge-warning"
                }`}>
                  <span className="lm-badge-dot" />
                  {portal.status}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                <div className="p-3 bg-[#FAF8F5] border border-[#E8E2D5] rounded-xl">
                  <div className="text-[10px] uppercase text-[#64748B] font-sans font-semibold">Access Mode</div>
                  <div className="font-bold text-xs text-[#164E3F] mt-1">{portal.access_mode}</div>
                </div>
                <div className="p-3 bg-[#FAF8F5] border border-[#E8E2D5] rounded-xl">
                  <div className="text-[10px] uppercase text-[#64748B] font-sans font-semibold">Time Expiry</div>
                  <div className="font-bold text-xs text-[#0F1E36] mt-1">
                    {portal.expires_at ? new Date(portal.expires_at).toLocaleTimeString() : "No Limit"}
                  </div>
                </div>
                <div className="p-3 bg-[#FAF8F5] border border-[#E8E2D5] rounded-xl">
                  <div className="text-[10px] uppercase text-[#64748B] font-sans font-semibold">Max Devices</div>
                  <div className="font-bold text-xs text-[#0F1E36] mt-1">{portal.max_devices} Devices</div>
                </div>
                <div className="p-3 bg-[#FAF8F5] border border-[#E8E2D5] rounded-xl">
                  <div className="text-[10px] uppercase text-[#64748B] font-sans font-semibold">Active Sessions</div>
                  <div className="font-bold text-xs text-[#164E3F] mt-1">{portal.active_sessions_count} Active</div>
                </div>
              </div>

              {portal.status === "ACTIVE" && (
                <div className="pt-2 flex justify-end">
                  <button
                    onClick={handleRevoke}
                    className="text-xs font-semibold px-4 py-2 rounded-xl border border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100 transition-all"
                    data-testid="revoke-portal-btn"
                  >
                    Revoke Active Showcase Link
                  </button>
                </div>
              )}
            </div>
          )}

          {/* NEW PORTAL LINK NOTICE */}
          {newPortalUrl && (
            <div className="p-4 rounded-xl lm-modern-card border border-emerald-300 bg-emerald-50/70 space-y-3">
              <div className="flex items-center gap-2 text-[#164E3F] font-bold text-sm">
                <Check size={18} /> Public Portal Link Generated Successfully!
              </div>
              <p className="text-xs text-[#2D3748]">
                Share this link with external customers. Raw security tokens are verified on entry.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={newPortalUrl}
                  className="w-full px-3 py-2 text-xs rounded-xl font-mono bg-[#FAF8F5] border border-[#E8E2D5] text-[#164E3F] outline-none"
                />
                <button
                  onClick={handleCopy}
                  className="lm-btn-glow text-xs px-4 py-2 flex items-center gap-1.5 flex-shrink-0"
                  data-testid="copy-portal-btn"
                >
                  {copied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy Link</>}
                </button>
              </div>
            </div>
          )}

          {/* GENERATE NEW PORTAL FORM */}
          <form onSubmit={handleGeneratePortal} className="lm-modern-card space-y-5">
            <h2 className="text-base font-serif font-bold text-[#0F1E36]">Generate Controlled Showcase Link</h2>

            {error && (
              <div className="lm-badge-danger p-3 rounded-xl text-xs font-medium w-full">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label
                onClick={() => setAccessMode("TIME_BASED")}
                className={`p-4 rounded-xl border cursor-pointer space-y-2 transition-all ${
                  accessMode === "TIME_BASED"
                    ? "border-[#164E3F] bg-[#E8F3EE]/60 shadow-sm"
                    : "border-[#E8E2D5] bg-[#FAF8F5] opacity-80 hover:opacity-100"
                }`}
              >
                <div className="flex items-center gap-2 font-bold text-sm text-[#0F1E36]">
                  <Clock size={16} className="text-[#164E3F]" /> Mode A: Time-Based Access
                </div>
                <p className="text-xs text-[#64748B]">
                  Link expires automatically after configured duration (e.g. 10 minutes).
                </p>
              </label>

              <label
                onClick={() => setAccessMode("DEVICE_BASED")}
                className={`p-4 rounded-xl border cursor-pointer space-y-2 transition-all ${
                  accessMode === "DEVICE_BASED"
                    ? "border-[#164E3F] bg-[#E8F3EE]/60 shadow-sm"
                    : "border-[#E8E2D5] bg-[#FAF8F5] opacity-80 hover:opacity-100"
                }`}
              >
                <div className="flex items-center gap-2 font-bold text-sm text-[#0F1E36]">
                  <Smartphone size={16} className="text-[#164E3F]" /> Mode B: Device Limit (5 Max)
                </div>
                <p className="text-xs text-[#64748B]">
                  Allows up to 5 devices. 6th device attempt invalidates portal for ALL sessions.
                </p>
              </label>
            </div>

            {accessMode === "TIME_BASED" ? (
              <div className="lm-modern-input-group">
                <label>Portal Duration (Minutes)</label>
                <select
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                  className="lm-modern-input"
                >
                  <option value={5}>5 Minutes</option>
                  <option value={10}>10 Minutes (Standard Default)</option>
                  <option value={15}>15 Minutes</option>
                  <option value={30}>30 Minutes</option>
                  <option value={60}>60 Minutes</option>
                </select>
              </div>
            ) : (
              <div className="lm-modern-input-group">
                <label>Maximum Allowed Active Devices</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxDevices}
                  onChange={(e) => setMaxDevices(Number(e.target.value))}
                  className="lm-modern-input font-mono"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full lm-btn-glow text-xs py-3 font-semibold flex items-center justify-center gap-2"
              data-testid="generate-portal-btn"
            >
              {submitting ? "Generating Security Token..." : "Generate Controlled Public Portal Link"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
