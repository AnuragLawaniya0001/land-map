import { useEffect, useState } from "react";
import { Plus, X, Trash2, KeyRound, Power, Link as LinkIcon } from "lucide-react";
import { api, errMsg } from "@/lib/api";

function CreateAdminModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await api.post("/admin/users", form);
      onCreated(r.data);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="lm-modal-shade" onClick={onClose}>
      <div className="lm-modal" onClick={(e) => e.stopPropagation()} data-testid="create-admin-modal">
        <div className="lm-modal-head">
          <h3>New admin</h3>
          <button className="lm-icon-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <form onSubmit={submit}>
          <label>Full name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="new-admin-name" /></label>
          <label>Email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="new-admin-email" /></label>
          <label>Phone<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} data-testid="new-admin-phone" /></label>
          <label>Password (min 6)<input required type="password" minLength={6} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} data-testid="new-admin-password" /></label>
          {err && <div className="lm-error">{err}</div>}
          <button className="lm-btn-primary full" disabled={busy} data-testid="submit-admin">
            {busy ? "Creating…" : "Create admin"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [err, setErr] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [resetForUser, setResetForUser] = useState(null);
  const [resetPw, setResetPw] = useState("");
  const [copied, setCopied] = useState(null);
  const copyLink = async (u) => {
    await navigator.clipboard.writeText(`${window.location.origin}/u/${u.slug}`);
    setCopied(u.id);
    setTimeout(() => setCopied(null), 1800);
  };

  const load = () =>
    api.get("/admin/users").then((r) => setUsers(r.data)).catch((e) => setErr(errMsg(e)));
  useEffect(() => { load(); }, []);

  const toggleActive = async (u) => {
    try {
      await api.patch(`/admin/users/${u.id}`, { active: !u.active });
      load();
    } catch (e) { setErr(errMsg(e)); }
  };
  const remove = async (u) => {
    if (!window.confirm(`Delete admin ${u.name}?`)) return;
    try { await api.delete(`/admin/users/${u.id}`); load(); } catch (e) { setErr(errMsg(e)); }
  };
  const submitReset = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/admin/users/${resetForUser.id}/reset-password`, { new_password: resetPw });
      setResetForUser(null);
      setResetPw("");
    } catch (e) { setErr(errMsg(e)); }
  };

  return (
    <div className="lm-page-container" data-testid="admin-users-page">
      <header className="lm-modern-header">
        <div className="lm-modern-header-left">
          <span className="lm-modern-eyebrow">Tenant Governance</span>
          <h1 className="lm-modern-title">Admin Workspaces</h1>
          <p className="lm-modern-subtitle">
            Create and govern admin accounts. Each administrator manages isolated colonies and their custom public showcase link.
          </p>
        </div>
        <div className="lm-modern-header-actions">
          <button className="lm-btn-glow" onClick={() => setShowModal(true)} data-testid="new-admin-btn">
            <Plus size={16} /> New Admin Workspace
          </button>
        </div>
      </header>

      {err && (
        <div className="lm-badge-danger p-3 rounded-xl mb-4 text-xs font-medium w-full">
          {err}
        </div>
      )}

      <div className="lm-modern-table-container" data-testid="admin-user-table">
        <table className="lm-modern-table">
          <thead>
            <tr>
              <th style={{ width: "28%" }}>Administrator</th>
              <th style={{ width: "24%" }}>Public Portal Link</th>
              <th style={{ width: "16%" }}>Role</th>
              <th style={{ width: "16%" }}>Colonies</th>
              <th style={{ width: "16%", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={!u.active ? "opacity-50" : ""} data-testid={`user-row-${u.email}`}>
                <td>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[#E8F3EE] text-[#164E3F] border border-[#C2DFD2] font-bold flex items-center justify-center text-xs">
                      {u.name?.[0]?.toUpperCase()}
                    </div>
                    <div>
                      <div className="font-bold text-[#0F1E36] text-xs">{u.name}</div>
                      <div className="text-[11px] text-[#64748B] font-mono">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td>
                  {u.role === "super_admin" ? (
                    <code className="text-xs text-[#0F1E36] font-mono bg-[#F5F1EB] border border-[#E8E2D5] px-2.5 py-0.5 rounded">/ (Platform Root)</code>
                  ) : (
                    <button
                      className="inline-flex items-center gap-1.5 text-xs text-[#164E3F] hover:text-[#0D5C46] font-mono bg-[#E8F3EE] hover:bg-[#D5EAE0] border border-[#C2DFD2] px-2.5 py-1 rounded-lg transition-all"
                      onClick={() => copyLink(u)}
                      data-testid={`copy-link-${u.email}`}
                      title="Click to copy public link"
                    >
                      <LinkIcon size={12} />
                      <span>{copied === u.id ? "Copied!" : `/u/${u.slug}`}</span>
                    </button>
                  )}
                </td>
                <td>
                  <span className={`lm-badge ${u.role === "super_admin" ? "lm-badge-super" : "lm-badge-info"}`}>
                    <span className="lm-badge-dot" />
                    {u.role.replace("_", " ")}
                  </span>
                </td>
                <td>
                  <div className="font-mono text-xs font-bold text-[#0F1E36]">
                    {u.colony_count ?? 0} <span className="text-[10px] text-[#64748B] font-normal">colonies</span>
                  </div>
                  <div className="text-[10px] text-[#94A3B8] mt-0.5">
                    {u.last_login ? `Active ${new Date(u.last_login).toLocaleDateString()}` : "Never logged in"}
                  </div>
                </td>
                <td>
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      className={`p-1.5 rounded-lg border text-xs transition-all ${
                        u.active
                          ? "bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100"
                          : "bg-slate-100 border-slate-300 text-slate-500 hover:bg-slate-200"
                      }`}
                      title={u.active ? "Account Active (Click to disable)" : "Account Disabled (Click to activate)"}
                      onClick={() => toggleActive(u)}
                      data-testid={`toggle-user-${u.email}`}
                    >
                      <Power size={13} />
                    </button>
                    <button
                      className="p-1.5 rounded-lg bg-slate-100 border border-slate-200 text-slate-700 hover:bg-slate-200 transition-all text-xs"
                      title="Reset Password"
                      onClick={() => setResetForUser(u)}
                      data-testid={`reset-user-${u.email}`}
                    >
                      <KeyRound size={13} />
                    </button>
                    {u.role !== "super_admin" && (
                      <button
                        className="p-1.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-600 hover:bg-rose-100 transition-all text-xs"
                        title="Delete Admin"
                        onClick={() => remove(u)}
                        data-testid={`delete-user-${u.email}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <CreateAdminModal
          onClose={() => setShowModal(false)}
          onCreated={() => { setShowModal(false); load(); }}
        />
      )}

      {resetForUser && (
        <div className="lm-modal-shade" onClick={() => setResetForUser(null)}>
          <div className="lm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="lm-modal-head">
              <h3>Reset Password · {resetForUser.name}</h3>
              <button className="lm-icon-btn" onClick={() => setResetForUser(null)}><X size={14} /></button>
            </div>
            <form onSubmit={submitReset} className="space-y-4">
              <div className="lm-modern-input-group">
                <label>New Password (min 6 chars)</label>
                <input
                  required
                  type="password"
                  minLength={6}
                  value={resetPw}
                  onChange={(e) => setResetPw(e.target.value)}
                  data-testid="reset-password-input"
                  className="lm-modern-input"
                  placeholder="Enter new password"
                />
              </div>
              <button className="lm-btn-glow w-full" data-testid="submit-reset">
                Update Password
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
