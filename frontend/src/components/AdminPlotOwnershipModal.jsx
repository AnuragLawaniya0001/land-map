import React, { useState, useEffect } from "react";
import { api, errMsg } from "@/lib/api";
import { UserCheck, History, ArrowRight, X, ShieldAlert, Plus } from "lucide-react";

export default function AdminPlotOwnershipModal({ plot, onClose, onOwnershipUpdated }) {
  const [ownershipData, setOwnershipData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showTransferForm, setShowTransferForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Transfer Form State
  const [form, setForm] = useState({
    party_name: "",
    party_phone: "",
    party_email: "",
    transaction_type: "RESALE", // INITIAL_SALE, RESALE, TRANSFER
    effective_from: new Date().toISOString().slice(0, 10),
  });

  const fetchOwnership = async () => {
    try {
      setLoading(true);
      const res = await api.get(`/admin/plots/${plot.id}/ownership`);
      setOwnershipData(res.data);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (plot?.id) fetchOwnership();
  }, [plot?.id]);

  const handleTransferSubmit = async (e) => {
    e.preventDefault();
    if (!form.party_name.trim()) return alert("New owner name is required");

    if (!window.confirm(`Confirm ownership transition to ${form.party_name}? This action creates a permanent append-only ownership history record.`)) return;

    try {
      setSubmitting(true);
      await api.post(`/admin/plots/${plot.id}/ownership/transfer`, {
        party_name: form.party_name,
        party_phone: form.party_phone,
        party_email: form.party_email,
        transaction_type: form.transaction_type,
        effective_from: form.effective_from,
      });

      setShowTransferForm(false);
      setForm({ party_name: "", party_phone: "", party_email: "", transaction_type: "RESALE", effective_from: new Date().toISOString().slice(0, 10) });
      fetchOwnership();
      if (onOwnershipUpdated) onOwnershipUpdated();
    } catch (err) {
      alert(errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const history = ownershipData?.history || [];
  const current = ownershipData?.current_owner;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="neo-card p-6 w-full max-w-xl space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 pb-3">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider opacity-60">PROPERTY OWNERSHIP LINEAGE</div>
            <h2 className="text-lg font-serif font-bold">Plot {plot.number || plot.plot_number} Ownership</h2>
          </div>
          <button onClick={onClose} className="text-xs opacity-60 hover:opacity-100">
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="py-8 text-center text-xs opacity-70 animate-pulse">
            Loading ownership history...
          </div>
        ) : error ? (
          <div className="p-3 text-xs rounded bg-red-500/10 text-red-500 border border-red-500/20">{error}</div>
        ) : (
          <div className="space-y-5">
            {/* CURRENT OWNER CARD */}
            <div className="p-4 neo-card bg-violet-500/10 border border-violet-500/30 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400 flex items-center gap-1.5">
                  <UserCheck size={16} /> CURRENT PROPERTY OWNER
                </span>
                {current && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-violet-500/20 text-violet-500 font-bold uppercase">
                    {current.ownership_type}
                  </span>
                )}
              </div>

              {current ? (
                <div className="text-sm space-y-0.5">
                  <div className="font-bold text-base">{current.party_name}</div>
                  <div className="text-xs opacity-70 font-mono">
                    Phone: {current.party_phone || "N/A"} · Email: {current.party_email || "N/A"}
                  </div>
                  <div className="text-[11px] opacity-60 font-mono">
                    Owner Since: {current.effective_from ? new Date(current.effective_from).toLocaleDateString() : "N/A"}
                  </div>
                </div>
              ) : (
                <div className="text-xs opacity-70 italic py-1">
                  No verified ownership record established yet.
                </div>
              )}
            </div>

            {/* ACTION: RESELL / TRANSFER BUTTON */}
            {!showTransferForm && (
              <button
                onClick={() => setShowTransferForm(true)}
                className="w-full neo-btn-primary text-xs py-2.5 font-semibold flex items-center justify-center gap-2"
              >
                <Plus size={16} /> Resell / Transfer Ownership Record
              </button>
            )}

            {/* RESELL / TRANSFER FORM */}
            {showTransferForm && (
              <form onSubmit={handleTransferSubmit} className="p-4 neo-inset rounded-xl space-y-4 border border-violet-500/30">
                <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 pb-2">
                  <h3 className="font-serif font-bold text-sm">Resell / Ownership Transfer</h3>
                  <button type="button" onClick={() => setShowTransferForm(false)} className="text-xs opacity-60">Cancel</button>
                </div>

                <div className="space-y-3 text-xs">
                  <div>
                    <label className="block font-semibold mb-1 opacity-70">New Owner Full Name *</label>
                    <input
                      type="text"
                      required
                      value={form.party_name}
                      onChange={(e) => setForm({ ...form, party_name: e.target.value })}
                      placeholder="e.g. Sahil Khan"
                      className="w-full px-3 py-2 text-xs rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold mb-1 opacity-70">Mobile Phone</label>
                      <input
                        type="text"
                        value={form.party_phone}
                        onChange={(e) => setForm({ ...form, party_phone: e.target.value })}
                        placeholder="+91 9876543210"
                        className="w-full px-3 py-2 text-xs rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold mb-1 opacity-70">Email Address</label>
                      <input
                        type="email"
                        value={form.party_email}
                        onChange={(e) => setForm({ ...form, party_email: e.target.value })}
                        placeholder="owner@example.com"
                        className="w-full px-3 py-2 text-xs rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold mb-1 opacity-70">Transaction Type</label>
                      <select
                        value={form.transaction_type}
                        onChange={(e) => setForm({ ...form, transaction_type: e.target.value })}
                        className="w-full px-3 py-2 text-xs rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700"
                      >
                        <option value="RESALE">Resale</option>
                        <option value="TRANSFER">Ownership Transfer</option>
                        <option value="INITIAL_SALE">Initial Sale</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-semibold mb-1 opacity-70">Effective Date</label>
                      <input
                        type="date"
                        value={form.effective_from}
                        onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
                        className="w-full px-3 py-2 text-xs rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700"
                      />
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full neo-btn-primary text-xs py-2.5 font-semibold"
                >
                  {submitting ? "Processing Transfer..." : "Confirm & Append Ownership Record"}
                </button>
              </form>
            )}

            {/* CHRONOLOGICAL APPEND-ONLY OWNERSHIP TIMELINE */}
            <div className="space-y-3 pt-2">
              <h3 className="text-xs font-serif font-bold uppercase tracking-wider opacity-70 flex items-center gap-1.5">
                <History size={14} /> Ownership Lineage Timeline ({history.length})
              </h3>

              {history.length === 0 ? (
                <div className="text-center py-6 text-xs opacity-60 font-mono">
                  No historical ownership records created yet.
                </div>
              ) : (
                <div className="space-y-3 relative before:absolute before:left-3 before:top-2 before:bottom-2 before:w-0.5 before:bg-violet-500/20">
                  {history.map((h, idx) => (
                    <div key={h.id} className="relative pl-8 space-y-1 text-xs">
                      <div className="absolute left-1.5 top-1.5 w-3 h-3 rounded-full bg-violet-500 border-2 border-slate-900" />
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm">{h.party_name}</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                          h.ownership_type === "ORIGINAL_BUYER" ? "bg-emerald-500/10 text-emerald-500" : "bg-blue-500/10 text-blue-500"
                        }`}>
                          {h.ownership_type}
                        </span>
                      </div>

                      <div className="text-mono text-[11px] opacity-70">
                        {h.transaction_type} · Effective: {new Date(h.effective_from).toLocaleDateString()}
                        {h.effective_to ? ` to ${new Date(h.effective_to).toLocaleDateString()}` : " (Active)"}
                      </div>

                      {h.registry_version && (
                        <div className="text-[10px] font-mono text-violet-500">
                          Associated Deed: Registry Version {h.registry_version}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
