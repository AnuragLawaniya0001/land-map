import { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { ChevronLeft, ChevronRight, Filter } from "lucide-react";

export default function AdminAudit() {
  const [logs, setLogs] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchLogs = () => {
    setLoading(true);
    const params = new URLSearchParams({ page, limit: 30 });
    if (actionFilter) params.append("action", actionFilter);

    api.get(`/admin/audit-logs?${params.toString()}`)
      .then((r) => {
        if (r.data.logs) {
          setLogs(r.data.logs);
          setTotalPages(r.data.pages || 1);
          setTotal(r.data.total || 0);
        } else {
          setLogs(r.data || []);
        }
      })
      .catch((e) => setErr(errMsg(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchLogs();
  }, [page, actionFilter]);

  return (
    <div className="lm-page">
      <header className="lm-topbar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <p className="lm-eyebrow">ACTIVITY</p>
          <h1>Audit Log</h1>
          <p className="lm-muted">Every write operation is recorded, attributable, and tenant-isolated.</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", background: "#1e293b", padding: "0.4rem 0.75rem", borderRadius: "8px", border: "1px solid #334155" }}>
          <Filter size={14} style={{ color: "#94a3b8" }} />
          <input
            type="text"
            placeholder="Filter action (e.g. SHARE)..."
            value={actionFilter}
            onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
            style={{ background: "transparent", border: "none", color: "#fff", fontSize: "0.85rem", outline: "none" }}
          />
        </div>
      </header>

      {err && <div className="lm-error">{err}</div>}

      <div className="lm-table" data-testid="audit-table">
        <div className="lm-table-head">
          <span>Event</span>
          <span>Actor</span>
          <span>Entity</span>
          <span>When</span>
        </div>
        {loading ? (
          <div style={{ textAlign: "center", color: "#94a3b8", padding: "2rem" }}>Loading audit records...</div>
        ) : logs.map((l) => (
          <div className="lm-table-row" key={l.id} data-testid={`audit-row-${l.id}`}>
            <span>
              <b>{l.action ? l.action.replaceAll("_", " ") : "ACTION"}</b>
              {l.metadata && Object.keys(l.metadata).length > 0 && (
                <small>{Object.entries(l.metadata).map(([k, v]) => `${k}: ${v}`).join(" · ")}</small>
              )}
            </span>
            <span>{l.user_name || "System"}</span>
            <span>
              <small>{l.entity_type}</small>
              <code>{String(l.entity_id || "").slice(0, 10)}</code>
            </span>
            <span>{new Date(l.created_at).toLocaleString()}</span>
          </div>
        ))}
        {!logs.length && !loading && !err && <div className="lm-empty-state"><p>No activity records found.</p></div>}
      </div>

      {/* Pagination Footer */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "1rem", color: "#94a3b8", fontSize: "0.85rem" }}>
        <div>Showing <strong>{logs.length}</strong> of <strong>{total}</strong> audit records</div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            style={{ background: "#1e293b", border: "1px solid #334155", color: "#fff", padding: "0.3rem 0.6rem", borderRadius: "4px", cursor: "pointer" }}
          >
            <ChevronLeft size={14} />
          </button>
          <span>Page {page} of {totalPages}</span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            style={{ background: "#1e293b", border: "1px solid #334155", color: "#fff", padding: "0.3rem 0.6rem", borderRadius: "4px", cursor: "pointer" }}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
