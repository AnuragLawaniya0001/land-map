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
    <div className="space-y-6 max-w-4xl mx-auto p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold font-serif tracking-tight">Admin Multi-Colony Public Portal</h1>
        <p className="text-sm opacity-70">Generate controlled, time-based or device-limited public showcase links for your colonies</p>
      </div>

      {loading ? (
        <div className="neo-card p-12 text-center text-sm opacity-70 animate-pulse">
          Loading public portal status...
        </div>
      ) : (
        <div className="space-y-6">
          {/* CURRENT PORTAL STATUS CARD */}
          {portal && (
            <div className="neo-card p-6 space-y-4">
              <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 pb-3">
                <div className="flex items-center gap-2">
                  <Globe className="text-violet-500" size={20} />
                  <h2 className="font-serif font-bold text-lg">Active Public Portal Configuration</h2>
                </div>
                <span className={`text-xs font-mono font-bold px-3 py-1 rounded-full uppercase tracking-wider ${
                  portal.status === "ACTIVE" ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" :
                  portal.status === "DEVICE_LIMIT_BREACHED" ? "bg-red-500/10 text-red-500 border border-red-500/20" :
                  "bg-amber-500/10 text-amber-500 border border-amber-500/20"
                }`}>
                  {portal.status}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono">
                <div className="p-3 neo-inset rounded-lg">
                  <div className="text-[10px] uppercase opacity-60 font-sans">Access Mode</div>
                  <div className="font-bold text-sm text-violet-500 mt-0.5">{portal.access_mode}</div>
                </div>
                <div className="p-3 neo-inset rounded-lg">
                  <div className="text-[10px] uppercase opacity-60 font-sans">Time Expiry</div>
                  <div className="font-bold text-sm mt-0.5">
                    {portal.expires_at ? new Date(portal.expires_at).toLocaleTimeString() : "No Limit"}
                  </div>
                </div>
                <div className="p-3 neo-inset rounded-lg">
                  <div className="text-[10px] uppercase opacity-60 font-sans">Max Devices</div>
                  <div className="font-bold text-sm mt-0.5">{portal.max_devices} Devices</div>
                </div>
                <div className="p-3 neo-inset rounded-lg">
                  <div className="text-[10px] uppercase opacity-60 font-sans">Active Sessions</div>
                  <div className="font-bold text-sm text-emerald-500 mt-0.5">{portal.active_sessions_count} Active</div>
                </div>
              </div>

              {portal.status === "ACTIVE" && (
                <div className="pt-2 flex justify-end">
                  <button
                    onClick={handleRevoke}
                    className="text-xs font-semibold px-4 py-2 rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-all"
                  >
                    Revoke Active Portal Link
                  </button>
                </div>
              )}
            </div>
          )}

          {/* NEW PORTAL LINK NOTICE */}
          {newPortalUrl && (
            <div className="p-4 rounded-xl neo-card border-2 border-emerald-500 bg-emerald-500/10 space-y-3">
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-bold text-sm">
                <Check size={18} /> Public Portal Link Generated Successfully!
              </div>
              <p className="text-xs opacity-80">
                Share this link with external customers. Copy now; raw tokens are never stored in plaintext.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={newPortalUrl}
                  className="w-full px-3 py-2 text-xs rounded-lg neo-input font-mono bg-transparent border border-gray-300 dark:border-gray-700"
                />
                <button
                  onClick={handleCopy}
                  className="neo-btn-primary text-xs px-4 py-2 flex items-center gap-1.5 flex-shrink-0"
                >
                  {copied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy Link</>}
                </button>
              </div>
            </div>
          )}

          {/* GENERATE NEW PORTAL FORM */}
          <form onSubmit={handleGeneratePortal} className="neo-card p-6 space-y-6">
            <h2 className="text-lg font-serif font-bold">Configure Public Portal Link Access</h2>

            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-xs">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label
                onClick={() => setAccessMode("TIME_BASED")}
                className={`p-4 rounded-xl border cursor-pointer space-y-2 transition-all ${
                  accessMode === "TIME_BASED"
                    ? "border-violet-500 bg-violet-500/10"
                    : "border-gray-200 dark:border-gray-800 opacity-70"
                }`}
              >
                <div className="flex items-center gap-2 font-bold text-sm">
                  <Clock size={16} className="text-violet-500" /> Mode A: Time-Based Access
                </div>
                <p className="text-xs opacity-70">
                  Link expires automatically after configured duration (e.g. 10 minutes).
                </p>
              </label>

              <label
                onClick={() => setAccessMode("DEVICE_BASED")}
                className={`p-4 rounded-xl border cursor-pointer space-y-2 transition-all ${
                  accessMode === "DEVICE_BASED"
                    ? "border-violet-500 bg-violet-500/10"
                    : "border-gray-200 dark:border-gray-800 opacity-70"
                }`}
              >
                <div className="flex items-center gap-2 font-bold text-sm">
                  <Smartphone size={16} className="text-violet-500" /> Mode B: Device Limit (5 Max)
                </div>
                <p className="text-xs opacity-70">
                  Allows up to 5 devices. 6th device attempt invalidates portal for ALL sessions.
                </p>
              </label>
            </div>

            {accessMode === "TIME_BASED" ? (
              <div>
                <label className="block text-xs font-semibold mb-1 opacity-70">Portal Duration (Minutes)</label>
                <select
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700"
                >
                  <option value={5}>5 Minutes</option>
                  <option value={10}>10 Minutes (Default Standard)</option>
                  <option value={15}>15 Minutes</option>
                  <option value={30}>30 Minutes</option>
                  <option value={60}>60 Minutes</option>
                </select>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-semibold mb-1 opacity-70">Maximum Allowed Active Devices</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxDevices}
                  onChange={(e) => setMaxDevices(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700 font-mono"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full neo-btn-primary text-xs py-3 font-semibold flex items-center justify-center gap-2"
            >
              {submitting ? "Generating..." : "Generate Controlled Public Portal Link"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
