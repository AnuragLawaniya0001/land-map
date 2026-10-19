import { useState, useEffect } from "react";
import { api } from "@/lib/api";

export default function AdminShareModal({ plot, onClose }) {
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newShareUrl, setNewShareUrl] = useState(null);
  const [copied, setCopied] = useState(false);

  // Form options
  const [expiryDays, setExpiryDays] = useState("");
  const [maxViews, setMaxViews] = useState("");
  const [error, setError] = useState(null);

  const fetchShares = () => {
    if (!plot) return;
    setLoading(true);
    api.get(`/admin/plots/${plot.id || plot._id}/shares`)
      .then((res) => setShares(Array.isArray(res.data) ? res.data : (res.data.shares || [])))
      .catch((err) => setError(err.response?.data?.error || "Failed to load shares"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchShares();
  }, [plot]);

  const handleCreateShare = (e) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setNewShareUrl(null);

    const payload = {};
    if (expiryDays.trim()) payload.expires_in_days = parseInt(expiryDays.trim(), 10);
    if (maxViews.trim()) payload.max_views = parseInt(maxViews.trim(), 10);

    api.post(`/admin/plots/${plot.id || plot._id}/shares`, payload)
      .then((res) => {
        const fullUrl = `${window.location.origin}${res.data.share.share_url || res.data.share.url}`;
        setNewShareUrl(fullUrl);
        fetchShares();
      })
      .catch((err) => {
        setError(err.response?.data?.error || "Failed to create share token");
      })
      .finally(() => setCreating(false));
  };

  const handleRevokeShare = (shareId) => {
    if (!window.confirm("Are you sure you want to revoke this share link? Unauthenticated visitors will immediately lose access.")) return;

    api.delete(`/admin/shares/${shareId}`)
      .then(() => fetchShares())
      .catch((err) => alert(err.response?.data?.error || "Failed to revoke share"));
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {
        alert("Copy failed. Please copy manually: " + text);
      }
    );
  };

  if (!plot) return null;

  return (
    <div className="lm-modal-shade" data-testid="admin-share-modal-shade">
      <div className="lm-modal" style={{ width: "min(640px, 95vw)" }} data-testid="admin-share-modal">
        {/* Modal Header */}
        <div className="lm-modal-head">
          <div>
            <p className="lm-eyebrow">CONTROLLED SHARE MANAGEMENT</p>
            <h3 className="text-lg font-bold text-white">Share Plot #{plot.number}</h3>
            <div className="text-xs text-slate-400 mt-0.5">
              Generate & revoke cryptographically secure public viewing tokens
            </div>
          </div>
          <button className="lm-icon-btn" onClick={onClose} data-testid="close-share-modal">
            &times;
          </button>
        </div>

        {error && (
          <div className="lm-error mb-4" data-testid="share-modal-error">
            {error}
          </div>
        )}

        {/* Newly Created Token Banner */}
        {newShareUrl && (
          <div className="p-4 rounded-xl bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 mb-5">
            <div className="font-bold text-xs text-emerald-300 uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Secure Share Token Generated!
            </div>
            <div className="text-[11px] text-emerald-400/80 mb-3">
              This URL contains the cryptographic secret key. Copy it now; the full key will not be shown again.
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={newShareUrl}
                className="lm-modern-input flex-1 font-mono text-xs text-emerald-200 bg-emerald-950/80 border-emerald-700/60"
              />
              <button
                type="button"
                onClick={() => copyToClipboard(newShareUrl)}
                className="lm-btn-glow px-4 text-xs font-bold shrink-0"
              >
                {copied ? "Copied!" : "Copy Link"}
              </button>
            </div>
          </div>
        )}

        {/* Create Share Form */}
        <form onSubmit={handleCreateShare} className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.08] mb-5">
          <div className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-3">
            Create New Controlled Link
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <label className="block text-[11px] font-mono text-slate-400 mb-1">
                Expiry (Days) <span className="text-slate-500">(Optional)</span>
              </label>
              <input
                type="number"
                placeholder="e.g. 7"
                min="1"
                value={expiryDays}
                onChange={(e) => setExpiryDays(e.target.value)}
                className="lm-modern-input w-full text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-mono text-slate-400 mb-1">
                Max Views <span className="text-slate-500">(Optional)</span>
              </label>
              <input
                type="number"
                placeholder="e.g. 50"
                min="1"
                value={maxViews}
                onChange={(e) => setMaxViews(e.target.value)}
                className="lm-modern-input w-full text-xs"
              />
            </div>
            <button
              type="submit"
              disabled={creating}
              className="lm-btn-glow w-full justify-center text-xs h-[38px]"
            >
              {creating ? "Generating…" : "Generate Token"}
            </button>
          </div>
        </form>

        {/* Existing Shares List */}
        <div>
          <div className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-2">
            Active & Historic Share Links
          </div>
          {loading ? (
            <div className="text-slate-400 text-xs text-center py-4">Loading shares…</div>
          ) : shares.length === 0 ? (
            <div className="text-slate-500 text-xs text-center py-4 bg-white/[0.02] border border-white/[0.05] rounded-xl">
              No active share tokens created for this property yet.
            </div>
          ) : (
            <div className="max-h-52 overflow-y-auto flex flex-col gap-2 pr-1">
              {shares.map((s) => (
                <div
                  key={s.id}
                  className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.06] flex items-center justify-between text-xs"
                >
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase ${
                          s.status === "ACTIVE"
                            ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                            : s.status === "EXPIRED"
                            ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                            : s.status === "EXHAUSTED"
                            ? "bg-orange-500/15 text-orange-400 border border-orange-500/30"
                            : "bg-rose-500/15 text-rose-400 border border-rose-500/30"
                        }`}
                      >
                        {s.status}
                      </span>
                      <span className="text-slate-400 text-[11px]">
                        Created: {new Date(s.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="text-slate-300 text-[11px]">
                      Views: <strong className="text-white">{s.view_count}</strong>{" "}
                      {s.max_views != null ? `/ ${s.max_views}` : "(Unlimited)"}
                      {s.expires_at && ` • Expires: ${new Date(s.expires_at).toLocaleString()}`}
                    </div>
                  </div>
                  {s.status === "ACTIVE" && (
                    <button
                      onClick={() => handleRevokeShare(s.id)}
                      className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-500/10 border border-rose-500/30 text-rose-400 hover:bg-rose-500/20 transition-all cursor-pointer"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
