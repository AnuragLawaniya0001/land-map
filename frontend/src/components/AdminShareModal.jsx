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
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(15, 23, 42, 0.75)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
      <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: "12px", width: "100%", maxWidth: "600px", color: "#f8fafc", padding: "1.5rem", boxShadow: "0 20px 25px -5px rgba(0,0,0,0.5)" }}>
        {/* Modal Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.25rem", borderBottom: "1px solid #334155", pb: "0.75rem" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: "700" }}>
              Controlled Share Management — Plot #{plot.number}
            </h3>
            <div style={{ fontSize: "0.8rem", color: "#94a3b8", marginTop: "0.2rem" }}>
              Generate & revoke cryptographically secure public viewing tokens
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#94a3b8", fontSize: "1.5rem", cursor: "pointer", padding: "0 0.5rem" }}>
            &times;
          </button>
        </div>

        {error && (
          <div style={{ background: "#7f1d1d", color: "#fca5a5", border: "1px solid #991b1b", padding: "0.6rem 0.8rem", borderRadius: "6px", fontSize: "0.85rem", marginBottom: "1rem" }}>
            {error}
          </div>
        )}

        {/* Newly Created Token Banner */}
        {newShareUrl && (
          <div style={{ background: "#064e3b", border: "1px solid #047857", color: "#a7f3d0", padding: "1rem", borderRadius: "8px", marginBottom: "1.25rem" }}>
            <div style={{ fontWeight: "700", fontSize: "0.9rem", marginBottom: "0.25rem", color: "#34d399" }}>
              ✓ Secure Share Token Generated!
            </div>
            <div style={{ fontSize: "0.8rem", color: "#6ee7b7", marginBottom: "0.75rem" }}>
              This raw URL contains the cryptographic secret key. Copy it now; the full key will not be shown again.
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type="text"
                readOnly
                value={newShareUrl}
                style={{ flex: 1, background: "#022c22", border: "1px solid #059669", color: "#a7f3d0", padding: "0.5rem 0.75rem", borderRadius: "4px", fontSize: "0.85rem", fontFamily: "monospace" }}
              />
              <button
                type="button"
                onClick={() => copyToClipboard(newShareUrl)}
                style={{ background: "#059669", color: "#fff", border: "none", padding: "0.5rem 1rem", borderRadius: "4px", fontWeight: "600", fontSize: "0.85rem", cursor: "pointer" }}
              >
                {copied ? "Copied!" : "Copy Link"}
              </button>
            </div>
          </div>
        )}

        {/* Create Share Form */}
        <form onSubmit={handleCreateShare} style={{ background: "#0f172a", padding: "1rem", borderRadius: "8px", border: "1px solid #334155", marginBottom: "1.25rem" }}>
          <div style={{ fontSize: "0.85rem", fontWeight: "700", color: "#cbd5e1", marginBottom: "0.75rem" }}>
            Create New Controlled Link
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "0.75rem", alignItems: "end" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.75rem", color: "#94a3b8", marginBottom: "0.25rem" }}>
                Expiry (Days) <span style={{ color: "#64748b" }}>(Optional)</span>
              </label>
              <input
                type="number"
                placeholder="e.g. 7"
                min="1"
                value={expiryDays}
                onChange={(e) => setExpiryDays(e.target.value)}
                style={{ width: "100%", background: "#1e293b", border: "1px solid #475569", color: "#fff", padding: "0.45rem 0.6rem", borderRadius: "4px", fontSize: "0.85rem" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.75rem", color: "#94a3b8", marginBottom: "0.25rem" }}>
                Max Views <span style={{ color: "#64748b" }}>(Optional)</span>
              </label>
              <input
                type="number"
                placeholder="e.g. 50"
                min="1"
                value={maxViews}
                onChange={(e) => setMaxViews(e.target.value)}
                style={{ width: "100%", background: "#1e293b", border: "1px solid #475569", color: "#fff", padding: "0.45rem 0.6rem", borderRadius: "4px", fontSize: "0.85rem" }}
              />
            </div>
            <button
              type="submit"
              disabled={creating}
              style={{ background: "#3b82f6", color: "#fff", border: "none", padding: "0.5rem 1rem", borderRadius: "4px", fontWeight: "600", fontSize: "0.85rem", cursor: "pointer", height: "34px" }}
            >
              {creating ? "Generating..." : "Generate Token"}
            </button>
          </div>
        </form>

        {/* Existing Shares List */}
        <div>
          <div style={{ fontSize: "0.85rem", fontWeight: "700", color: "#cbd5e1", marginBottom: "0.5rem" }}>
            Active & Historic Share Links
          </div>
          {loading ? (
            <div style={{ color: "#94a3b8", fontSize: "0.85rem", textAlign: "center", padding: "1rem" }}>Loading shares...</div>
          ) : shares.length === 0 ? (
            <div style={{ color: "#64748b", fontSize: "0.85rem", textAlign: "center", padding: "1rem", background: "#0f172a", borderRadius: "6px" }}>
              No active share tokens created for this property yet.
            </div>
          ) : (
            <div style={{ maxHeight: "200px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {shares.map((s) => (
                <div key={s.id} style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: "6px", padding: "0.75rem", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: "0.8rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.2rem" }}>
                      <span style={{
                        padding: "0.15rem 0.5rem", borderRadius: "4px", fontSize: "0.7rem", fontWeight: "700",
                        background: s.status === "ACTIVE" ? "#065f46" : s.status === "EXPIRED" ? "#854d0e" : s.status === "EXHAUSTED" ? "#9a3412" : "#991b1b",
                        color: s.status === "ACTIVE" ? "#6ee7b7" : s.status === "EXPIRED" ? "#fef08a" : s.status === "EXHAUSTED" ? "#ffedd5" : "#fca5a5"
                      }}>
                        {s.status}
                      </span>
                      <span style={{ color: "#64748b" }}>Created: {new Date(s.created_at).toLocaleDateString()}</span>
                    </div>
                    <div style={{ color: "#94a3b8", fontSize: "0.75rem" }}>
                      Views: <strong>{s.view_count}</strong> {s.max_views != null ? `/ ${s.max_views}` : "(Unlimited)"}
                      {s.expires_at && ` • Expires: ${new Date(s.expires_at).toLocaleString()}`}
                    </div>
                  </div>
                  {s.status === "ACTIVE" && (
                    <button
                      onClick={() => handleRevokeShare(s.id)}
                      style={{ background: "#7f1d1d", color: "#fca5a5", border: "1px solid #991b1b", padding: "0.3rem 0.6rem", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "600", cursor: "pointer" }}
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
