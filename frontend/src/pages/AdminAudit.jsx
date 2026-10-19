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
    <div className="lm-page-container" data-testid="admin-audit-page">
      <header className="lm-modern-header">
        <div className="lm-modern-header-left">
          <span className="lm-modern-eyebrow">Platform Audit</span>
          <h1 className="lm-modern-title">Activity Trail</h1>
          <p className="lm-modern-subtitle">
            Every write operation is recorded, attributable, and tenant-isolated.
          </p>
        </div>

        <div className="lm-modern-header-actions">
          <div className="lm-search-box">
            <Filter size={14} className="text-emerald-400" />
            <input
              type="text"
              placeholder="Filter action (e.g. SHARE, PLOT)..."
              value={actionFilter}
              onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
              data-testid="audit-action-filter"
            />
          </div>
        </div>
      </header>

      {err && (
        <div className="lm-badge-danger p-3 rounded-xl mb-4 text-xs font-medium w-full">
          {err}
        </div>
      )}

      <div className="lm-modern-table-container" data-testid="audit-table">
        <table className="lm-modern-table">
          <thead>
            <tr>
              <th style={{ width: "38%" }}>Event & Metadata</th>
              <th style={{ width: "22%" }}>Actor</th>
              <th style={{ width: "20%" }}>Entity</th>
              <th style={{ width: "20%" }}>When</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="text-center py-12 text-slate-400">
                  Loading audit records...
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center py-12 text-slate-400">
                  No activity records found.
                </td>
              </tr>
            ) : (
              logs.map((l) => (
                <tr key={l.id} data-testid={`audit-row-${l.id}`}>
                  <td>
                    <div className="font-bold text-[#0F1E36] text-xs tracking-wide">
                      {l.action ? l.action.replaceAll("_", " ") : "ACTION"}
                    </div>
                    {l.metadata && Object.keys(l.metadata).length > 0 && (
                      <div className="text-[11px] text-[#64748B] mt-1 font-mono">
                        {Object.entries(l.metadata).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className="font-medium text-[#2D3748] text-xs">
                      {l.user_name || "System"}
                    </span>
                  </td>
                  <td>
                    <div className="flex flex-col">
                      <span className="text-[11px] text-[#64748B] uppercase font-mono tracking-wider">{l.entity_type}</span>
                      <code className="text-[11px] text-[#164E3F] font-mono font-semibold">{String(l.entity_id || "").slice(0, 10)}</code>
                    </div>
                  </td>
                  <td>
                    <span className="text-xs text-[#64748B]">
                      {new Date(l.created_at).toLocaleString()}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      <div className="flex items-center justify-between mt-4 text-xs text-[#64748B]">
        <div>
          Showing <strong className="text-[#0F1E36] font-mono">{logs.length}</strong> of <strong className="text-[#0F1E36] font-mono">{total}</strong> records
        </div>
        <div className="flex items-center gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="p-1.5 rounded-lg bg-white border border-[#E8E2D5] text-[#0F1E36] hover:bg-[#F5F1EB] disabled:opacity-40 transition-all text-xs"
            title="Previous Page"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="font-mono text-[#0F1E36]">
            Page {page} of {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="p-1.5 rounded-lg bg-white border border-[#E8E2D5] text-[#0F1E36] hover:bg-[#F5F1EB] disabled:opacity-40 transition-all text-xs"
            title="Next Page"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
