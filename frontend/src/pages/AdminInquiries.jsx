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
    <div style={{ padding: "1.5rem", color: "#f8fafc" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <div>
          <p style={{ fontSize: "0.8rem", color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: "700", margin: 0 }}>CUSTOMER RELATIONS</p>
          <h1 style={{ fontSize: "1.6rem", fontWeight: "800", margin: 0 }}>Property Inquiries</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", background: "#1e293b", padding: "0.4rem 0.75rem", borderRadius: "8px", border: "1px solid #334155" }}>
          <Filter size={14} style={{ color: "#94a3b8" }} />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ background: "transparent", border: "none", color: "#fff", fontSize: "0.85rem", fontWeight: "600", outline: "none", cursor: "pointer" }}
          >
            <option value="" style={{ background: "#1e293b" }}>All Statuses</option>
            <option value="NEW" style={{ background: "#1e293b" }}>NEW</option>
            <option value="CONTACTED" style={{ background: "#1e293b" }}>CONTACTED</option>
            <option value="CLOSED" style={{ background: "#1e293b" }}>CLOSED</option>
          </select>
        </div>
      </header>

      {err && <div style={{ background: "#7f1d1d", color: "#fca5a5", padding: "0.75rem", borderRadius: "6px", marginBottom: "1rem" }}>{err}</div>}

      {loading ? (
        <div style={{ textAlign: "center", color: "#94a3b8", padding: "3rem" }}>Loading customer inquiries...</div>
      ) : inquiries.length === 0 ? (
        <div style={{ textAlign: "center", color: "#64748b", padding: "3rem", background: "#1e293b", borderRadius: "12px", border: "1px solid #334155" }}>
          <MessageSquare size={36} style={{ marginBottom: "0.5rem", opacity: 0.5 }} />
          <h3>No customer inquiries found</h3>
          <p style={{ fontSize: "0.85rem", color: "#94a3b8" }}>Inquiries submitted from shared property links will appear here.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {inquiries.map((inq) => (
            <div key={inq.id} style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: "10px", padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: "700", color: "#f8fafc" }}>{inq.name}</h3>
                    <span style={{
                      padding: "0.15rem 0.5rem", borderRadius: "4px", fontSize: "0.7rem", fontWeight: "700",
                      background: inq.status === "NEW" ? "#1e3a8a" : inq.status === "CONTACTED" ? "#854d0e" : "#065f46",
                      color: inq.status === "NEW" ? "#93c5fd" : inq.status === "CONTACTED" ? "#fef08a" : "#6ee7b7"
                    }}>
                      {inq.status}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "#94a3b8", marginTop: "0.25rem", display: "flex", alignItems: "center", gap: "1rem" }}>
                    <span>Plot ID: <strong>{inq.plot_id}</strong></span>
                    <span style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                      <Clock size={12} /> {new Date(inq.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>

                <div style={{ display: "flex", gap: "0.4rem" }}>
                  {["NEW", "CONTACTED", "CLOSED"].map((st) => (
                    <button
                      key={st}
                      disabled={inq.status === st}
                      onClick={() => handleStatusChange(inq.id, st)}
                      style={{
                        background: inq.status === st ? "#334155" : "#0f172a",
                        border: "1px solid #475569",
                        color: inq.status === st ? "#94a3b8" : "#f8fafc",
                        padding: "0.3rem 0.6rem",
                        borderRadius: "4px",
                        fontSize: "0.75rem",
                        fontWeight: "600",
                        cursor: inq.status === st ? "default" : "pointer"
                      }}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ background: "#0f172a", padding: "0.85rem", borderRadius: "6px", border: "1px solid #334155", fontSize: "0.9rem", color: "#cbd5e1", lineHeight: 1.5 }}>
                {inq.message}
              </div>

              <div style={{ display: "flex", gap: "1.5rem", fontSize: "0.85rem", color: "#94a3b8" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <Phone size={14} style={{ color: "#38bdf8" }} />
                  <a href={`tel:${inq.phone}`} style={{ color: "#38bdf8", textDecoration: "none", fontWeight: "600" }}>{inq.phone}</a>
                </div>
                {inq.email && (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <Mail size={14} style={{ color: "#a7f3d0" }} />
                    <a href={`mailto:${inq.email}`} style={{ color: "#cbd5e1", textDecoration: "none" }}>{inq.email}</a>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
