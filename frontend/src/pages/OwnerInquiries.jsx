import React, { useState, useEffect } from "react";
import { api, errMsg } from "../lib/api";
import { MessageSquare, Mail, Clock, CheckCircle, Phone } from "lucide-react";

export default function OwnerInquiries() {
  const [inquiries, setInquiries] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [dashRes, inqRes] = await Promise.all([
        api.get("/owner/dashboard"),
        api.get("/owner/inquiries"),
      ]);
      setMetrics(dashRes.data.inquiries);
      setInquiries(inqRes.data || []);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) return <div className="neo-card p-12 text-center text-sm opacity-70 animate-pulse">Loading inquiries data...</div>;
  if (error) return <div className="neo-card p-6 border-l-4 border-red-500 text-red-600 dark:text-red-400">{error}</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-serif tracking-tight">Platform Inquiries</h1>
        <p className="text-sm opacity-70">Customer inquiry metrics &amp; platform-wide inquiry history</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="neo-card p-6 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase font-semibold opacity-70">Total Inquiries</div>
            <div className="text-3xl font-bold font-mono text-violet-500 mt-1">{metrics?.totalInquiries || 0}</div>
          </div>
          <MessageSquare className="text-violet-500/40" size={32} />
        </div>

        <div className="neo-card p-6 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase font-semibold opacity-70">New Inquiries</div>
            <div className="text-3xl font-bold font-mono text-amber-500 mt-1">{metrics?.newInquiries || 0}</div>
          </div>
          <Mail className="text-amber-500/40" size={32} />
        </div>

        <div className="neo-card p-6 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase font-semibold opacity-70">Contacted</div>
            <div className="text-3xl font-bold font-mono text-blue-500 mt-1">{metrics?.contactedInquiries || 0}</div>
          </div>
          <Clock className="text-blue-500/40" size={32} />
        </div>

        <div className="neo-card p-6 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase font-semibold opacity-70">Closed</div>
            <div className="text-3xl font-bold font-mono text-emerald-500 mt-1">{metrics?.closedInquiries || 0}</div>
          </div>
          <CheckCircle className="text-emerald-500/40" size={32} />
        </div>
      </div>

      <div className="neo-card p-6 space-y-4">
        <h2 className="text-lg font-bold font-serif">Platform-Wide Inquiry Stream</h2>
        {inquiries.length === 0 ? (
          <div className="text-center py-8 opacity-60 text-sm">
            No customer inquiries recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-800 opacity-60 uppercase text-xs tracking-wider">
                  <th className="py-3 px-4">Name / Customer</th>
                  <th className="py-3 px-4">Phone</th>
                  <th className="py-3 px-4">Plot ID</th>
                  <th className="py-3 px-4">Message</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Received</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {inquiries.map((inq) => (
                  <tr key={inq._id || inq.id} className="hover:bg-violet-500/5 transition-colors">
                    <td className="py-3 px-4 font-semibold">{inq.name || "Interested Buyer"}</td>
                    <td className="py-3 px-4 font-mono text-xs text-blue-500">
                      <a href={`tel:${inq.phone}`} className="hover:underline flex items-center gap-1">
                        <Phone size={12} /> {inq.phone}
                      </a>
                    </td>
                    <td className="py-3 px-4 font-mono text-xs">{inq.plot_id}</td>
                    <td className="py-3 px-4 max-w-xs truncate opacity-80" title={inq.message}>{inq.message}</td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        inq.status === "NEW"
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                          : inq.status === "CONTACTED"
                          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20"
                          : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                      }`}>
                        {inq.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-xs opacity-60 font-mono">
                      {inq.created_at ? new Date(inq.created_at).toLocaleString() : "N/A"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
