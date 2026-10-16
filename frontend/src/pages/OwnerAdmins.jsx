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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold font-serif tracking-tight">Admin Accounts</h1>
          <p className="text-sm opacity-70">Govern platform administrators and their associated tenant data</p>
        </div>

        <button
          onClick={() => { setFormError(""); setShowModal(true); }}
          className="neo-btn-primary self-start sm:self-auto flex items-center gap-2"
        >
          <UserPlus size={16} />
          + New Admin
        </button>
      </div>

      {loading ? (
        <div className="neo-card p-12 text-center text-sm opacity-70 animate-pulse">
          Loading platform administrators...
        </div>
      ) : error ? (
        <div className="neo-card p-6 border-l-4 border-red-500 text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : (
        <div className="neo-card p-6 overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 opacity-60 uppercase text-xs tracking-wider">
                <th className="py-3 px-4">Admin</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Colonies</th>
                <th className="py-3 px-4">Plots (Avail / Sold)</th>
                <th className="py-3 px-4">Inquiries</th>
                <th className="py-3 px-4">Shares</th>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {admins.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center opacity-60">
                    No administrators found.
                  </td>
                </tr>
              ) : (
                admins.map((admin) => (
                  <tr key={admin.uid} className="hover:bg-violet-500/5 transition-colors">
                    <td className="py-4 px-4">
                      <div className="font-semibold">{admin.name || "Unnamed Admin"}</div>
                      <div className="text-xs opacity-60 font-mono">{admin.email}</div>
                    </td>
                    <td className="py-4 px-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                        admin.active !== false
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                          : "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20"
                      }`}>
                        {admin.active !== false ? (
                          <><CheckCircle size={12} /> ACTIVE</>
                        ) : (
                          <><XCircle size={12} /> INACTIVE</>
                        )}
                      </span>
                    </td>
                    <td className="py-4 px-4 font-mono font-medium">
                      {admin.metrics?.coloniesCount || 0}
                    </td>
                    <td className="py-4 px-4">
                      <span className="font-mono font-medium">{admin.metrics?.totalPlots || 0}</span>
                      <span className="text-xs opacity-60 font-mono ml-2">
                        ({admin.metrics?.availablePlots || 0} / {admin.metrics?.soldPlots || 0})
                      </span>
                    </td>
                    <td className="py-4 px-4 font-mono font-medium">
                      {admin.metrics?.inquiriesCount || 0}
                    </td>
                    <td className="py-4 px-4 font-mono font-medium">
                      {admin.metrics?.activeSharesCount || 0}
                    </td>
                    <td className="py-4 px-4 text-xs opacity-60 font-mono">
                      {admin.createdAt ? new Date(admin.createdAt).toLocaleDateString() : "N/A"}
                    </td>
                    <td className="py-4 px-4 text-right flex items-center justify-end gap-2">
                      <Link
                        to={`/owner-panel/admins/${admin.id || admin.uid}/inspect`}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg neo-card hover:border-violet-500/40 text-violet-600 dark:text-violet-400 transition-all flex items-center gap-1"
                      >
                        <Eye size={14} /> Inspect Workspace
                      </Link>
                      <button
                        onClick={() => handleToggleStatus(admin.id || admin.uid, admin.active !== false)}
                        className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ${
                          admin.active !== false
                            ? "border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10"
                            : "border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                        }`}
                      >
                        {admin.active !== false ? "Deactivate" : "Activate"}
                      </button>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="neo-card p-6 w-full max-w-md space-y-4">
            <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 pb-3">
              <h2 className="text-lg font-bold font-serif">Create New Administrator</h2>
              <button
                onClick={() => setShowModal(false)}
                className="text-xs opacity-60 hover:opacity-100"
              >
                ✕
              </button>
            </div>

            {formError && (
              <div className="text-xs p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400">
                {formError}
              </div>
            )}

            <form onSubmit={handleCreateAdmin} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold mb-1 opacity-70">Admin Full Name</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Jasjot Singh"
                  className="w-full px-3 py-2 text-sm rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold mb-1 opacity-70">Email Address</label>
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="admin@spacer.com"
                  className="w-full px-3 py-2 text-sm rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold mb-1 opacity-70">Password</label>
                <input
                  type="password"
                  required
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="••••••••"
                  className="w-full px-3 py-2 text-sm rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold mb-1 opacity-70">Confirm Password</label>
                <input
                  type="password"
                  required
                  value={form.confirmPassword}
                  onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                  placeholder="••••••••"
                  className="w-full px-3 py-2 text-sm rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-xs font-semibold opacity-70 hover:opacity-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="neo-btn-primary text-xs"
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
