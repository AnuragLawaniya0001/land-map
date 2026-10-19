import { useState, useEffect, useMemo } from "react";
import {
  Share2,
  Plus,
  Copy,
  Check,
  Smartphone,
  Laptop,
  Tablet,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  RotateCw,
  Ban,
  Clock,
  Eye,
  Search,
  ExternalLink,
  MessageCircle,
  X,
  MapPin,
  Calendar,
  Users,
  CheckCircle2,
  Filter,
} from "lucide-react";
import { api, errMsg } from "@/lib/api";

export default function AdminColonyShares({ user }) {
  const [shares, setShares] = useState([]);
  const [colonies, setColonies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState("");

  // Filter States
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedColonyFilter, setSelectedColonyFilter] = useState("ALL");
  const [selectedStatusFilter, setSelectedStatusFilter] = useState("ALL");

  // Create Modal State
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newColonyId, setNewColonyId] = useState("");
  const [newClientLabel, setNewClientLabel] = useState("");
  const [newMaxDevices, setNewMaxDevices] = useState(5);
  const [newExpiryDays, setNewExpiryDays] = useState(7);
  const [createdShareResult, setCreatedShareResult] = useState(null);

  // Telemetry Modal State
  const [telemetryModal, setTelemetryModal] = useState(null); // { shareId, data, loading }
  const [copiedId, setCopiedId] = useState(null);

  const isSuper = user?.role === "super_admin";

  const fetchSharesAndColonies = async () => {
    try {
      setLoading(true);
      setError(null);

      // 1. Resilient Colony Fetching (tries /admin/colony-shares/colonies then /admin/colonies)
      let cols = [];
      try {
        const coloniesRes = await api.get("/admin/colony-shares/colonies");
        cols = coloniesRes.data.colonies || [];
      } catch (errColonies) {
        console.warn("Primary colonies endpoint failed, trying fallback:", errColonies);
        try {
          const fallbackRes = await api.get("/admin/colonies");
          cols = (fallbackRes.data || []).map((c) => ({
            id: c.id || c._id,
            name: c.name || "Untitled Colony",
            location: c.location || "",
          }));
        } catch (errFallback) {
          console.error("Colonies fallback also failed:", errFallback);
        }
      }

      setColonies(cols);
      if (cols.length > 0) {
        setNewColonyId((prev) => prev || cols[0].id);
      }

      // 2. Shares Fetching
      try {
        const sharesRes = await api.get("/admin/colony-shares");
        setShares(sharesRes.data.shares || []);
      } catch (errShares) {
        console.warn("Shares endpoint failed:", errShares);
        setShares([]);
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSharesAndColonies();
  }, []);

  const handleCopyLink = (tokenOrUrl, shareId) => {
    let path = tokenOrUrl || "";
    if (!path.startsWith("http")) {
      if (!path.startsWith("/")) {
        path = `/c/share/${path}`;
      }
      path = `${window.location.origin}${path}`;
    }
    navigator.clipboard.writeText(path);
    setCopiedId(shareId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCreateShare = async (e) => {
    e.preventDefault();
    if (!newColonyId) {
      setError("Please select a colony to share.");
      return;
    }
    try {
      setCreating(true);
      setError(null);
      const res = await api.post("/admin/colony-shares", {
        colony_id: newColonyId,
        client_label: newClientLabel,
        max_devices: parseInt(newMaxDevices, 10) || 5,
        expires_in_days: newExpiryDays ? parseFloat(newExpiryDays) : null,
      });

      const newShare = res.data.share;
      setCreatedShareResult(newShare);
      setSuccessMsg("Secure share link generated successfully!");
      fetchSharesAndColonies();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setCreating(false);
    }
  };

  const handleRevokeShare = async (shareId) => {
    if (!window.confirm("Are you sure you want to revoke this share link? It will be disabled immediately.")) {
      return;
    }
    try {
      await api.post(`/admin/colony-shares/${shareId}/revoke`);
      setSuccessMsg("Share link has been revoked.");
      fetchSharesAndColonies();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const handleRegenerateShare = async (shareId) => {
    try {
      const res = await api.post(`/admin/colony-shares/${shareId}/regenerate`);
      setSuccessMsg("Fresh share link generated! Old link was expired.");
      setCreatedShareResult(res.data.share);
      setIsCreateOpen(true);
      fetchSharesAndColonies();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const handleViewTelemetry = async (shareId) => {
    try {
      setTelemetryModal({ shareId, data: null, loading: true });
      const res = await api.get(`/admin/colony-shares/${shareId}/devices`);
      setTelemetryModal({ shareId, data: res.data, loading: false });
    } catch (err) {
      setError(errMsg(err));
      setTelemetryModal(null);
    }
  };

  // Filtered Shares
  const filteredShares = useMemo(() => {
    return shares.filter((s) => {
      const matchColony =
        selectedColonyFilter === "ALL" || s.colony_id === selectedColonyFilter;
      const matchStatus =
        selectedStatusFilter === "ALL" || s.status === selectedStatusFilter;
      const q = searchQuery.toLowerCase().trim();
      const matchQuery =
        !q ||
        s.colony_name?.toLowerCase().includes(q) ||
        s.client_label?.toLowerCase().includes(q) ||
        s.created_by_name?.toLowerCase().includes(q);
      return matchColony && matchStatus && matchQuery;
    });
  }, [shares, selectedColonyFilter, selectedStatusFilter, searchQuery]);

  // Overall Statistics
  const stats = useMemo(() => {
    const total = shares.length;
    const active = shares.filter((s) => s.status === "ACTIVE").length;
    const breached = shares.filter((s) => s.status === "DEVICE_LIMIT_BREACHED").length;
    const totalDevices = shares.reduce((acc, s) => acc + (s.registered_devices_count || 0), 0);
    return { total, active, breached, totalDevices };
  }, [shares]);

  const getStatusBadge = (status) => {
    switch (status) {
      case "ACTIVE":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Active
          </span>
        );
      case "DEVICE_LIMIT_BREACHED":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200">
            <ShieldAlert size={12} className="text-rose-600" />
            Limit Breached
          </span>
        );
      case "EXPIRED":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-600 border border-slate-200">
            <Clock size={12} />
            Expired
          </span>
        );
      case "REVOKED":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
            <Ban size={12} />
            Revoked
          </span>
        );
      default:
        return <span className="text-xs text-slate-500">{status}</span>;
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-16 text-[#172A25]">
      {/* =====================================================================
          HEADER SECTION
         ===================================================================== */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#DCD2BE] pb-5">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-[#173F35] text-white shadow-md shadow-[#173F35]/20">
              <Share2 size={22} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-[#172A25] flex items-center gap-2">
                Colony Share Studio
                <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-[#F3EFE6] border border-[#DCD2BE] text-[#173F35]">
                  Device Control
                </span>
              </h1>
              <p className="text-xs text-[#5C6470] mt-0.5">
                Generate secure, device-restricted 2D/3D map links for clients. Automatically expires if device limits are breached.
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={() => {
            setCreatedShareResult(null);
            if (colonies.length > 0) {
              setNewColonyId((prev) => prev || colonies[0].id);
            }
            setIsCreateOpen(true);
          }}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#173F35] hover:bg-[#0F2922] text-white font-bold text-xs shadow-md transition-all active:scale-[0.98]"
        >
          <Plus size={16} />
          Create Share Link
        </button>
      </div>

      {/* =====================================================================
          NOTICES & ERRORS
         ===================================================================== */}
      {error && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-rose-600 shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-rose-500 hover:text-rose-700">
            <X size={14} />
          </button>
        </div>
      )}

      {successMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={15} className="text-emerald-600 shrink-0" />
            <span>{successMsg}</span>
          </div>
          <button onClick={() => setSuccessMsg("")} className="text-emerald-600 hover:text-emerald-800">
            <X size={14} />
          </button>
        </div>
      )}

      {/* =====================================================================
          METRICS CARDS
         ===================================================================== */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="p-4 rounded-2xl bg-white border border-[#DCD2BE] shadow-xs space-y-1">
          <span className="text-[11px] font-bold text-[#5C6470] uppercase tracking-wider block">
            Active Links
          </span>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-[#173F35] font-mono">{stats.active}</span>
            <span className="text-xs text-[#5C6470]">of {stats.total} total</span>
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-white border border-[#DCD2BE] shadow-xs space-y-1">
          <span className="text-[11px] font-bold text-[#5C6470] uppercase tracking-wider block">
            Client Devices Active
          </span>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-[#172A25] font-mono">{stats.totalDevices}</span>
            <Smartphone size={16} className="text-[#173F35]" />
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-white border border-[#DCD2BE] shadow-xs space-y-1">
          <span className="text-[11px] font-bold text-[#5C6470] uppercase tracking-wider block">
            Breached Links
          </span>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-rose-600 font-mono">{stats.breached}</span>
            <ShieldAlert size={16} className="text-rose-500" />
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-white border border-[#DCD2BE] shadow-xs space-y-1">
          <span className="text-[11px] font-bold text-[#5C6470] uppercase tracking-wider block">
            Accessible Colonies
          </span>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-[#173F35] font-mono">{colonies.length}</span>
            <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
              {isSuper ? "SuperAdmin (All)" : "Assigned"}
            </span>
          </div>
        </div>
      </div>

      {/* =====================================================================
          FILTER & SEARCH TOOLBAR
         ===================================================================== */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 rounded-2xl bg-white border border-[#DCD2BE] shadow-xs">
        <div className="flex flex-wrap items-center gap-2">
          {/* Status Chips */}
          {["ALL", "ACTIVE", "DEVICE_LIMIT_BREACHED", "EXPIRED", "REVOKED"].map((st) => (
            <button
              key={st}
              onClick={() => setSelectedStatusFilter(st)}
              className={`px-3 py-1 rounded-xl text-xs font-bold transition-all ${
                selectedStatusFilter === st
                  ? "bg-[#173F35] text-white shadow-xs"
                  : "bg-[#F3EFE6] text-[#5C6470] hover:text-[#172A25] hover:bg-[#EDE6D6]"
              }`}
            >
              {st === "DEVICE_LIMIT_BREACHED" ? "Breached" : st.charAt(0) + st.slice(1).toLowerCase()}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {/* Colony Filter Dropdown */}
          <select
            value={selectedColonyFilter}
            onChange={(e) => setSelectedColonyFilter(e.target.value)}
            className="px-3 py-1.5 rounded-xl bg-[#F3EFE6] border border-[#DCD2BE] text-xs font-semibold text-[#172A25] outline-none"
          >
            <option value="ALL">All Colonies ({colonies.length})</option>
            {colonies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          {/* Search Box */}
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5C6470]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search client or colony..."
              className="pl-8 pr-3 py-1.5 rounded-xl bg-[#F3EFE6] border border-[#DCD2BE] text-xs font-medium text-[#172A25] focus:outline-none focus:bg-white focus:border-[#173F35] w-48 sm:w-56"
            />
          </div>
        </div>
      </div>

      {/* =====================================================================
          SHARES LISTING
         ===================================================================== */}
      {loading ? (
        <div className="p-12 text-center text-xs text-[#5C6470]">
          <RotateCw size={24} className="animate-spin mx-auto mb-2 text-[#173F35]" />
          Loading share links & device telemetry...
        </div>
      ) : filteredShares.length === 0 ? (
        <div className="p-12 text-center bg-white border border-[#DCD2BE] rounded-3xl space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-[#F3EFE6] text-[#173F35] flex items-center justify-center mx-auto">
            <Share2 size={24} />
          </div>
          <h3 className="font-bold text-sm text-[#172A25]">No Share Links Found</h3>
          <p className="text-xs text-[#5C6470] max-w-sm mx-auto">
            {shares.length === 0
              ? "Generate your first secure client link to share colony maps with device limits."
              : "No links match the selected filter or search criteria."}
          </p>
          {shares.length === 0 && (
            <button
              onClick={() => setIsCreateOpen(true)}
              className="px-4 py-2 rounded-xl bg-[#173F35] hover:bg-[#0F2922] text-white font-bold text-xs shadow-sm transition"
            >
              + Create First Link
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredShares.map((s) => {
            const usagePct = Math.min(
              100,
              Math.round((s.registered_devices_count / (s.max_devices || 1)) * 100)
            );
            const isBreached = s.status === "DEVICE_LIMIT_BREACHED";

            return (
              <div
                key={s.id}
                className={`p-4 rounded-2xl bg-white border shadow-xs transition-all flex flex-col justify-between gap-4 ${
                  isBreached
                    ? "border-rose-200 bg-rose-50/20"
                    : "border-[#DCD2BE] hover:border-[#173F35]"
                }`}
              >
                {/* Top: Colony & Status */}
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="font-bold text-sm text-[#172A25] flex items-center gap-1.5">
                        <MapPin size={14} className="text-[#173F35] shrink-0" />
                        {s.colony_name}
                      </span>
                      <span className="text-xs font-semibold text-[#5C6470] block mt-0.5">
                        {s.client_label}
                      </span>
                    </div>
                    {getStatusBadge(s.status)}
                  </div>

                  {/* Device Meter Bar */}
                  <div className="p-2.5 rounded-xl bg-[#F3EFE6] border border-[#DCD2BE] space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-semibold text-[#5C6470] flex items-center gap-1">
                        <Smartphone size={12} className="text-[#173F35]" /> Device Limit Usage:
                      </span>
                      <span className="font-mono font-bold text-[#173F35]">
                        {s.registered_devices_count} / {s.max_devices} Devices
                      </span>
                    </div>

                    <div className="w-full bg-[#E2DAC7] h-2 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          isBreached
                            ? "bg-rose-600"
                            : usagePct >= 80
                            ? "bg-amber-500"
                            : "bg-[#173F35]"
                        }`}
                        style={{ width: `${usagePct}%` }}
                      />
                    </div>

                    {isBreached && (
                      <p className="text-[10px] text-rose-600 font-bold flex items-center gap-1 pt-0.5">
                        <ShieldAlert size={11} /> 6th Device Attempt Detected. Link globally killed.
                      </p>
                    )}
                  </div>

                  {/* Metadata: Created By & Expiry */}
                  <div className="grid grid-cols-2 gap-2 text-[10px] text-[#5C6470] pt-1">
                    <div>
                      <span className="block font-semibold">Created:</span>
                      <span>{s.created_at ? new Date(s.created_at).toLocaleDateString() : "N/A"}</span>
                    </div>
                    <div>
                      <span className="block font-semibold">Expires:</span>
                      <span>
                        {s.expires_at ? new Date(s.expires_at).toLocaleDateString() : "Never"}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Actions Bottom Bar */}
                <div className="pt-3 border-t border-[#DCD2BE] flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleViewTelemetry(s.id)}
                    className="flex-1 py-1.5 px-2.5 rounded-xl bg-[#F3EFE6] hover:bg-[#EDE6D6] text-[#172A25] font-bold text-xs flex items-center justify-center gap-1.5 border border-[#DCD2BE] transition"
                    title="View device telemetry"
                  >
                    <Eye size={13} className="text-[#173F35]" />
                    Devices ({s.registered_devices_count})
                  </button>

                  {s.status === "ACTIVE" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleCopyLink(s.share_url || s.raw_token || s.raw_token_prefix, s.id)}
                        className={`p-2 rounded-xl text-xs font-bold transition flex items-center justify-center border ${
                          copiedId === s.id
                            ? "bg-emerald-600 text-white border-emerald-600"
                            : "bg-[#173F35] text-white hover:bg-[#0F2922] border-[#173F35]"
                        }`}
                        title="Copy Share Link"
                      >
                        {copiedId === s.id ? <Check size={14} /> : <Copy size={14} />}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleRevokeShare(s.id)}
                        className="p-2 rounded-xl bg-white hover:bg-rose-50 text-rose-600 hover:text-rose-700 border border-[#DCD2BE] hover:border-rose-300 transition"
                        title="Revoke Share Link"
                      >
                        <Ban size={14} />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleRegenerateShare(s.id)}
                      className="py-1.5 px-3 rounded-xl bg-[#173F35] hover:bg-[#0F2922] text-white font-bold text-xs flex items-center gap-1.5 transition"
                      title="Re-generate fresh link"
                    >
                      <RotateCw size={12} />
                      Re-create
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* =====================================================================
          MODAL: CREATE NEW SHARE LINK
         ===================================================================== */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-lg rounded-3xl bg-[#FAF8F5] border border-[#DCD2BE] shadow-2xl p-6 text-[#172A25] flex flex-col gap-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#DCD2BE]">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-[#173F35] text-white">
                  <Share2 size={18} />
                </div>
                <div>
                  <h3 className="font-bold text-base text-[#172A25]">
                    {createdShareResult ? "Share Link Ready!" : "Generate Colony Share Link"}
                  </h3>
                  <p className="text-xs text-[#5C6470]">
                    {createdShareResult
                      ? "Share this secure link with your client. Strict device monitoring is active."
                      : "Configure colony, recipient details, and strict device limits."}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setIsCreateOpen(false);
                  setCreatedShareResult(null);
                }}
                className="text-[#5C6470] hover:text-[#172A25]"
              >
                <X size={18} />
              </button>
            </div>

            {createdShareResult ? (
              /* Success / Result Screen */
              <div className="space-y-4 py-2">
                <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 space-y-1">
                  <span className="font-bold block text-sm flex items-center gap-1.5">
                    <CheckCircle2 size={16} className="text-emerald-600" />
                    Link Created Successfully!
                  </span>
                  <p>
                    Colony: <b>{createdShareResult.colony_name}</b> • Allowed Devices:{" "}
                    <b>{createdShareResult.max_devices}</b>
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-bold text-[#5C6470]">Shareable Client URL</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={`${window.location.origin}${createdShareResult.share_url}`}
                      className="flex-1 px-3 py-2.5 rounded-xl bg-white border border-[#DCD2BE] text-xs font-mono font-bold text-[#172A25] outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => handleCopyLink(createdShareResult.share_url, "created")}
                      className="px-4 py-2.5 rounded-xl bg-[#173F35] hover:bg-[#0F2922] text-white font-bold text-xs flex items-center gap-1.5 transition shrink-0"
                    >
                      {copiedId === "created" ? <Check size={14} /> : <Copy size={14} />}
                      {copiedId === "created" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>

                <div className="p-3.5 rounded-2xl bg-[#F3EFE6] border border-[#DCD2BE] text-xs space-y-2 text-[#5C6470]">
                  <span className="font-bold text-[#172A25] flex items-center gap-1.5">
                    <ShieldCheck size={14} className="text-[#173F35]" /> Strict Device Protection Active
                  </span>
                  <p className="text-[11px] leading-relaxed">
                    This link will open on exactly <b>{createdShareResult.max_devices} distinct devices</b>.
                    If a {createdShareResult.max_devices + 1}th device attempts access, the link will be
                    instantly killed and permanently expired for all devices.
                  </p>
                </div>

                <div className="flex gap-2 pt-2">
                  <a
                    href={`https://wa.me/?text=${encodeURIComponent(
                      `Hello! Here is the live masterplan layout for ${createdShareResult.colony_name}: ${window.location.origin}${createdShareResult.share_url}`
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center gap-2 transition"
                  >
                    <MessageCircle size={15} />
                    Share on WhatsApp
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreateOpen(false);
                      setCreatedShareResult(null);
                    }}
                    className="flex-1 py-2.5 rounded-xl bg-white border border-[#DCD2BE] hover:bg-[#F3EFE6] text-[#172A25] font-bold text-xs transition"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              /* Create Form */
              <form onSubmit={handleCreateShare} className="space-y-4 text-xs">
                {/* 1. Colony Select */}
                <div>
                  <label className="block text-[#5C6470] mb-1 font-bold">Target Colony</label>
                  <select
                    value={newColonyId}
                    onChange={(e) => setNewColonyId(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl bg-white border border-[#DCD2BE] text-[#172A25] font-bold outline-none"
                    required
                  >
                    {colonies.length === 0 ? (
                      <option value="">No colonies available for your account</option>
                    ) : (
                      colonies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} {c.location ? `(${c.location})` : ""}
                        </option>
                      ))
                    )}
                  </select>
                  {colonies.length === 0 && (
                    <p className="text-[10px] text-amber-600 font-semibold mt-1">
                      ⚠️ No colonies are currently assigned or owned by this account.
                    </p>
                  )}
                </div>

                {/* 2. Client / Recipient Label */}
                <div>
                  <label className="block text-[#5C6470] mb-1 font-bold">
                    Client / Prospect Name (For Audit & Identification)
                  </label>
                  <input
                    type="text"
                    value={newClientLabel}
                    onChange={(e) => setNewClientLabel(e.target.value)}
                    placeholder="e.g. Ramesh Patel (NRI Client), Dubai Investors Group"
                    className="w-full px-3 py-2.5 rounded-xl bg-white border border-[#DCD2BE] text-[#172A25] font-semibold outline-none focus:border-[#173F35]"
                    required
                  />
                </div>

                {/* 3. Max Allowed Devices */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[#5C6470] font-bold">Allowed Devices Limit</label>
                    <span className="font-mono text-[#173F35] font-black">{newMaxDevices} Devices</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2 mb-2">
                    {[1, 3, 5, 10].map((d) => (
                      <button
                        type="button"
                        key={d}
                        onClick={() => setNewMaxDevices(d)}
                        className={`py-1.5 rounded-xl font-bold border transition text-center ${
                          newMaxDevices === d
                            ? "bg-[#173F35] text-white border-[#173F35]"
                            : "bg-[#F3EFE6] text-[#5C6470] border-[#DCD2BE] hover:bg-[#EDE6D6]"
                        }`}
                      >
                        {d} {d === 1 ? "Device" : "Devices"}
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={newMaxDevices}
                    onChange={(e) => setNewMaxDevices(parseInt(e.target.value, 10) || 1)}
                    className="w-full px-3 py-2 rounded-xl bg-white border border-[#DCD2BE] text-[#172A25] font-mono font-bold outline-none"
                  />
                  <p className="text-[11px] text-[#5C6470] mt-1">
                    * The {newMaxDevices + 1}th device to open this link will immediately trigger global expiry.
                  </p>
                </div>

                {/* 4. Link Expiry */}
                <div>
                  <label className="block text-[#5C6470] mb-1.5 font-bold">Link Expiry Duration</label>
                  <div className="grid grid-cols-5 gap-1.5">
                    {[
                      { days: 1, label: "24h" },
                      { days: 3, label: "3 Days" },
                      { days: 7, label: "7 Days" },
                      { days: 30, label: "30 Days" },
                      { days: 0, label: "Never" },
                    ].map((item) => (
                      <button
                        type="button"
                        key={item.days}
                        onClick={() => setNewExpiryDays(item.days)}
                        className={`py-1.5 rounded-xl font-bold border transition text-center text-[11px] ${
                          newExpiryDays === item.days
                            ? "bg-[#173F35] text-white border-[#173F35]"
                            : "bg-[#F3EFE6] text-[#5C6470] border-[#DCD2BE] hover:bg-[#EDE6D6]"
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2 pt-3 border-t border-[#DCD2BE]">
                  <button
                    type="button"
                    onClick={() => setIsCreateOpen(false)}
                    className="flex-1 py-2.5 rounded-xl bg-[#F3EFE6] hover:bg-[#EDE6D6] text-[#172A25] font-bold text-xs border border-[#DCD2BE] transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creating}
                    className="flex-1 py-2.5 rounded-xl bg-[#173F35] hover:bg-[#0F2922] text-white font-extrabold text-xs shadow-md transition disabled:opacity-50"
                  >
                    {creating ? "Generating..." : "Generate Share Link"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL: DEVICE TELEMETRY AUDIT LOG
         ===================================================================== */}
      {telemetryModal && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-2xl rounded-3xl bg-[#FAF8F5] border border-[#DCD2BE] shadow-2xl p-6 text-[#172A25] flex flex-col gap-4 max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between pb-3 border-b border-[#DCD2BE]">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-[#173F35] text-white">
                  <Smartphone size={18} />
                </div>
                <div>
                  <h3 className="font-bold text-base text-[#172A25]">
                    Device Telemetry & Access Log
                  </h3>
                  <p className="text-xs text-[#5C6470]">
                    {telemetryModal.data?.share?.colony_name} • {telemetryModal.data?.share?.client_label}
                  </p>
                </div>
              </div>
              <button onClick={() => setTelemetryModal(null)} className="text-[#5C6470] hover:text-[#172A25]">
                <X size={18} />
              </button>
            </div>

            {telemetryModal.loading ? (
              <div className="p-8 text-center text-xs text-[#5C6470]">
                <RotateCw size={20} className="animate-spin mx-auto mb-2 text-[#173F35]" />
                Auditing device footprints...
              </div>
            ) : !telemetryModal.data || telemetryModal.data.devices.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#5C6470] bg-white rounded-2xl border border-[#DCD2BE]">
                <Smartphone size={24} className="mx-auto mb-2 text-[#5C6470]" />
                No devices have opened this link yet.
              </div>
            ) : (
              <div className="overflow-y-auto space-y-2.5 pr-1 calib-sidebar-scroll flex-1">
                {telemetryModal.data.devices.map((dev, idx) => {
                  const isBlocked = dev.status === "BLOCKED_BREACH_TRIGGER";

                  return (
                    <div
                      key={dev.id || idx}
                      className={`p-3.5 rounded-2xl border flex items-start justify-between gap-3 text-xs ${
                        isBlocked
                          ? "bg-rose-50 border-rose-300"
                          : "bg-white border-[#DCD2BE]"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={`p-2 rounded-xl mt-0.5 ${
                            isBlocked
                              ? "bg-rose-200 text-rose-700"
                              : "bg-[#F3EFE6] text-[#173F35]"
                          }`}
                        >
                          {dev.device_type === "Mobile" ? (
                            <Smartphone size={16} />
                          ) : dev.device_type === "Tablet" ? (
                            <Tablet size={16} />
                          ) : (
                            <Laptop size={16} />
                          )}
                        </div>

                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-[#172A25]">{dev.device_name}</span>
                            {isBlocked ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-600 text-white">
                                Breach Trigger (Blocked)
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                                Device #{idx + 1} Authorized
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-[#5C6470] flex items-center gap-3">
                            <span>IP: <b className="font-mono">{dev.ip_address}</b></span>
                            <span>Screen: <b className="font-mono">{dev.screen_resolution}</b></span>
                            <span>Views: <b className="font-mono">{dev.total_views}</b></span>
                          </div>
                          <div className="text-[10px] text-[#5C6470]">
                            First Seen: {dev.first_opened_at ? new Date(dev.first_opened_at).toLocaleString() : "N/A"}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="pt-2 border-t border-[#DCD2BE] flex justify-end">
              <button
                type="button"
                onClick={() => setTelemetryModal(null)}
                className="px-4 py-2 rounded-xl bg-[#173F35] text-white font-bold text-xs"
              >
                Close Audit Log
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
