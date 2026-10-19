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
    <div className="lm-page-container" data-testid="owner-inquiries-page">
      <header className="lm-modern-header">
        <div className="lm-modern-header-left">
          <span className="lm-modern-eyebrow">Customer Acquisition</span>
          <h1 className="lm-modern-title">Platform Inquiries</h1>
          <p className="lm-modern-subtitle">
            Customer inquiry metrics &amp; platform-wide inquiry history across all active developer portals.
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="lm-stat colonies">
          <div className="lm-stat-top">
            <span className="lm-stat-label">Total Inquiries</span>
            <div className="lm-stat-icon-wrap">
              <MessageSquare size={16} />
            </div>
          </div>
          <div className="lm-stat-val">{metrics?.totalInquiries || 0}</div>
          <div className="lm-stat-sub">Platform-wide leads</div>
        </div>

        <div className="lm-stat available">
          <div className="lm-stat-top">
            <span className="lm-stat-label">New Inquiries</span>
            <div className="lm-stat-icon-wrap">
              <Mail size={16} />
            </div>
          </div>
          <div className="lm-stat-val">{metrics?.newInquiries || 0}</div>
          <div className="lm-stat-sub">Action required</div>
        </div>

        <div className="lm-modern-card flex items-center justify-between">
          <div>
            <div className="text-xs uppercase font-mono font-bold text-[#6B7280]">Contacted</div>
            <div className="text-3xl font-extrabold font-mono text-[#172A25] mt-1">{metrics?.contactedInquiries || 0}</div>
          </div>
          <div className="p-3 rounded-xl bg-[#F4EFE6] border border-[#E8E2D6] text-[#173F35]">
            <Clock size={20} />
          </div>
        </div>

        <div className="lm-modern-card flex items-center justify-between">
          <div>
            <div className="text-xs uppercase font-mono font-bold text-[#6B7280]">Closed</div>
            <div className="text-3xl font-extrabold font-mono text-[#047857] mt-1">{metrics?.closedInquiries || 0}</div>
          </div>
          <div className="p-3 rounded-xl bg-[#F4EFE6] border border-[#E8E2D6] text-[#047857]">
            <CheckCircle size={20} />
          </div>
        </div>
      </div>

      <div className="lm-modern-table-container">
        <div className="p-5 border-b border-[#F0ECE1]">
          <h2 className="text-base font-bold font-serif text-[#172A25]">Platform-Wide Inquiry Stream</h2>
        </div>
        {inquiries.length === 0 ? (
          <div className="text-center py-12 text-[#6B7280] text-xs">
            No customer inquiries recorded yet.
          </div>
        ) : (
          <table className="lm-modern-table">
            <thead>
              <tr>
                <th style={{ width: "20%" }}>Name / Customer</th>
                <th style={{ width: "16%" }}>Phone</th>
                <th style={{ width: "12%" }}>Plot ID</th>
                <th style={{ width: "28%" }}>Message</th>
                <th style={{ width: "12%" }}>Status</th>
                <th style={{ width: "12%" }}>Received</th>
              </tr>
            </thead>
            <tbody>
              {inquiries.map((inq) => (
                <tr key={inq._id || inq.id}>
                  <td className="font-bold text-[#172A25] text-xs">{inq.name || "Interested Buyer"}</td>
                  <td>
                    <a href={`tel:${inq.phone}`} className="hover:underline flex items-center gap-1.5 font-mono text-xs text-[#0D1B2A] font-semibold">
                      <Phone size={12} /> {inq.phone}
                    </a>
                  </td>
                  <td className="font-mono text-xs text-[#173F35] font-semibold">#{inq.plot_id}</td>
                  <td className="text-xs text-[#374151] max-w-xs truncate" title={inq.message}>{inq.message}</td>
                  <td>
                    <span className={`lm-badge ${
                      inq.status === "NEW"
                        ? "lm-badge-warning"
                        : inq.status === "CONTACTED"
                        ? "lm-badge-info"
                        : "lm-badge-success"
                    }`}>
                      <span className="lm-badge-dot" />
                      {inq.status}
                    </span>
                  </td>
                  <td className="text-xs text-[#6B7280] font-mono">
                    {inq.created_at ? new Date(inq.created_at).toLocaleString() : "N/A"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
