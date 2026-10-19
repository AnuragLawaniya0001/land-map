import React, { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, errMsg } from "../lib/api";
import { inspectGeoJsonPlotFile } from "../lib/geoImport";
import { Building2, MapPin, Plus, User, Eye, Edit3, Globe, Shield, Upload, FileText, CheckCircle2, AlertCircle, X, Trash2, Terminal, ChevronDown, ChevronUp, Loader2 } from "lucide-react";

const MAPPING_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export default function OwnerColonies({ user }) {
  const isSuper = user?.role === "super_admin";
  const base = isSuper ? "/superadmin" : "/admin";
  const cacheKey = isSuper ? "livemap_cached_owner_colonies" : "livemap_cached_admin_colonies";
  const [colonies, setColonies] = useState(() => {
    try {
      const cached = localStorage.getItem(cacheKey) || sessionStorage.getItem(cacheKey);
      return cached ? JSON.parse(cached) : [];
    } catch (_) {
      return [];
    }
  });
  const [admins, setAdmins] = useState(() => {
    if (!isSuper) return [];
    try {
      const cached = localStorage.getItem("livemap_cached_owner_admins") || sessionStorage.getItem("livemap_cached_owner_admins");
      return cached ? JSON.parse(cached) : [];
    } catch (_) {
      return [];
    }
  });
  const [loading, setLoading] = useState(() => {
    try {
      const cached = localStorage.getItem(cacheKey) || sessionStorage.getItem(cacheKey);
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
      const res = await api.get(isSuper ? "/owner/colonies" : "/admin/colonies");
      const list = Array.isArray(res.data) ? res.data : (res.data.colonies || []);
      const normalized = list.map((c) => ({
        ...c,
        _id: c._id || c.id,
        id: c.id || c._id,
      }));
      setColonies(normalized);
      try {
        localStorage.setItem(cacheKey, JSON.stringify(normalized));
        sessionStorage.setItem(cacheKey, JSON.stringify(normalized));
      } catch (_) {}
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  const fetchAdmins = async () => {
    if (!isSuper) return;
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
    fetchColonies(false);
    if (isSuper) fetchAdmins();
  }, [isSuper]);

  // Real-time auto-polling when any colony is actively running/queued in the AI GIS pipeline
  useEffect(() => {
    const hasActiveProcessing = colonies.some(
      (c) =>
        c.processing_status === "running" ||
        c.processing_status === "queued" ||
        c.processing_status === "processing"
    );
    if (!hasActiveProcessing) return;

    const interval = setInterval(() => {
      fetchColonies(true);
    }, 2000);

    return () => clearInterval(interval);
  }, [colonies]);

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
      setFormError("Upload at least one mapping file (KML boundary file or PDF/DXF layout drawing).");
      return;
    }
    if (geojsonFile) {
      const ext = geojsonFile.name.toLowerCase().slice(geojsonFile.name.lastIndexOf("."));
      if (ext !== ".kml") {
        setFormError("Only .kml files are allowed for boundary. Please select a valid KML file.");
        return;
      }
    }
    if (layoutPdf) {
      const ext = layoutPdf.name.toLowerCase().slice(layoutPdf.name.lastIndexOf("."));
      if (ext !== ".pdf" && ext !== ".dxf") {
        setFormError("Only .pdf and .dxf files are allowed for layout drawing.");
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
        if (isSuper) {
          body.append("partner_admin_id", formData.partner_admin_id || "");
        }
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
        if (isSuper && formData.partner_admin_id) {
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
    <div className="lm-page-container" data-testid={`${isSuper ? "owner" : "admin"}-colonies-page`}>
      <header className="lm-modern-header">
        <div className="lm-modern-header-left">
          <span className="lm-modern-eyebrow">{isSuper ? "Colony Oversight" : "Developer Workspace"}</span>
          <h1 className="lm-modern-title">{isSuper ? "All Platform Colonies" : "My Colonies"}</h1>
          <p className="lm-modern-subtitle">
            {isSuper
              ? "Platform-wide overview of colonies managed across all administrators and developers."
              : "Overview and masterplan controls for your assigned colonies and plot inventory."}
          </p>
        </div>
        <div className="lm-modern-header-actions">
          <button
            onClick={handleOpenAddModal}
            className="lm-btn-glow"
            data-testid="owner-add-colony-btn"
          >
            <Plus size={16} /> Add Colony
          </button>
        </div>
      </header>

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
            <div key={i} className="bg-white rounded-2xl border border-[#E8E2D6] overflow-hidden shadow-sm">
              <div className="h-32 bg-[#173F35]/20" />
              <div className="p-5 space-y-4">
                <div className="h-9 bg-[#F6F4EE] rounded-xl" />
                <div className="grid grid-cols-5 gap-2">
                  {[1, 2, 3, 4, 5].map((j) => (
                    <div key={j} className="h-12 bg-[#F6F4EE] rounded-xl" />
                  ))}
                </div>
                <div className="h-8 bg-[#F6F4EE] rounded-xl" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="bg-white rounded-2xl border border-[#E8E2D6] border-l-4 border-l-rose-500 p-6 text-rose-700 shadow-sm">
          {error}
        </div>
      ) : colonies.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#E8E2D6] p-12 text-center text-sm text-[#6B7280] shadow-sm">
          {isSuper
            ? "No colonies created on the platform yet. Click '+ Add Colony' to create one."
            : "No colonies assigned to your account yet. Click '+ Add Colony' to add your colony."}
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
            const isProcessing =
              colony.processing_status === "running" ||
              colony.processing_status === "queued";
            const progress =
              typeof colony.processing_progress === "number"
                ? colony.processing_progress
                : 10;
            const stageText =
              colony.processing_stage || "Processing layout files...";

            const totalPlots = stats.totalPlots || 0;
            const availPlots = stats.available || 0;
            const soldPlots = stats.sold || 0;
            const availPct = totalPlots > 0 ? Math.round((availPlots / totalPlots) * 100) : 0;

            return (
              <div
                key={colony._id}
                className={`bg-white rounded-2xl border border-[#E8E2D6] shadow-sm hover:shadow-xl hover:border-[#173F35] transition-all duration-300 flex flex-col justify-between overflow-hidden group ${
                  isProcessing
                    ? "border-amber-500/50 shadow-xl shadow-amber-500/10 ring-1 ring-amber-500/30"
                    : ""
                }`}
              >
                {/* Theme Green Art Banner with Contours */}
                <div
                  className="relative px-5 py-4 text-white flex flex-col justify-between overflow-hidden min-h-[125px]"
                  style={{ background: "linear-gradient(135deg, #173F35 0%, #0D1B2A 100%)" }}
                >
                  <div className="lm-contour" />

                  {/* Top Row: Visibility Badge + Plots count */}
                  <div className="flex items-center justify-between gap-2 relative z-10">
                    <button
                      onClick={() => handleToggleVisibility(colony)}
                      title="Click to toggle homepage visibility"
                      className={`text-[10px] uppercase font-bold tracking-wider px-2.5 py-1 rounded-full border flex items-center gap-1.5 transition-all ${
                        isPublic
                          ? "bg-emerald-500/20 text-emerald-300 border-emerald-400/40 hover:bg-emerald-500/30 backdrop-blur-sm"
                          : "bg-amber-500/20 text-amber-300 border-amber-400/40 hover:bg-amber-500/30 backdrop-blur-sm"
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${isPublic ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
                      {isPublic ? "Live: Public" : "Draft: Private"}
                    </button>

                    <span className="text-[11px] font-mono text-emerald-200 font-semibold bg-black/25 backdrop-blur-sm px-2.5 py-0.5 rounded-full border border-white/10">
                      {totalPlots} Plots
                    </span>
                  </div>

                  {/* Colony Name and Location Pin */}
                  <div className="relative z-10 mt-3">
                    <h3 className="font-bold text-lg text-white tracking-tight leading-snug group-hover:text-emerald-200 transition-colors">
                      {colony.name || colony.colony_id}
                    </h3>
                    <p className="text-xs text-emerald-100/80 flex items-center gap-1.5 mt-1 font-mono">
                      <MapPin size={12} className="text-emerald-300 shrink-0" />
                      <span className="truncate">{colony.location || "Location not specified"}</span>
                    </p>
                  </div>
                </div>

                {/* Card Content Body */}
                <div className="p-5 space-y-4 flex-1 flex flex-col justify-between">
                  <div className="space-y-4">
                    {isProcessing ? (
                      /* Clean processing HUD */
                      <div className="py-7 px-4 rounded-2xl bg-amber-50/70 border border-amber-200/80 flex flex-col items-center justify-center text-center space-y-3.5 relative overflow-hidden my-auto min-h-[195px]">
                        <div className="relative">
                          <div className="w-12 h-12 rounded-xl bg-amber-100 border border-amber-300 flex items-center justify-center shadow-sm">
                            <Loader2 size={24} className="animate-spin text-amber-600" />
                          </div>
                          <span className="absolute -top-1 -right-1 w-3 h-3 bg-amber-500 rounded-full animate-ping" />
                          <span className="absolute -top-1 -right-1 w-3 h-3 bg-amber-600 rounded-full" />
                        </div>

                        <div className="space-y-1.5 z-10 max-w-[90%]">
                          <div className="flex items-center justify-center gap-2">
                            <span className="text-xs font-bold uppercase tracking-wider text-amber-900 font-mono">
                              AI GIS Pipeline
                            </span>
                            <span className="font-mono text-xs font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded border border-amber-300">
                              {progress}%
                            </span>
                          </div>
                          <p className="text-[11px] text-amber-900/80 truncate max-w-full font-medium">
                            {stageText}
                          </p>
                        </div>

                        <div className="w-full max-w-[220px] h-2 bg-amber-100 rounded-full overflow-hidden border border-amber-200 z-10">
                          <div
                            className="h-full bg-gradient-to-r from-amber-500 to-emerald-600 transition-all duration-500 rounded-full"
                            style={{ width: `${Math.max(progress, 10)}%` }}
                          />
                        </div>

                        <span className="text-[10px] text-amber-700 font-mono tracking-wider uppercase z-10">
                          Plots will load automatically
                        </span>
                      </div>
                    ) : (
                      <>
                        {/* Owner & Partner Governance Chip */}
                        <div className="p-2.5 rounded-xl bg-[#F6F4EE] border border-[#E8E2D6] flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2">
                            <Shield size={13} className="text-[#173F35]" />
                            <span className="text-[#6B7280]">Owner:</span>
                            <span className="font-semibold text-[#172A25]">{colony.adminName || colony.adminEmail || "Super Admin"}</span>
                          </div>
                          {colony.partnerAdminName && (
                            <div className="flex items-center gap-1.5 text-[#6B7280]">
                              <User size={12} className="text-amber-600" />
                              <span className="text-amber-700 font-medium">{colony.partnerAdminName}</span>
                            </div>
                          )}
                        </div>

                        {/* Modern 5-Pill Inventory Telemetry */}
                        <div className="grid grid-cols-5 gap-1.5 text-center">
                          <div className="p-2 rounded-xl bg-[#F6F4EE] border border-[#E8E2D6]">
                            <div className="text-[9px] text-[#6B7280] font-semibold uppercase">Avail</div>
                            <div className="text-sm font-bold font-mono text-emerald-700 mt-0.5">
                              {stats.available || 0}
                            </div>
                          </div>
                          <div className="p-2 rounded-xl bg-[#F6F4EE] border border-[#E8E2D6]">
                            <div className="text-[9px] text-[#6B7280] font-semibold uppercase">Hold</div>
                            <div className="text-sm font-bold font-mono text-purple-700 mt-0.5">
                              {stats.hold || 0}
                            </div>
                          </div>
                          <div className="p-2 rounded-xl bg-[#F6F4EE] border border-[#E8E2D6]">
                            <div className="text-[9px] text-[#6B7280] font-semibold uppercase">Booked</div>
                            <div className="text-sm font-bold font-mono text-amber-700 mt-0.5">
                              {stats.reserved || 0}
                            </div>
                          </div>
                          <div className="p-2 rounded-xl bg-[#F6F4EE] border border-[#E8E2D6]">
                            <div className="text-[9px] text-[#6B7280] font-semibold uppercase">Sold</div>
                            <div className="text-sm font-bold font-mono text-blue-700 mt-0.5">
                              {stats.sold || 0}
                            </div>
                          </div>
                          <div className="p-2 rounded-xl bg-[#F6F4EE] border border-[#E8E2D6]">
                            <div className="text-[9px] text-[#6B7280] font-semibold uppercase">Block</div>
                            <div className="text-sm font-bold font-mono text-rose-700 mt-0.5">
                              {stats.blocked || 0}
                            </div>
                          </div>
                        </div>

                        {/* Inventory Mini Bar */}
                        {totalPlots > 0 && (
                          <div className="space-y-1.5">
                            <div className="flex justify-between text-[11px] text-[#6B7280] font-medium">
                              <span>Availability ({availPct}%)</span>
                              <span>{stats.totalPlots} Total Plots</span>
                            </div>
                            <div className="w-full h-2 bg-[#E8E2D6] rounded-full overflow-hidden flex">
                              <div className="bg-[#173F35] h-full transition-all duration-300" style={{ width: `${availPct}%` }} />
                              <div className="bg-rose-500 h-full transition-all duration-300" style={{ width: `${Math.round((soldPlots / totalPlots) * 100)}%` }} />
                              <div className="bg-[#D1C9B8] h-full flex-1" />
                            </div>
                          </div>
                        )}

                        {/* Detected PDF Plot Labels Banner in theme green */}
                        {pdfDetectedPlots != null && (
                          <div className="text-[11px] text-[#173F35] font-mono bg-[#EBF5F0] p-2.5 rounded-xl border border-[#C2E3D4] flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 animate-pulse" />
                            <span>PDF plot labels detected: <strong className="font-bold">{pdfDetectedPlots}</strong> (overlay layer)</span>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* Card Actions Footer */}
                  <div className="pt-3 border-t border-[#E8E2D6] flex items-center justify-between gap-2">
                    <Link
                      to={`${base}/colonies/${colony._id}`}
                      className="flex-1 bg-[#173F35] hover:bg-[#0D1B2A] text-white font-semibold text-xs py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 shadow-sm transition-all"
                      title="Open colony live map viewport"
                    >
                      {isProcessing ? (
                        <>
                          <Loader2 size={13} className="animate-spin text-amber-300" />
                          View Live Map
                        </>
                      ) : (
                        "Manage Map"
                      )}
                    </Link>

                    <button
                      onClick={() => handlePreview(colony)}
                      disabled={previewingId === colony._id}
                      className="bg-[#F6F4EE] hover:bg-[#E8E2D6] text-[#173F35] border border-[#E8E2D6] font-semibold text-xs py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
                      title="Live Customer Preview"
                    >
                      <Eye size={13} />
                      {previewingId === colony._id ? "Opening…" : "Preview"}
                    </button>

                    <button
                      onClick={() => handleOpenEditModal(colony)}
                      className="p-2 rounded-xl bg-[#F6F4EE] hover:bg-[#E8E2D6] text-[#173F35] border border-[#E8E2D6] transition-colors"
                      title="Edit Colony Configuration"
                    >
                      <Edit3 size={14} />
                    </button>

                    {(() => {
                      const currentUid = String(user?.id || user?._id || "");
                      const colonyOwnerId = String(colony.owner_id || colony.owner?.id || colony.owner?._id || "");
                      const isColonyOwner = isSuper ||
                        (Boolean(colonyOwnerId) && colonyOwnerId === currentUid) ||
                        Boolean(user?.email && colony.adminEmail && colony.adminEmail.toLowerCase() === user.email.toLowerCase()) ||
                        Boolean(user?.name && colony.adminName && colony.adminName.toLowerCase() === user.name.toLowerCase());
                      const ownerDisplayName = colony.adminName || colony.owner?.name || colony.owner?.email || "Super Admin";

                      return (
                        <button
                          onClick={() => { setDeletingColony(colony); setDeleteError(""); }}
                          className={`p-2 rounded-xl transition-colors ${
                            isColonyOwner
                              ? "bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200"
                              : "bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200"
                          }`}
                          title={isColonyOwner ? "Delete Colony" : `Shared Colony — Only owner (${ownerDisplayName}) can delete`}
                        >
                          <Trash2 size={14} />
                        </button>
                      );
                    })()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit Colony Modal */}
      {showAddModal && (
        <div className="lm-modal-shade animate-fade-in" data-testid="owner-colony-modal-shade">
          <div className="lm-modal max-w-lg w-full max-h-[90vh] overflow-y-auto space-y-4" data-testid="owner-colony-modal">
            <div className="lm-modal-head">
              <div>
                <p className="lm-eyebrow">{isSuper ? "PLATFORM GOVERNANCE" : "DEVELOPER WORKSPACE"}</p>
                <h2 className="text-xl font-bold text-[#172A25]">{editingColony ? "Edit Colony" : "Create New Colony"}</h2>
                <p className="text-xs text-[#6B7280] mt-0.5">
                  {isSuper ? "Configure colony settings, governance, and GIS sources" : "Configure colony details, boundaries, and GIS layout drawing"}
                </p>
              </div>
              <button onClick={() => setShowAddModal(false)} className="lm-icon-btn">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmitForm} className="space-y-4 text-sm">
              {/* SECTION A: Basic Info */}
              <div className="space-y-3">
                <h4 className="text-xs uppercase font-bold tracking-wider text-[#173F35] font-mono">Basic Information</h4>
                <div>
                  <label className="block text-xs font-mono text-[#5C6470] mb-1">Colony Name *</label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g. Durga Enclave Phase 2"
                    className="lm-modern-input w-full text-xs"
                  />
                </div>
                {!editingColony && (
                  <div>
                    <label className="block text-xs font-mono text-[#5C6470] mb-1">Colony Identifier Slug</label>
                    <input
                      type="text"
                      value={formData.colony_id}
                      onChange={(e) => setFormData({ ...formData, colony_id: e.target.value })}
                      placeholder="durga-enclave-phase-2 (auto-generated if empty)"
                      className="lm-modern-input w-full text-xs font-mono"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-mono text-[#5C6470] mb-1">Location / Address</label>
                  <input
                    type="text"
                    value={formData.location}
                    onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                    placeholder="e.g. Sector 14, City Center"
                    className="lm-modern-input w-full text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono text-[#5C6470] mb-1">Description</label>
                  <textarea
                    rows={2}
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Brief property overview..."
                    className="lm-modern-input w-full text-xs resize-none"
                  />
                </div>
              </div>

              {/* SECTION B: Ownership & Partnership (SUPER ADMIN ONLY) */}
              {isSuper && (
                <div className="space-y-3 pt-3 border-t border-[#E8E2D6]">
                  <h4 className="text-xs uppercase font-bold tracking-wider text-[#173F35] font-mono">Ownership &amp; Partnership</h4>
                  <div>
                    <label className="block text-xs font-mono text-[#5C6470] mb-1">Partner Admin (Optional)</label>
                    <select
                      value={formData.partner_admin_id}
                      onChange={(e) => setFormData({ ...formData, partner_admin_id: e.target.value })}
                      className="lm-modern-input w-full text-xs"
                    >
                      <option value="">None (Super Admin Only Property)</option>
                      {admins.map((adm) => (
                        <option key={adm._id} value={adm._id}>
                          {adm.name} ({adm.email})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* SECTION C: Public Visibility */}
              <div className="space-y-3 pt-3 border-t border-[#E8E2D6]">
                <h4 className="text-xs uppercase font-bold tracking-wider text-[#173F35] font-mono">Public Homepage Visibility</h4>
                <label className="flex items-center gap-3 p-3 bg-[#F6F4EE] rounded-xl border border-[#E8E2D6] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.is_public}
                    onChange={(e) => setFormData({ ...formData, is_public: e.target.checked })}
                    className="w-4 h-4 rounded text-[#173F35] focus:ring-[#173F35] bg-white border-[#E8E2D6]"
                  />
                  <div>
                    <span className="font-semibold text-xs text-[#172A25] block">Show on Public Showcase</span>
                    <span className="text-[11px] text-[#6B7280] block">
                      Allows visitors to discover this colony on the platform landing page.
                    </span>
                  </div>
                </label>
              </div>

              {/* SECTION D: GIS source files */}
              <div className="space-y-3 pt-3 border-t border-[#E8E2D6]">
                <h4 className="text-xs uppercase font-bold tracking-wider text-[#173F35] font-mono">
                  {editingColony ? "Replace Mapping Sources (KML + PDF/DXF)" : "Upload Mapping Sources (KML + PDF/DXF)"}
                </h4>
                <div>
                  <label className="block text-xs font-mono text-[#5C6470] mb-1">1 · KML File (.kml)</label>
                  <input
                    type="file"
                    accept=".kml,application/vnd.google-earth.kml+xml"
                    onChange={(e) => setGeojsonFile(e.target.files?.[0] || null)}
                    className="w-full text-xs text-[#6B7280] file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-[#173F35] file:text-white hover:file:bg-[#0D1B2A] cursor-pointer"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono text-[#5C6470] mb-1">2 · Layout Drawing (.pdf, .dxf)</label>
                  <input
                    type="file"
                    accept=".pdf,.dxf,application/pdf"
                    onChange={(e) => setLayoutPdf(e.target.files?.[0] || null)}
                    className="w-full text-xs text-[#6B7280] file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-[#173F35] file:text-white hover:file:bg-[#0D1B2A] cursor-pointer"
                  />
                </div>
              </div>

              {/* Modal Actions */}
              <div className="pt-4 border-t border-[#E8E2D6] flex items-center justify-end gap-3">
                {formError && <p className="mr-auto text-xs text-rose-600 font-medium" role="alert">{formError}</p>}
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="lm-btn-secondary-dark text-xs px-4"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="lm-btn-glow text-xs px-5"
                >
                  {submitting ? "Saving…" : editingColony ? "Save Changes" : "Create Colony"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingColony && (() => {
        const currentUid = String(user?.id || user?._id || "");
        const colonyOwnerId = String(deletingColony.owner_id || deletingColony.owner?.id || deletingColony.owner?._id || "");
        const isColonyOwner = isSuper ||
          (Boolean(colonyOwnerId) && colonyOwnerId === currentUid) ||
          Boolean(user?.email && deletingColony.adminEmail && deletingColony.adminEmail.toLowerCase() === user.email.toLowerCase()) ||
          Boolean(user?.name && deletingColony.adminName && deletingColony.adminName.toLowerCase() === user.name.toLowerCase());
        const ownerDisplayName = deletingColony.adminName || deletingColony.owner?.name || deletingColony.owner?.email || "Super Admin";

        return (
          <div className="lm-modal-shade animate-fade-in">
            <div className="lm-modal max-w-md w-full space-y-4">
              <div className="flex items-center justify-between border-b border-[#E8E2D6] pb-3">
                <div className="flex items-center gap-2 text-rose-600">
                  <AlertCircle size={20} className={isColonyOwner ? "text-rose-600" : "text-amber-600"} />
                  <h3 className="text-lg font-bold text-[#172A25]">
                    {isColonyOwner ? "Delete Colony" : "Colony Deletion Restricted"}
                  </h3>
                </div>
                <button
                  onClick={() => { setDeletingColony(null); setDeleteError(""); }}
                  className="lm-icon-btn"
                >
                  <X size={16} />
                </button>
              </div>

              {isColonyOwner ? (
                <>
                  <p className="text-sm text-[#374151] leading-relaxed">
                    Are you sure you want to permanently delete <strong className="text-[#172A25]">{deletingColony.name || deletingColony.colony_id}</strong>?
                  </p>
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 space-y-1">
                    <p className="font-semibold text-rose-800">⚠️ Warning: Critical Data Removal</p>
                    <p>This action will permanently delete all associated plots, zones, registry entries, and GIS files. This operation cannot be undone.</p>
                  </div>
                </>
              ) : (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl space-y-2.5">
                  <div className="flex items-center gap-2 text-amber-900 font-bold text-sm">
                    <Shield size={16} className="text-amber-700 shrink-0" />
                    <span>Aap is colony ko delete nahi kar sakte</span>
                  </div>
                  <p className="text-xs text-amber-950 leading-relaxed font-medium">
                    Yeh colony aapko share ki gayi hai. Ise keval iske owner <strong className="font-bold underline text-amber-900">{ownerDisplayName}</strong> hi delete kar sakte hain.
                  </p>
                  <p className="text-[11px] text-amber-800/80 font-mono">
                    (You cannot delete this colony. Only the owner <strong>{ownerDisplayName}</strong> can delete it.)
                  </p>
                </div>
              )}

              {deleteError && (
                <p className="text-xs text-rose-600 bg-rose-50 p-2.5 rounded-lg border border-rose-200" role="alert">
                  {deleteError}
                </p>
              )}

              <div className="pt-2 flex items-center justify-end gap-3 border-t border-[#E8E2D6]">
                <button
                  type="button"
                  onClick={() => { setDeletingColony(null); setDeleteError(""); }}
                  disabled={isDeleting}
                  className="lm-btn-secondary-dark text-xs px-4"
                >
                  {isColonyOwner ? "Cancel" : "Close"}
                </button>
                {isColonyOwner && (
                  <button
                    type="button"
                    onClick={handleConfirmDelete}
                    disabled={isDeleting}
                    className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-medium text-xs transition disabled:opacity-50 flex items-center gap-1.5 shadow-md shadow-rose-600/20"
                  >
                    <Trash2 size={14} />
                    {isDeleting ? "Deleting…" : "Permanently Delete"}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
