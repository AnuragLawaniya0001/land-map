import { useEffect, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { MessageSquare, Phone, Mail, Clock, Filter } from "lucide-react";

export default function AdminInquiries() {
  const [inquiries, setInquiries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const load = () => {
    setLoading(true);
    const query = statusFilter ? `?status=${statusFilter}` : "";
    api.get(`/admin/inquiries${query}`)
      .then((res) => setInquiries(res.data || []))
      .catch((e) => setErr(errMsg(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [statusFilter]);

  const handleStatusChange = (id, newStatus) => {
    api.patch(`/admin/inquiries/${id}`, { status: newStatus })
      .then(() => load())
      .catch((e) => alert(errMsg(e)));
  };

  return (
    <div className="lm-page-container" data-testid="admin-inquiries-page">
      <header className="lm-modern-header">
        <div className="lm-modern-header-left">
          <span className="lm-modern-eyebrow">Customer Relations</span>
          <h1 className="lm-modern-title">Property Inquiries</h1>
          <p className="lm-modern-subtitle">
            Lead inquiries generated directly from interactive map links and shared property views.
          </p>
        </div>

        <div className="lm-modern-header-actions">
          <div className="lm-filter-select">
            <Filter size={14} className="text-[#164E3F]" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-transparent border-none text-[#0F1E36] text-xs font-semibold outline-none cursor-pointer"
              data-testid="inquiry-status-filter"
            >
              <option value="">All Statuses</option>
              <option value="NEW">NEW</option>
              <option value="CONTACTED">CONTACTED</option>
              <option value="CLOSED">CLOSED</option>
            </select>
          </div>
        </div>
      </header>

      {err && (
        <div className="lm-badge-danger p-3 rounded-xl mb-4 text-xs font-medium w-full">
          {err}
        </div>
      )}

      {loading ? (
        <div className="lm-modern-card text-center p-12 text-sm text-[#64748B] animate-pulse">
          Loading customer inquiries...
        </div>
      ) : inquiries.length === 0 ? (
        <div className="lm-modern-card text-center p-12 text-[#64748B]">
          <MessageSquare size={36} className="mx-auto mb-3 opacity-40 text-[#164E3F]" />
          <h3 className="text-base font-bold text-[#0F1E36] mb-1">No customer inquiries found</h3>
          <p className="text-xs text-[#64748B]">Inquiries submitted from shared property links will appear here automatically.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {inquiries.map((inq) => {
            const badgeClass =
              inq.status === "NEW"
                ? "lm-badge-info"
                : inq.status === "CONTACTED"
                ? "lm-badge-warning"
                : "lm-badge-success";

            return (
              <div
                key={inq.id}
                className="lm-modern-card flex flex-col gap-3"
                data-testid={`inquiry-card-${inq.id}`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-3">
                      <h3 className="text-base font-bold text-[#0F1E36]">{inq.name}</h3>
                      <span className={`lm-badge ${badgeClass}`}>
                        <span className="lm-badge-dot" />
                        {inq.status}
                      </span>
                    </div>
                    <div className="text-xs text-[#64748B] mt-1 flex items-center gap-4">
                      <span>Plot ID: <strong className="text-[#164E3F] font-mono">#{inq.plot_id}</strong></span>
                      <span className="flex items-center gap-1.5 text-[#64748B]">
                        <Clock size={12} /> {new Date(inq.created_at).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {/* Status Action Buttons */}
                  <div className="flex items-center gap-1.5 self-start sm:self-auto">
                    {["NEW", "CONTACTED", "CLOSED"].map((st) => (
                      <button
                        key={st}
                        disabled={inq.status === st}
                        onClick={() => handleStatusChange(inq.id, st)}
                        className={`text-xs px-2.5 py-1 rounded-lg font-semibold transition-all ${
                          inq.status === st
                            ? "bg-[#F5F1EB] text-[#64748B] border border-[#E8E2D5] cursor-default"
                            : "bg-white hover:bg-[#F5F1EB] text-[#0F1E36] border border-[#E8E2D5]"
                        }`}
                        data-testid={`set-status-${inq.id}-${st.toLowerCase()}`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>

                {inq.message && (
                  <div className="bg-[#FAF8F5] border border-[#E8E2D5] rounded-xl p-3.5 text-xs text-[#2D3748] leading-relaxed font-sans">
                    {inq.message}
                  </div>
                )}

                <div className="flex items-center gap-5 text-xs pt-1 border-t border-[#E8E2D5]">
                  <div className="flex items-center gap-2 text-[#164E3F] font-medium">
                    <Phone size={13} />
                    <a href={`tel:${inq.phone}`} className="hover:underline">{inq.phone}</a>
                  </div>
                  {inq.email && (
                    <div className="flex items-center gap-2 text-[#2D3748]">
                      <Mail size={13} className="text-[#164E3F]" />
                      <a href={`mailto:${inq.email}`} className="hover:underline">{inq.email}</a>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
