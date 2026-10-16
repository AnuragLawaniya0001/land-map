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
    <div className="lm-page">
      <header className="lm-topbar">
        <div>
          <p className="lm-eyebrow">SUPER ADMIN</p>
          <h1>Admin accounts</h1>
          <p className="lm-muted">Create admin workspaces. Each admin signs in at <code>/admin</code>, manages only their own colonies, and shares their own public link.</p>
        </div>
        <button className="lm-btn-primary" onClick={() => setShowModal(true)} data-testid="new-admin-btn">
          <Plus size={14} /> New admin
        </button>
      </header>

      {err && <div className="lm-error">{err}</div>}

      <div className="lm-table" data-testid="admin-user-table">
        <div className="lm-table-head">
          <span>Name</span>
          <span>Public link</span>
          <span>Role</span>
          <span>Colonies</span>
          <span className="lm-table-actions">Actions</span>
        </div>
        {users.map((u) => (
          <div className={`lm-table-row ${!u.active ? "disabled" : ""}`} key={u.id} data-testid={`user-row-${u.email}`}>
            <span>
              <b>{u.name}</b>
              <small>{u.email}</small>
            </span>
            <span>
              {u.role === "super_admin" ? (
                <code>/</code>
              ) : (
                <button className="lm-link-btn" onClick={() => copyLink(u)} data-testid={`copy-link-${u.email}`}>
                  <LinkIcon size={12} /> {copied === u.id ? "Copied!" : `/u/${u.slug}`}
                </button>
              )}
            </span>
            <span className="lm-role-pill">{u.role.replace("_", " ")}</span>
            <span>{u.colony_count ?? 0}<small>{u.last_login ? `last login ${new Date(u.last_login).toLocaleDateString()}` : "never logged in"}</small></span>
            <span className="lm-table-actions">
              <button className="lm-icon-btn" title={u.active ? "Disable" : "Enable"} onClick={() => toggleActive(u)} data-testid={`toggle-user-${u.email}`}>
                <Power size={14} />
              </button>
              <button className="lm-icon-btn" title="Reset password" onClick={() => setResetForUser(u)} data-testid={`reset-user-${u.email}`}>
                <KeyRound size={14} />
              </button>
              {u.role !== "super_admin" && (
                <button className="lm-icon-btn danger" title="Delete" onClick={() => remove(u)} data-testid={`delete-user-${u.email}`}>
                  <Trash2 size={14} />
                </button>
              )}
            </span>
          </div>
        ))}
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
              <h3>Reset password · {resetForUser.name}</h3>
              <button className="lm-icon-btn" onClick={() => setResetForUser(null)}><X size={14} /></button>
            </div>
            <form onSubmit={submitReset}>
              <label>New password<input required type="password" minLength={6} value={resetPw} onChange={(e) => setResetPw(e.target.value)} data-testid="reset-password-input" /></label>
              <button className="lm-btn-primary full" data-testid="submit-reset">Reset password</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
