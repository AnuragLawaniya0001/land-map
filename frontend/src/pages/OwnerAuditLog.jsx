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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-serif tracking-tight">Platform Audit Logs</h1>
        <p className="text-sm opacity-70">Governance history and activity tracking across all platform users</p>
      </div>

      {loading ? (
        <div className="neo-card p-12 text-center text-sm opacity-70 animate-pulse">
          Loading audit logs...
        </div>
      ) : error ? (
        <div className="neo-card p-6 border-l-4 border-red-500 text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : (
        <div className="neo-card p-6 space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-800 opacity-60 uppercase text-xs tracking-wider">
                  <th className="py-3 px-4">Timestamp</th>
                  <th className="py-3 px-4">Actor</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Action</th>
                  <th className="py-3 px-4">Resource</th>
                  <th className="py-3 px-4">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800 font-mono text-xs">
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan="6" className="py-8 text-center opacity-60">
                      No audit events recorded yet.
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <tr key={log._id} className="hover:bg-violet-500/5 transition-colors">
                      <td className="py-3 px-4 opacity-70">
                        {log.timestamp ? new Date(log.timestamp).toLocaleString() : "N/A"}
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-semibold font-sans">{log.user_email || log.user_id || "System"}</span>
                      </td>
                      <td className="py-3 px-4 uppercase text-[10px] tracking-wider opacity-70">
                        {log.user_role || "system"}
                      </td>
                      <td className="py-3 px-4 font-bold text-violet-500">
                        {log.action}
                      </td>
                      <td className="py-3 px-4 opacity-80">
                        {log.resource_type ? `${log.resource_type}:${log.resource_id || ""}` : "-"}
                      </td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          log.status === "SUCCESS" || !log.status
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "bg-red-500/10 text-red-600 dark:text-red-400"
                        }`}>
                          {log.status || "SUCCESS"}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t border-gray-200 dark:border-gray-800 text-xs">
              <button
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="px-3 py-1.5 rounded neo-card disabled:opacity-40"
              >
                Previous
              </button>
              <span className="opacity-70">Page {page} of {totalPages}</span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
                className="px-3 py-1.5 rounded neo-card disabled:opacity-40"
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
