import React, { useState, useEffect, useRef } from "react";
import { api, errMsg } from "../lib/api";
import { inspectGeoJsonPlotFile } from "../lib/geoImport";
import { Building2, MapPin, Plus, User, Eye, Edit3, Globe, Shield, Upload, FileText, CheckCircle2, AlertCircle, X, Trash2, Terminal, ChevronDown, ChevronUp } from "lucide-react";

const MAPPING_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export default function OwnerColonies() {
  const [colonies, setColonies] = useState(() => {
    try {
      const cached = localStorage.getItem("livemap_cached_owner_colonies") || sessionStorage.getItem("livemap_cached_owner_colonies");
      return cached ? JSON.parse(cached) : [];
    } catch (_) {
      return [];
    }
  });
  const [admins, setAdmins] = useState(() => {
    try {
      const cached = localStorage.getItem("livemap_cached_owner_admins") || sessionStorage.getItem("livemap_cached_owner_admins");
      return cached ? JSON.parse(cached) : [];
    } catch (_) {
      return [];
    }
  });
  const [loading, setLoading] = useState(() => {
    try {
      const cached = localStorage.getItem("livemap_cached_owner_colonies") || sessionStorage.getItem("livemap_cached_owner_colonies");
      return !cached;
    } catch (_) {
      return false;
    }
  });
  const [error, setError] = useState(null);
  const [createdImport, setCreatedImport] = useState(null);
  const [showDebugTerminal, setShowDebugTerminal] = useState(true);
  const [formError, setFormError] = useState("");

  // Modal states
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingColony, setEditingColony] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [previewingId, setPreviewingId] = useState(null);

  // Delete state
  const [deletingColony, setDeletingColony] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Form State
  const [formData, setFormData] = useState({
    name: "",
    colony_id: "",
    location: "",
    description: "",
    partner_admin_id: "",
    is_public: false,
  });
  const [companionType, setCompanionType] = useState("kml");
  const [geojsonFile, setGeojsonFile] = useState(null);
  const layoutPdfRef = useRef(null);
  const [layoutPdf, setLayoutPdf] = useState(null);
  const [companionFile, setCompanionFile] = useState(null);
  const selectedSourceFiles = [geojsonFile, layoutPdf, companionFile].filter(Boolean).length;
  const [geojsonReview, setGeojsonReview] = useState("");
  const geojsonReviewRequest = useRef(0);

  const reviewGeojsonFile = async (file) => {
    setGeojsonFile(file);
    setFormError("");
    const request = ++geojsonReviewRequest.current;
    if (!file) {
      setGeojsonReview("");
      return;
    }
    setGeojsonReview("Checking GeoJSON plot geometry...");
    const result = await inspectGeoJsonPlotFile(file);
    if (request !== geojsonReviewRequest.current) return;
    if (result.error) {
      setGeojsonReview(result.error);
    } else if (result.polygonCount === 0) {
      setGeojsonReview(result.boundaryCount
        ? `Found ${result.boundaryCount} explicit land boundary and ${result.numberedPointCount} numbered points, but no plot polygons. The PDF is used to recover and verify plot parcels from its vector boundaries.`
        : `This file has ${result.numberedPointCount} numbered plot points, 0 plot polygons, and no explicit land boundary. Add a tagged land boundary so the PDF-derived parcels can be placed.`);
    } else {
      setGeojsonReview(`Found ${result.polygonCount} polygon features for mapping${result.numberedPointCount ? ` and ${result.numberedPointCount} numbered points` : ""}. Server will verify plot numbers and geometry on save.`);
    }
  };

  const fetchColonies = async (silent = false) => {
    try {
      if (!silent && colonies.length === 0) setLoading(true);
      const res = await api.get("/owner/colonies");
      const list = res.data.colonies || [];
      setColonies(list);
      try {
        localStorage.setItem("livemap_cached_owner_colonies", JSON.stringify(list));
        sessionStorage.setItem("livemap_cached_owner_colonies", JSON.stringify(list));
      } catch (_) {}
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  const fetchAdmins = async () => {
    try {
      const res = await api.get("/owner/admins");
      const list = res.data.admins || [];
      setAdmins(list);
      try {
        localStorage.setItem("livemap_cached_owner_admins", JSON.stringify(list));
        sessionStorage.setItem("livemap_cached_owner_admins", JSON.stringify(list));
      } catch (_) {}
    } catch (err) {
      console.error("Failed to fetch admins for partner selection", err);
    }
  };

  useEffect(() => {
    const hasCache = colonies.length > 0;
    fetchColonies(hasCache);
    fetchAdmins();
  }, []);

  const resetForm = () => {
    setFormError("");
    setFormData({
      name: "",
      colony_id: "",
      location: "",
      description: "",
      partner_admin_id: "",
      is_public: false
    });
    setCompanionType("kml");
    geojsonReviewRequest.current += 1;
    setGeojsonFile(null);
    setGeojsonReview("");
    setLayoutPdf(null);
    setCompanionFile(null);
    setEditingColony(null);
  };

  const handleOpenAddModal = () => {
    resetForm();
    setShowAddModal(true);
  };

  const handleOpenEditModal = (colony) => {
    setFormError("");
    setEditingColony(colony);
    const companionName = colony.source_files?.companion || "";
    setFormData({
      name: colony.name || "",
      colony_id: colony.colony_id || "",
      location: colony.location || "",
      description: colony.description || "",
      partner_admin_id: colony.partner_admin_id || "",
      is_public: colony.is_public !== false
    });
    setCompanionType(companionName.toLowerCase().endsWith(".dwg") ? "dwg" : "kml");
    geojsonReviewRequest.current += 1;
    setGeojsonFile(null);
    setGeojsonReview("");
    setLayoutPdf(null);
    setCompanionFile(null);
    setShowAddModal(true);
  };

  const handlePreview = async (colony) => {
    try {
      setPreviewingId(colony._id);
      const res = await api.post(`/admin/colonies/${colony._id}/preview-session`);
      const { previewToken } = res.data;
      window.open(`/preview/${previewToken}`, "_blank");
    } catch (err) {
      alert(`Preview failed: ${errMsg(err)}`);
    } finally {
      setPreviewingId(null);
    }
  };

  const handleToggleVisibility = async (colony) => {
    try {
      const nextState = !(colony.is_public !== false);
      await api.patch(`/admin/colonies/${colony._id}`, { is_public: nextState });
      fetchColonies();
    } catch (err) {
      alert(`Failed to update visibility: ${errMsg(err)}`);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingColony) return;
    try {
      setIsDeleting(true);
      setDeleteError("");
      await api.delete(`/admin/colonies/${deletingColony._id}`);
      setDeletingColony(null);
      fetchColonies();
    } catch (err) {
      setDeleteError(errMsg(err));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSubmitForm = async (e) => {
    e.preventDefault();
    setFormError("");
    if (!editingColony && selectedSourceFiles === 0) {
      setFormError("Upload at least one mapping file (GeoJSON, PDF layout, or KML/DWG companion).");
      return;
    }
    if (geojsonFile) {
      const review = await inspectGeoJsonPlotFile(geojsonFile);
      const boundaryOnly = review.polygonCount === 0;
      const companionIsKmlOrDwg = companionFile?.name.toLowerCase().endsWith(".kml") || companionFile?.name.toLowerCase().endsWith(".dwg") || review.isKml;
      const hasPdfLayout = Boolean(layoutPdf);
      if (review.error || (!hasPdfLayout && boundaryOnly && (!editingColony || (!review.boundaryCount && !companionIsKmlOrDwg)))) {
        const message = review.error || (!editingColony
          ? "Creating a colony requires a KML land boundary file plus a PDF layout drawing."
          : "A boundary-only update requires a KML land boundary.");
        setGeojsonReview(message);
        setFormError(`${message} No colony data has been changed.`);
        return;
      }
    }
    setSubmitting(true);
    try {
      if (editingColony) {
        const body = new FormData();
        body.append("name", formData.name);
        body.append("location", formData.location);
        body.append("description", formData.description);
        body.append("partner_admin_id", formData.partner_admin_id || "");
        body.append("is_public", formData.is_public);
        if (selectedSourceFiles > 0) {
          if (geojsonFile) body.append("file", geojsonFile);
          if (layoutPdf) body.append("layout_pdf", layoutPdf);
          if (companionFile) body.append("cad_file", companionFile);
        }
        const response = await api.patch(`/admin/colonies/${editingColony._id}`, body, {
          headers: selectedSourceFiles > 0 ? { "Content-Type": "multipart/form-data" } : undefined,
          timeout: selectedSourceFiles > 0 ? MAPPING_UPLOAD_TIMEOUT_MS : undefined,
        });
        if (response.data.import_summary) {
          setCreatedImport({ name: response.data.name, summary: response.data.import_summary, action: "updated" });
        }
      } else {
        // Create new colony
        const body = new FormData();
        body.append("name", formData.name);
        body.append("colony_id", formData.colony_id || formData.name.toLowerCase().replace(/\s+/g, "-"));
        body.append("location", formData.location);
        body.append("description", formData.description);
        body.append("is_public", formData.is_public);
        if (formData.partner_admin_id) {
          body.append("partner_admin_id", formData.partner_admin_id);
        }
        if (geojsonFile) body.append("file", geojsonFile);
        if (layoutPdf) body.append("layout_pdf", layoutPdf);
        if (companionFile) body.append("cad_file", companionFile);

        const response = await api.post("/admin/colonies", body, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: MAPPING_UPLOAD_TIMEOUT_MS,
        });
        setCreatedImport({ name: response.data.name, summary: response.data.import_summary, action: "created" });
      }

      setShowAddModal(false);
      resetForm();
      fetchColonies();
    } catch (err) {
      const action = editingColony ? "Update failed" : "Create failed";
      const timedOut = err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT";
      const outcome = timedOut
        ? "The server may still be processing this upload. Check the colony before retrying."
        : editingColony
          ? "The existing colony map and plot data have not been changed."
          : "No new colony was created.";
      setFormError(`${action}: ${errMsg(err)} ${outcome}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold font-serif tracking-tight">All Platform Colonies</h1>
          <p className="text-sm opacity-70">Platform-wide overview of colonies managed across all administrators</p>
        </div>
        <button
          onClick={handleOpenAddModal}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-medium text-sm transition shadow-sm"
        >
          <Plus size={16} /> Add Colony
        </button>
      </div>

      {createdImport && (
        <div className="neo-card p-4 border-l-4 border-emerald-500 space-y-3" role="status" data-testid="colony-import-summary">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <p className="text-sm font-semibold flex items-center gap-2">
              <CheckCircle2 size={18} className="text-emerald-500 flex-shrink-0" />
              <span>
                {createdImport.name} {createdImport.action || "created"} with {createdImport.summary?.plots ?? 0}{" "}
                {createdImport.summary?.mode === "pdf_overlay_only" ? "PDF plot labels detected" : "plots"}.
              </span>
            </p>
            {createdImport.summary?.debug_log && (
              <button
                type="button"
                onClick={() => setShowDebugTerminal(!showDebugTerminal)}
                className="flex items-center gap-1.5 px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono transition shadow-sm self-start sm:self-auto"
              >
                <Terminal size={14} className="text-emerald-400" />
                <span>{showDebugTerminal ? "Hide Pipeline Terminal" : "View Pipeline Terminal Log"}</span>
                {showDebugTerminal ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            )}
          </div>

          {createdImport.summary?.mode === "pdf_overlay_only" && (
            <p className="text-xs text-amber-600 dark:text-amber-300">
              These labels are counted from the PDF image; individual plot records and geographic locations are not available in overlay-only mode.
            </p>
          )}

          {createdImport.summary?.warnings?.length > 0 && (
            <ul className="list-disc list-inside text-xs text-amber-600 dark:text-amber-300">
              {createdImport.summary.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
            </ul>
          )}

          {/* Interactive Pipeline Debug Terminal Window */}
          {createdImport.summary?.debug_log && showDebugTerminal && (
            <div className="mt-3 rounded-lg overflow-hidden border border-slate-800 bg-[#0d1117] shadow-2xl">
              <div className="bg-[#161b22] px-3.5 py-2 flex items-center justify-between border-b border-slate-800 text-xs text-slate-400 font-mono">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500/80 inline-block" />
                  <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/80 inline-block" />
                  <span className="w-2.5 h-2.5 rounded-full bg-green-500/80 inline-block" />
                  <span className="ml-2 text-slate-300 font-semibold flex items-center gap-1.5">
                    <Terminal size={13} className="text-emerald-400" /> AI Intake &amp; GIS Pipeline Execution Log
                  </span>
                </div>
                <span className="text-[11px] text-emerald-400 font-medium px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30">
                  STEP-BY-STEP COMPLETE
                </span>
              </div>
              <pre className="p-3.5 text-xs font-mono text-emerald-300/95 whitespace-pre-wrap overflow-x-auto max-h-80 select-text leading-relaxed bg-[#0d1117]">
                {createdImport.summary.debug_log}
              </pre>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 animate-pulse">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="neo-card p-6 space-y-4 border border-violet-500/10">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <div className="h-5 w-36 bg-slate-700/50 rounded" />
                  <div className="h-3 w-24 bg-slate-800 rounded" />
                </div>
                <div className="h-5 w-20 bg-slate-800 rounded-full" />
              </div>
              <div className="h-10 bg-slate-800/40 rounded-lg" />
              <div className="grid grid-cols-5 gap-2 pt-2">
                {[1, 2, 3, 4, 5].map((j) => (
                  <div key={j} className="h-12 bg-slate-800/60 rounded" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="neo-card p-6 border-l-4 border-red-500 text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : colonies.length === 0 ? (
        <div className="neo-card p-12 text-center text-sm opacity-60">
          No colonies created on the platform yet. Click "+ Add Colony" to create one.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {colonies.map((colony) => {
            const stats = colony.metrics || {};
            const pdfDetectedPlots =
              stats.pdfDetectedPlots ??
              colony.stats?.pdf_detected_plots ??
              colony.pdf_overlay?.plot_count;
            const isPublic = colony.is_public !== false;
            return (
              <div key={colony._id} className="neo-card p-6 space-y-4 hover:border-violet-500/30 transition-all flex flex-col justify-between">
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-lg font-serif">{colony.name || colony.colony_id}</h3>
                      <p className="text-xs opacity-60 flex items-center gap-1 mt-0.5">
                        <MapPin size={12} /> {colony.location || "Location not specified"}
                      </p>
                    </div>
                    <button
                      onClick={() => handleToggleVisibility(colony)}
                      title="Click to toggle homepage visibility"
                      className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border flex items-center gap-1 transition ${
                        isPublic
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20"
                          : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 hover:bg-amber-500/20"
                      }`}
                    >
                      <Globe size={10} />
                      {isPublic ? "Homepage: ON" : "Homepage: OFF"}
                    </button>
                  </div>

                  {/* Owner & Partner Governance */}
                  <div className="space-y-1.5 p-2.5 rounded-lg bg-violet-500/5 text-xs border border-violet-500/10">
                    <div className="flex items-center gap-2">
                      <Shield size={13} className="text-violet-500" />
                      <span className="opacity-70">Owner:</span>
                      <span className="font-semibold">{colony.adminName || colony.adminEmail || "Super Admin"}</span>
                    </div>
                    {colony.partnerAdminName && (
                      <div className="flex items-center gap-2 pt-1 border-t border-violet-500/10">
                        <User size={13} className="text-amber-500" />
                        <span className="opacity-70">Partner Admin:</span>
                        <span className="font-semibold text-amber-600 dark:text-amber-400">{colony.partnerAdminName}</span>
                      </div>
                    )}
                  </div>

                  {/* Plot breakdown grid */}
                  <div className="grid grid-cols-5 gap-2 text-center pt-2 border-t border-gray-200 dark:border-gray-800">
                    <div className="p-2 neo-inset rounded-lg">
                      <div className="text-[10px] opacity-60 font-semibold uppercase">Avail</div>
                      <div className="text-sm font-bold font-mono text-emerald-600 dark:text-emerald-400">
                        {stats.available || 0}
                      </div>
                    </div>
                    <div className="p-2 neo-inset rounded-lg">
                      <div className="text-[10px] opacity-60 font-semibold uppercase">Booked</div>
                      <div className="text-sm font-bold font-mono text-amber-600 dark:text-amber-400">
                        {stats.reserved || 0}
                      </div>
                    </div>
                    <div className="p-2 neo-inset rounded-lg">
                      <div className="text-[10px] opacity-60 font-semibold uppercase">Hold</div>
                      <div className="text-sm font-bold font-mono text-purple-600 dark:text-purple-400">
                        {stats.hold || 0}
                      </div>
                    </div>
                    <div className="p-2 neo-inset rounded-lg">
                      <div className="text-[10px] opacity-60 font-semibold uppercase">Sold</div>
                      <div className="text-sm font-bold font-mono text-blue-600 dark:text-blue-400">
                        {stats.sold || 0}
                      </div>
                    </div>
                    <div className="p-2 neo-inset rounded-lg">
                      <div className="text-[10px] opacity-60 font-semibold uppercase">Block</div>
                      <div className="text-sm font-bold font-mono text-red-600 dark:text-red-400">
                        {stats.blocked || 0}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs pt-2 text-opacity-70">
                    <span>Total Inventory: <strong className="font-mono">{stats.totalPlots || 0} plots</strong></span>
                    <span>Inquiries: <strong className="font-mono">{stats.inquiries || 0}</strong></span>
                  </div>
                  {pdfDetectedPlots != null && (
                    <div className="text-xs text-amber-600 dark:text-amber-300">
                      PDF plot labels detected: <strong className="font-mono">{pdfDetectedPlots}</strong> (not interactive inventory)
                    </div>
                  )}
                </div>

                {/* Card Actions */}
                <div className="pt-3 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between gap-2">
                  <button
                    onClick={() => handlePreview(colony)}
                    disabled={previewingId === colony._id}
                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md bg-violet-600/10 hover:bg-violet-600/20 text-violet-600 dark:text-violet-300 font-medium text-xs transition"
                  >
                    <Eye size={14} />
                    {previewingId === colony._id ? "Opening..." : "Preview"}
                  </button>
                  <button
                    onClick={() => handleOpenEditModal(colony)}
                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md bg-gray-500/10 hover:bg-gray-500/20 text-gray-700 dark:text-gray-300 font-medium text-xs transition"
                  >
                    <Edit3 size={14} />
                    Edit
                  </button>
                  <a
                    href={`/superadmin/colonies/${colony._id}`}
                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 font-medium text-xs transition"
                    title="Open the colony map and manage its layers and plots."
                  >
                    Manage
                  </a>
                  <button
                    onClick={() => { setDeletingColony(colony); setDeleteError(""); }}
                    className="flex-none flex items-center justify-center gap-1 py-1.5 px-2.5 rounded-md bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 font-medium text-xs transition"
                    title="Delete Colony"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit Colony Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto space-y-5 text-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-xl font-bold font-serif">{editingColony ? "Edit Colony" : "Create New Colony"}</h2>
                <p className="text-xs text-slate-400">Configure colony settings, governance, and GIS sources</p>
              </div>
              <button onClick={() => setShowAddModal(false)} className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmitForm} className="space-y-4 text-sm">
              {/* SECTION A: Basic Info */}
              <div className="space-y-3">
                <h4 className="text-xs uppercase font-bold tracking-wider text-violet-400">Basic Information</h4>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Colony Name *</label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g. Durga Enclave Phase 2"
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm focus:outline-none focus:border-violet-500"
                  />
                </div>
                {!editingColony && (
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Colony Identifier Slug</label>
                    <input
                      type="text"
                      value={formData.colony_id}
                      onChange={(e) => setFormData({ ...formData, colony_id: e.target.value })}
                      placeholder="durga-enclave-phase-2 (auto-generated if empty)"
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm focus:outline-none focus:border-violet-500 font-mono"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Location / Address</label>
                  <input
                    type="text"
                    value={formData.location}
                    onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                    placeholder="e.g. Sector 14, City Center"
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm focus:outline-none focus:border-violet-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Description</label>
                  <textarea
                    rows={2}
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Brief property overview..."
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm focus:outline-none focus:border-violet-500"
                  />
                </div>
              </div>

              {/* SECTION B: Ownership & Partnership */}
              <div className="space-y-3 pt-2 border-t border-slate-800">
                <h4 className="text-xs uppercase font-bold tracking-wider text-violet-400">Ownership & Partnership</h4>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Partner Admin (Optional)</label>
                  <select
                    value={formData.partner_admin_id}
                    onChange={(e) => setFormData({ ...formData, partner_admin_id: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm focus:outline-none focus:border-violet-500"
                  >
                    <option value="">None (Super Admin Only Property)</option>
                    {admins.map((adm) => (
                      <option key={adm._id} value={adm._id}>
                        {adm.name} ({adm.email})
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Partner Admin receives management access while Super Admin retains platform governance.
                  </p>
                </div>
              </div>

              {/* SECTION C: Public Visibility */}
              <div className="space-y-3 pt-2 border-t border-slate-800">
                <h4 className="text-xs uppercase font-bold tracking-wider text-violet-400">Public Homepage Visibility</h4>
                <label className="flex items-center gap-3 p-3 bg-slate-800/60 rounded-lg border border-slate-700/60 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.is_public}
                    onChange={(e) => setFormData({ ...formData, is_public: e.target.checked })}
                    className="w-4 h-4 rounded text-violet-600 focus:ring-violet-500 bg-slate-900 border-slate-700"
                  />
                  <div>
                    <span className="font-semibold text-xs block">Show on Public Homepage</span>
                    <span className="text-[11px] text-slate-400 block">
                      Allows visitors to discover this colony on the platform landing page.
                    </span>
                  </div>
                </label>
              </div>

              {/* SECTION D: GIS source files */}
              <div className="space-y-3 pt-2 border-t border-slate-800">
                  <h4 className="text-xs uppercase font-bold tracking-wider text-violet-400">{editingColony ? "Replace mapping source files (KML + PDF/DWG/DWF)" : "Upload mapping sources (KML + PDF/DWG/DWF)"}</h4>
                  {editingColony ? (
                    <p className="text-[11px] text-amber-300">Upload KML file (boundary / GIS geometry) and/or layout drawing file (.pdf, .dwg, .dwf, .dxf) to update the live map layout.</p>
                  ) : (
                    <p className="text-[11px] text-slate-400">Upload KML file (site boundary polygon) and layout file (.pdf, .dwg, .dwf, .dxf) to create the colony map.</p>
                  )}
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">1 · KML File (.kml)</label>
                    <input
                      type="file"
                      accept=".kml,application/vnd.google-earth.kml+xml,.geojson,.json"
                      onChange={(e) => setGeojsonFile(e.target.files?.[0] || null)}
                      className="w-full text-xs text-slate-400 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-violet-600 file:text-white hover:file:bg-violet-700 cursor-pointer"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">2 · Layout Drawing (.pdf, .dwg, .dwf, .dxf)</label>
                    <input
                      type="file"
                      accept=".pdf,.dwg,.dxf,.dwf,application/pdf"
                      onChange={(e) => setLayoutPdf(e.target.files?.[0] || null)}
                      className="w-full text-xs text-slate-400 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-violet-600 file:text-white hover:file:bg-violet-700 cursor-pointer"
                    />
                  </div>
              </div>

              {/* Modal Actions */}
              <div className="pt-4 border-t border-slate-800 flex items-center justify-end gap-3">
                {formError && <p className="mr-auto text-xs text-red-300" role="alert">{formError}</p>}
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-xs transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium text-xs transition disabled:opacity-50"
                >
                  {submitting ? "Saving..." : editingColony ? "Save Changes" : "Create Colony"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingColony && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 max-w-md w-full space-y-4 text-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-red-400">
                <AlertCircle size={20} />
                <h3 className="text-lg font-bold">Delete Colony</h3>
              </div>
              <button
                onClick={() => setDeletingColony(null)}
                className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400"
              >
                <X size={16} />
              </button>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">
              Are you sure you want to permanently delete <strong className="text-white">{deletingColony.name || deletingColony.colony_id}</strong>?
            </p>
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400 space-y-1">
              <p className="font-semibold">⚠️ Warning: Critical Data Removal</p>
              <p>This action will permanently delete all associated plots, zones, registry entries, and GIS files. This operation cannot be undone.</p>
            </div>
            {deleteError && (
              <p className="text-xs text-red-400 bg-red-900/30 p-2 rounded border border-red-800" role="alert">
                {deleteError}
              </p>
            )}
            <div className="pt-2 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeletingColony(null)}
                disabled={isDeleting}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-xs transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-medium text-xs transition disabled:opacity-50 flex items-center gap-1.5"
              >
                <Trash2 size={14} />
                {isDeleting ? "Deleting..." : "Permanently Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
