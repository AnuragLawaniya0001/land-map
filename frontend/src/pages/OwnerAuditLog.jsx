import React, { useState, useEffect } from "react";
import { api, errMsg } from "../lib/api";
import { ShieldCheck, User, Calendar, Activity } from "lucide-react";

export default function OwnerAuditLog() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        setLoading(true);
        const res = await api.get(`/owner/audit-logs?page=${page}&limit=25`);
        setLogs(res.data.auditLogs || []);
        setTotalPages(res.data.pagination?.totalPages || 1);
        setError(null);
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setLoading(false);
      }
    };

    fetchLogs();
  }, [page]);

  return (
    <div className="lm-page-container" data-testid="owner-audit-page">
      <header className="lm-modern-header">
        <div className="lm-modern-header-left">
          <span className="lm-modern-eyebrow">Platform Governance</span>
          <h1 className="lm-modern-title">Platform Audit Trail</h1>
          <p className="lm-modern-subtitle">
            Activity tracking and security logs across all platform tenant administrators.
          </p>
        </div>
      </header>

      {loading ? (
        <div className="lm-modern-card p-12 text-center text-sm text-slate-400 animate-pulse">
          Loading audit logs...
        </div>
      ) : error ? (
        <div className="lm-badge-danger p-3 rounded-xl mb-4 text-xs font-medium w-full">
          {error}
        </div>
      ) : (
        <div className="lm-modern-table-container">
          <table className="lm-modern-table">
            <thead>
              <tr>
                <th style={{ width: "20%" }}>Timestamp</th>
                <th style={{ width: "22%" }}>Actor</th>
                <th style={{ width: "12%" }}>Role</th>
                <th style={{ width: "20%" }}>Action</th>
                <th style={{ width: "14%" }}>Resource</th>
                <th style={{ width: "12%", textAlign: "right" }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan="6" className="py-12 text-center text-slate-400 text-xs">
                    No audit events recorded yet.
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log._id || log.id}>
                    <td className="text-xs text-[#6B7280] font-mono">
                      {log.timestamp ? new Date(log.timestamp).toLocaleString() : "N/A"}
                    </td>
                    <td>
                      <span className="font-semibold text-[#172A25] text-xs">{log.user_email || log.user_id || "System"}</span>
                    </td>
                    <td>
                      <span className="uppercase text-[10px] font-mono text-[#173F35] font-bold bg-[#F4EFE6] px-2 py-0.5 rounded border border-[#E8E2D6]">
                        {log.user_role || "system"}
                      </span>
                    </td>
                    <td className="font-bold text-xs text-[#172A25]">
                      {log.action}
                    </td>
                    <td className="text-xs text-[#6B7280] font-mono">
                      {log.resource_type ? `${log.resource_type}:${log.resource_id || ""}` : "-"}
                    </td>
                    <td className="text-right">
                      <span className={`lm-badge ${
                        log.status === "SUCCESS" || !log.status
                          ? "lm-badge-success"
                          : "lm-badge-danger"
                      }`}>
                        <span className="lm-badge-dot" />
                        {log.status || "SUCCESS"}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between p-4 border-t border-[#F0ECE1] text-xs text-[#6B7280]">
              <button
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="lm-btn-secondary-dark px-3 py-1.5 text-xs"
              >
                Previous
              </button>
              <span className="font-mono text-[#172A25] font-semibold">Page {page} of {totalPages}</span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
                className="lm-btn-secondary-dark px-3 py-1.5 text-xs"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
