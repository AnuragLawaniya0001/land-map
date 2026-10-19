import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api, errMsg } from "../lib/api";
import { Users, UserPlus, CheckCircle, XCircle, Shield, Calendar, MapPin, Layers, Eye } from "lucide-react";

export default function OwnerAdmins() {
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", confirmPassword: "" });
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchAdmins = async () => {
    try {
      setLoading(true);
      const res = await api.get("/owner/admins");
      setAdmins(res.data.admins || []);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAdmins();
  }, []);

  const handleToggleStatus = async (uid, currentStatus) => {
    const action = currentStatus ? "deactivate" : "activate";
    if (!window.confirm(`Are you sure you want to ${action} this admin account?`)) return;

    try {
      await api.patch(`/owner/admins/${uid}/status`, { active: !currentStatus });
      fetchAdmins();
    } catch (err) {
      alert(errMsg(err));
    }
  };

  const handleCreateAdmin = async (e) => {
    e.preventDefault();
    setFormError("");

    if (!form.name.trim() || !form.email.trim() || !form.password) {
      setFormError("All fields are required");
      return;
    }
    if (form.password !== form.confirmPassword) {
      setFormError("Passwords do not match");
      return;
    }
    if (form.password.length < 6) {
      setFormError("Password must be at least 6 characters");
      return;
    }

    try {
      setSubmitting(true);
      await api.post("/owner/admins", {
        name: form.name,
        email: form.email,
        password: form.password
      });

      setShowModal(false);
      setForm({ name: "", email: "", password: "", confirmPassword: "" });
      fetchAdmins();
    } catch (err) {
      setFormError(errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="lm-page-container" data-testid="owner-admins-page">
      {/* Header */}
      <header className="lm-modern-header">
        <div className="lm-modern-header-left">
          <span className="lm-modern-eyebrow">Tenant Management</span>
          <h1 className="lm-modern-title">Admin Workspaces</h1>
          <p className="lm-modern-subtitle">
            Govern platform administrators and their associated colonies, inventory, and inquiries.
          </p>
        </div>

        <div className="lm-modern-header-actions">
          <button
            onClick={() => { setFormError(""); setShowModal(true); }}
            className="lm-btn-glow"
            data-testid="owner-new-admin-btn"
          >
            <UserPlus size={16} />
            + New Admin Workspace
          </button>
        </div>
      </header>

      {loading ? (
        <div className="lm-modern-card p-12 text-center text-sm text-slate-400 animate-pulse">
          Loading platform administrators...
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
                <th style={{ width: "24%" }}>Admin Name & Email</th>
                <th style={{ width: "12%" }}>Status</th>
                <th style={{ width: "10%" }}>Colonies</th>
                <th style={{ width: "16%" }}>Plots (Avail / Sold)</th>
                <th style={{ width: "10%" }}>Inquiries</th>
                <th style={{ width: "10%" }}>Shares</th>
                <th style={{ width: "18%", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {admins.length === 0 ? (
                <tr>
                  <td colSpan="7" className="py-8 text-center text-slate-400">
                    No administrators found.
                  </td>
                </tr>
              ) : (
                admins.map((admin) => (
                  <tr key={admin.uid || admin.id} data-testid={`admin-row-${admin.email}`}>
                    <td>
                      <div className="font-bold text-[#172A25] text-xs">{admin.name || "Unnamed Admin"}</div>
                      <div className="text-[11px] text-[#6B7280] font-mono">{admin.email}</div>
                    </td>
                    <td>
                      <span className={`lm-badge ${admin.active !== false ? "lm-badge-success" : "lm-badge-danger"}`}>
                        <span className="lm-badge-dot" />
                        {admin.active !== false ? "ACTIVE" : "INACTIVE"}
                      </span>
                    </td>
                    <td className="font-mono font-bold text-xs text-[#172A25]">
                      {admin.metrics?.coloniesCount || 0}
                    </td>
                    <td>
                      <span className="font-mono font-bold text-xs text-[#172A25]">{admin.metrics?.totalPlots || 0}</span>
                      <span className="text-[11px] text-[#6B7280] font-mono ml-1.5">
                        (<span className="text-[#047857] font-semibold">{admin.metrics?.availablePlots || 0}</span> / <span className="text-[#BE123C] font-semibold">{admin.metrics?.soldPlots || 0}</span>)
                      </span>
                    </td>
                    <td className="font-mono font-medium text-xs text-[#B45309]">
                      {admin.metrics?.inquiriesCount || 0}
                    </td>
                    <td className="font-mono font-medium text-xs text-[#0D1B2A]">
                      {admin.metrics?.activeSharesCount || 0}
                    </td>
                    <td className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          to={`/superadmin/admins/${admin.id || admin.uid}/inspect`}
                          className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-[#F4EFE6] border border-[#E8E2D6] text-[#173F35] hover:bg-[#EAE5DB] transition-all flex items-center gap-1"
                        >
                          <Eye size={13} /> Inspect
                        </Link>
                        <button
                          onClick={() => handleToggleStatus(admin.id || admin.uid, admin.active !== false)}
                          className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-all ${
                            admin.active !== false
                              ? "border-rose-300 text-rose-700 bg-rose-50 hover:bg-rose-100"
                              : "border-emerald-300 text-emerald-800 bg-emerald-50 hover:bg-emerald-100"
                          }`}
                        >
                          {admin.active !== false ? "Deactivate" : "Activate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Admin Modal */}
      {showModal && (
        <div className="lm-modal-shade" onClick={() => setShowModal(false)}>
          <div className="lm-modal max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="lm-modal-head">
              <h3>Create New Administrator</h3>
              <button
                onClick={() => setShowModal(false)}
                className="lm-icon-btn"
              >
                ✕
              </button>
            </div>

            {formError && (
              <div className="lm-badge-danger p-3 rounded-xl text-xs font-medium w-full">
                {formError}
              </div>
            )}

            <form onSubmit={handleCreateAdmin} className="space-y-4">
              <div className="lm-modern-input-group">
                <label>Admin Full Name</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Jasjot Singh"
                  className="lm-modern-input"
                />
              </div>

              <div className="lm-modern-input-group">
                <label>Email Address</label>
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="admin@livemap.com"
                  className="lm-modern-input"
                />
              </div>

              <div className="lm-modern-input-group">
                <label>Password</label>
                <input
                  type="password"
                  required
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="••••••••"
                  className="lm-modern-input"
                />
              </div>

              <div className="lm-modern-input-group">
                <label>Confirm Password</label>
                <input
                  type="password"
                  required
                  value={form.confirmPassword}
                  onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                  placeholder="••••••••"
                  className="lm-modern-input"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="lm-btn-secondary-dark text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="lm-btn-glow text-xs"
                >
                  {submitting ? "Creating..." : "Create Admin Account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
