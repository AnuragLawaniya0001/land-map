import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Search, LocateFixed, X, Upload, Download, Lock, Settings, Map as MapIcon, List, Layers, CircleDot, Edit3, Share2, Image as ImageIcon, UserCheck, Database, Move, Satellite, Box, Compass, PanelRightClose, PanelRightOpen, Loader2, PencilRuler, Table } from "lucide-react";
import { api, errMsg, BACKEND } from "@/lib/api";
import { usePortalBase } from "@/lib/portal";
import InteractiveMap from "@/components/InteractiveMap";
import { PlotSummary } from "@/components/PlotCard";
import AdminPlotTable from "@/components/AdminPlotTable";
import ColonySettingsModal from "@/components/ColonySettingsModal";
import ColonyDataUsedModal from "@/components/ColonyDataUsedModal";
import { estimatePlotDimensions, isSelectablePlotGeometry } from "@/lib/geo";
import AdminPlotEditModal from "@/components/AdminPlotEditModal";
import AdminPlotCsvModal from "@/components/AdminPlotCsvModal";
import AdminShareModal from "@/components/AdminShareModal";
import AdminPlotMediaModal from "@/components/AdminPlotMediaModal";
import AdminPlotOwnershipModal from "@/components/AdminPlotOwnershipModal";
import PlacementCalibrationModal from "@/components/PlacementCalibrationModal";

export default function AdminColonyMap() {
  const { id } = useParams();
  const base = usePortalBase();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("map");
  const [showPanel, setShowPanel] = useState(true);
  const [selectedPlot, setSelectedPlot] = useState(null);
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [selectedZone, setSelectedZone] = useState(null);
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [showStatusColors, setShowStatusColors] = useState(true);
  const [showZones, setShowZones] = useState(false);
  const [showPdfArtwork, setShowPdfArtwork] = useState(false);
  const [mapStyle, setMapStyle] = useState("satellite");
  const [query, setQuery] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [err, setErr] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState("");
  const [editingPlot, setEditingPlot] = useState(false);
  const [sharingPlot, setSharingPlot] = useState(false);
  const [managingMedia, setManagingMedia] = useState(false);
  const [managingOwnership, setManagingOwnership] = useState(false);
  const [registry, setRegistry] = useState([]);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const [showDataUsed, setShowDataUsed] = useState(false);
  const [showPlacementModal, setShowPlacementModal] = useState(false);
  const [rebuildingRegions, setRebuildingRegions] = useState(false);
  const [importNotice, setImportNotice] = useState(null);
  const [soldModalPlot, setSoldModalPlot] = useState(null);
  const [soldFile, setSoldFile] = useState(null);
  const [soldModalErr, setSoldModalErr] = useState("");
  const [soldSubmitting, setSoldSubmitting] = useState(false);
  const [pipelineStatus, setPipelineStatus] = useState(null);
  const fileInputRef = useRef(null);

  const load = () => api.get(`/admin/colonies/${id}`).then((r) => setData(r.data)).catch((e) => setErr(errMsg(e)));
  useEffect(() => {
    setShowPdfArtwork(false);
    load();
  }, [id]); // eslint-disable-line

  // Live polling when colony pipeline is actively running in background
  useEffect(() => {
    const isProcessing =
      data?.is_processing ||
      data?.colony?.processing_status === "running" ||
      data?.colony?.processing_status === "queued";

    if (!isProcessing) return;

    let timer;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await api.get(`/admin/colonies/${id}/status`);
        if (cancelled) return;
        setPipelineStatus(res.data);
        if (res.data.status === "ready") {
          // Pipeline finished! Automatically reload entire colony map
          load();
        } else if (res.data.status !== "failed") {
          timer = setTimeout(poll, 2000);
        }
      } catch (e) {
        if (!cancelled) timer = setTimeout(poll, 3000);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, data?.is_processing, data?.colony?.processing_status]);

  const rebuildOverlayRegions = async () => {
    setRebuildingRegions(true);
    setErr("");
    try {
      const response = await api.post(`/admin/colonies/${id}/pdf-overlay/rebuild-regions`);
      setData((current) => current ? ({
        ...current,
        colony: { ...current.colony, pdf_overlay: response.data.pdf_overlay },
      }) : current);
    } catch (error) {
      setErr(errMsg(error));
    } finally {
      setRebuildingRegions(false);
    }
  };

  const handleDirectExportCsv = async () => {
    try {
      const res = await api.get(`/admin/colonies/${id}/plots/export-csv`, {
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "text/csv;charset=utf-8;" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cleanName = (data?.colony?.name || "colony").replace(/[^a-zA-Z0-9_-]/g, "_");
      a.download = `${cleanName}_plots.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setErr(errMsg(e));
    }
  };


  useEffect(() => {
    if (!selectedPlot || selectedPlot.is_pdf_detected) { setRegistry([]); setUploadErr(""); return; }
    api.get(`/admin/plots/${selectedPlot.id}/registry`).then((r) => setRegistry(r.data)).catch(() => setRegistry([]));
  }, [selectedPlot?.id]); // eslint-disable-line

  const zonesById = useMemo(() => {
    const map = {};
    (data?.zones || []).forEach((z) => {
      if (z.id) map[z.id] = z;
      if (z.code) {
        map[z.code] = z;
        map[z.code.toLowerCase()] = z;
        map[`zone ${z.code}`.toLowerCase()] = z;
      }
      if (z.name) {
        map[z.name] = z;
        map[z.name.toLowerCase()] = z;
      }
    });
    return map;
  }, [data?.zones]);

  const filteredIds = useMemo(() => {
    if (!data) return null;
    const q = query.trim().toLowerCase();
    if (!selectedZone && !selectedStatus && !q) return null;
    const savedPlotIds = data.plots
      .filter((p) => {
        if (selectedZone) {
          const pz = zonesById[p.zone_id];
          const matches = p.zone_id === selectedZone || (pz && pz.id === selectedZone);
          if (!matches) return false;
        }
        if (selectedStatus && p.status_id !== selectedStatus) return false;
        if (q && !p.number.toLowerCase().includes(q)) return false;
        return true;
      })
      .map((p) => p.id);
    const pdfRegionIds = selectedZone ? [] : (data.colony.pdf_overlay?.plot_regions || [])
      .filter((region) => (!selectedStatus || (region.status_id || "available") === selectedStatus) &&
        (!q || String(region.number || "").toLowerCase().includes(q)))
      .map((region) => region.id);
    return new Set([...savedPlotIds, ...pdfRegionIds]);
  }, [data, selectedZone, selectedStatus, query, zonesById]);

  if (err && !data) return <div className="lm-error-page"><h2>Not available</h2><p>{err}</p></div>;
  if (!data) return <div className="lm-loading">Loading inventory…</div>;

  const statusesById = Object.fromEntries(data.statuses.map((s) => [s.id, s]));
  const overlay = data.colony.pdf_overlay;
  const isCadOverlay = overlay?.source_type === "cad";
  const overlayName = isCadOverlay ? "CAD drawing" : "PDF artwork";
  const overlayFit = overlay?.fit;
  const pdfContent = data.colony.import_source?.pdf_content;
  const detectedPdfLabels = overlayFit?.detected_plot_label_count ??
    overlay?.plot_count ?? 0;
  const matchedPdfLabels = Math.min(
    detectedPdfLabels,
    overlayFit?.matched_plot_label_count ?? overlayFit?.interactive_plot_count ?? 0,
  );
  const unmatchedPdfLabelCount = Math.max(0, detectedPdfLabels - matchedPdfLabels);
  const pdfArtworkVisible = showPdfArtwork;

  const applyLocal = (ids, statusId, registryCountInc = 0) => {
    const idSet = new Set(ids);
    setData((d) => ({
      ...d,
      plots: d.plots.map((p) => (idSet.has(p.id) ? { ...p, status_id: statusId, registry_count: (p.registry_count || 0) + registryCountInc } : p)),
    }));
    if (selectedPlot && idSet.has(selectedPlot.id)) {
      setSelectedPlot((p) => ({ ...p, status_id: statusId, registry_count: (p.registry_count || 0) + registryCountInc }));
    }
  };

  const handleStatusClick = (plot, statusId) => {
    if (plot.status_id === statusId) return;
    if (plot.is_pdf_detected && statusId === "sold") {
      setErr("A detected PDF region must be verified and saved as a plot before it can be marked Sold.");
      return;
    }
    if (statusId === "sold") {
      setSoldModalPlot(plot);
      setSoldFile(null);
      setSoldModalErr("");
      return;
    }
    changeStatus(plot, statusId);
  };

  const changeStatus = async (plot, statusId) => {
    setBusy(true); setErr("");
    try {
      if (plot.is_pdf_detected) {
        await api.patch(
          `/admin/colonies/${id}/pdf-overlay/regions/${encodeURIComponent(plot.id)}/status`,
          { status_id: statusId },
        );
        setData((current) => current ? ({
          ...current,
          colony: {
            ...current.colony,
            pdf_overlay: {
              ...current.colony.pdf_overlay,
              plot_regions: current.colony.pdf_overlay.plot_regions.map((region) =>
                region.id === plot.id ? { ...region, status_id: statusId } : region
              ),
            },
          },
        }) : current);
        setSelectedPlot((current) => current?.id === plot.id
          ? { ...current, status_id: statusId }
          : current);
      } else {
        await api.patch(`/admin/plots/${plot.id}/status`, { status_id: statusId });
        applyLocal([plot.id], statusId);
      }
    } catch (e) {
      const msg = errMsg(e);
      setErr(msg);
      if (statusId === "sold") {
        setSoldModalPlot(plot);
        setSoldModalErr(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSoldSubmit = async () => {
    if (!soldModalPlot) return;
    const existingRegCount = selectedPlot?.id === soldModalPlot.id ? registry.length : (soldModalPlot.registry_count || 0);
    if (!soldFile && existingRegCount === 0) {
      setSoldModalErr("Registry document is required before this plot can be marked Sold.");
      return;
    }
    setSoldSubmitting(true);
    setSoldModalErr("");
    try {
      const fd = new FormData();
      if (soldFile) fd.append("file", soldFile);
      const res = await api.post(`/admin/plots/${soldModalPlot.id}/sold`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      applyLocal([soldModalPlot.id], "sold", soldFile ? 1 : 0);
      if (selectedPlot?.id === soldModalPlot.id) {
        const r = await api.get(`/admin/plots/${soldModalPlot.id}/registry`);
        setRegistry(r.data);
      }
      setSoldModalPlot(null);
      setSoldFile(null);
    } catch (e) {
      setSoldModalErr(errMsg(e));
    } finally {
      setSoldSubmitting(false);
    }
  };

  const bulkStatus = async (ids, statusId) => {
    if (statusId === "sold") {
      setErr("To mark plot(s) Sold, please use the Sold workflow with registry document attached.");
      return;
    }
    setBusy(true); setErr("");
    try { await api.patch(`/admin/plots/bulk-status`, { plot_ids: ids, status_id: statusId }); applyLocal(ids, statusId); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  const uploadRegistry = async (file) => {
    setUploadErr("");
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) { setUploadErr("PDF files only"); return; }
    setUploading(true);
    const fd = new FormData(); fd.append("file", file);
    try {
      await api.post(`/admin/plots/${selectedPlot.id}/registry`, fd, { headers: { "Content-Type": "multipart/form-data" } });
      const r = await api.get(`/admin/plots/${selectedPlot.id}/registry`);
      setRegistry(r.data);
      setData((d) => ({ ...d, plots: d.plots.map((p) => (p.id === selectedPlot.id ? { ...p, registry_count: r.data.length } : p)) }));
    } catch (e) { setUploadErr(errMsg(e)); }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ""; }
  };

  const downloadRegistry = async (doc) => {
    try {
      const r = await api.get(`/admin/registry/${doc.id}/download`, { responseType: "blob" });
      const url = URL.createObjectURL(r.data);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { setUploadErr(errMsg(e)); }
  };

  const registryLabels = ["1st Registry", "2nd Registry", "3rd Registry"];
  const selectedPlotSummary = selectedPlot?.is_pdf_detected
    ? { ...selectedPlot, ...estimatePlotDimensions(selectedPlot.geometry) }
    : selectedPlot;

  // Calculate live inventory telemetry stats
  const totalPlotsCount = data.plots.length;
  const availablePlotsCount = data.plots.filter((p) => p.status_id === "available").length;
  const holdPlotsCount = data.plots.filter((p) => p.status_id === "hold").length;
  const reservedPlotsCount = data.plots.filter((p) => p.status_id === "reserved").length;
  const soldPlotsCount = data.plots.filter((p) => p.status_id === "sold").length;
  const availPct = totalPlotsCount > 0 ? Math.round((availablePlotsCount / totalPlotsCount) * 100) : 0;
  const strokeDashoffset = 220 - (220 * availPct) / 100;

  return (
    <div className={`lm-gis-root ${showPanel ? "has-panel" : "no-panel"}`} data-testid="admin-colony-workspace">
      {/* Unified Sleek Top Navigation Bar */}
      <header className="lm-gis-top-bar">
        {/* Left: Colony Title & Location */}
        <div className="lm-top-left">
          <div className="lm-top-colony">
            <h1 className="lm-top-title">{data.colony.name}</h1>
            <div className="lm-top-meta">
              <span>{data.colony.location || "27.22308°N, 78.25477°E"}</span>
              {data.colony.whatsapp_number && (
                <span className="lm-top-wa">WA {data.colony.whatsapp_number}</span>
              )}
            </div>
          </div>
        </div>

        {/* Center: Search & View Toggle */}
        <div className="lm-top-center">
          <div className="lm-top-tabs" data-testid="colony-tabs">
            <button className={`lm-top-tab ${tab === "map" ? "active" : ""}`} onClick={() => setTab("map")} data-testid="tab-map">
              <MapIcon size={13} /> Map
            </button>
            <button className={`lm-top-tab ${tab === "list" ? "active" : ""}`} onClick={() => setTab("list")} data-testid="tab-list">
              <List size={13} /> Table
            </button>
          </div>

          <div className="lm-top-search">
            <Search size={14} className="lm-search-icon" />
            <input
              data-testid="admin-plot-search"
              placeholder="Search plot or zone…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="lm-search-clear" onClick={() => setQuery("")}>
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Right: Map Controls & Actions */}
        <div className="lm-top-right">
          <button
            type="button"
            className={`lm-top-btn ${mapStyle === "satellite" ? "active" : ""}`}
            onClick={() => setMapStyle(mapStyle === "satellite" ? "plan" : "satellite")}
            data-testid="admin-toggle-map-style"
            title="Toggle Satellite / Plan"
          >
            <Satellite size={13} /> Satellite
          </button>

          <Link
            to={`${base}/colonies/${id}/canonical`}
            className="lm-top-btn"
            title="Open 3D Spatial Viewer"
          >
            <Box size={13} /> 3D View
          </Link>

          <button
            type="button"
            className={`lm-top-btn ${showStatusColors ? "active" : ""}`}
            onClick={() => setShowStatusColors(!showStatusColors)}
            data-testid="admin-toggle-plot-status-colors"
            title="Toggle Status Colors"
          >
            <Layers size={13} /> Status
          </button>

          <button
            type="button"
            className={`lm-top-btn ${showZones ? "active" : ""}`}
            onClick={() => setShowZones(!showZones)}
            data-testid="admin-toggle-zones"
            title="Toggle Zone Outlines"
          >
            <CircleDot size={13} /> Zones
          </button>

          <button
            type="button"
            className="lm-top-btn"
            data-testid="admin-reset-view"
            onClick={() => { setSelectedZone(null); setSelectedStatus(null); setQuery(""); setSelectedPlot(null); setResetKey((k) => k + 1); }}
            title="Reset Map Camera"
          >
            <LocateFixed size={13} /> Reset
          </button>

          <button
            type="button"
            className="lm-top-btn"
            onClick={() => setShowPlacementModal(true)}
            data-testid="colony-placement-btn"
            title={overlay ? `Calibrate ${overlayName}` : "Calibrate Placement"}
          >
            <Move size={13} /> Calibrate
          </button>

          <details className="lm-top-actions-dropdown">
            <summary className="lm-top-btn lm-actions-summary">
              <Settings size={13} /> Actions
            </summary>
            <div className="lm-top-actions-menu">
              <button
                className="lm-top-menu-item text-emerald-400"
                onClick={() => setShowDataUsed(true)}
                data-testid="colony-data-used-btn"
              >
                <Database size={13} /> Data Used & Accuracy
              </button>
              <button
                className="lm-top-menu-item text-violet-400"
                onClick={() => setSettings(true)}
                data-testid="colony-gis-import-btn"
              >
                <Upload size={13} /> Replace Mapping
              </button>
              <button
                className="lm-top-menu-item"
                onClick={() => setSettings(true)}
                data-testid="colony-settings-btn"
              >
                <Settings size={13} /> Colony Settings
              </button>
              <button
                className="lm-top-menu-item text-amber-500 font-medium"
                onClick={handleDirectExportCsv}
                data-testid="colony-plots-export-btn"
              >
                <Download size={13} /> Export Plots (CSV)
              </button>
              <button
                className="lm-top-menu-item text-amber-500 font-medium"
                onClick={() => setShowCsvModal(true)}
                data-testid="colony-plots-csv-btn"
              >
                <Upload size={13} /> Import Plots (CSV)
              </button>
              <a
                className="lm-top-menu-item"
                href={`${BACKEND}/api/admin/colonies/${id}/geojson`}
                target="_blank"
                rel="noreferrer"
                data-testid="download-geojson"
              >
                <Download size={13} /> Export GeoJSON
              </a>
              {data.colony.public_enabled && (
                <Link
                  to={`/project/${data.colony.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="lm-top-menu-item text-sky-400"
                  data-testid="open-public-view"
                >
                  <MapIcon size={13} /> Public Portal View
                </Link>
              )}
            </div>
          </details>

          <button
            type="button"
            className={`lm-top-panel-btn ${showPanel ? "active" : ""}`}
            onClick={() => setShowPanel(!showPanel)}
            title={showPanel ? "Collapse Side Panel" : "Expand Side Panel"}
          >
            {showPanel ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
        </div>
      </header>

      {/* Floating System Alerts */}
      {err && <div className="lm-gis-alert-floating" data-testid="admin-error">{err}</div>}
      {importNotice && (
        <div className="lm-gis-alert-floating success" role="status" data-testid="mapping-import-summary">
          <strong>{importNotice.boundaryOnly ? "Land outline updated; existing plots and zones were preserved." : "Colony mapping updated."}</strong>
          {importNotice.warnings.length > 0 && (
            <ul>{importNotice.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          )}
        </div>
      )}

      {tab === "list" ? (
        <div className="lm-gis-list-viewport">
          <AdminPlotTable
            data={data}
            busy={busy}
            onStatusChange={(p, s) => handleStatusClick(p, s)}
            onBulkStatus={bulkStatus}
            onOpenOnMap={(p) => { setSelectedPlot(p); setTab("map"); }}
            onEditPlot={(p) => { setSelectedPlot(p); setEditingPlot(true); }}
            onExportCsv={handleDirectExportCsv}
            onImportCsv={() => setShowCsvModal(true)}
          />
        </div>
      ) : (
        <div className="lm-gis-workspace">
          {/* Main Map Viewport */}
          <div className="lm-gis-map-viewport relative">
            {/* Live Pipeline Processing Banner / HUD */}
            {(data?.is_processing ||
              data?.colony?.processing_status === "running" ||
              data?.colony?.processing_status === "queued") && (
              <div className="lm-map-processing-hud" role="status" aria-live="polite">
                <div className="flex items-center justify-between gap-4 mb-2.5">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
                      <Loader2 size={18} className="animate-spin text-amber-400" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold uppercase tracking-wider text-amber-300">
                        AI GIS Pipeline In Progress
                      </h4>
                      <p className="text-[11px] text-slate-300">
                        {pipelineStatus?.stage || data?.colony?.processing_stage || "Extracting plot parcels and georeferencing..."}
                      </p>
                    </div>
                  </div>
                  <span className="font-mono text-xs font-bold text-amber-300 bg-amber-950/80 px-2.5 py-1 rounded border border-amber-800/60 shrink-0">
                    {pipelineStatus?.progress ?? data?.colony?.processing_progress ?? 25}%
                  </span>
                </div>
                <div className="w-full h-1.5 bg-[#E8E2D6] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 via-sky-400 to-[#173F35] transition-all duration-300"
                    style={{ width: `${Math.max(pipelineStatus?.progress ?? data?.colony?.processing_progress ?? 20, 10)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] text-[#6B7280] mt-2">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
                    Processing layout vectors & OCR
                  </span>
                  <span className="text-[#047857] font-semibold">Plots will load automatically once ready</span>
                </div>
              </div>
            )}

            <div className="lm-gis-canvas">
              <InteractiveMap
                data={data}
                filteredPlotIds={filteredIds}
                selectedZone={selectedZone}
                setSelectedZone={setSelectedZone}
                selectedPlot={selectedPlot}
                setSelectedPlot={setSelectedPlot}
                resetKey={resetKey}
                showZones={showZones}
                showStatus={showStatusColors}
                showPdfArtwork={pdfArtworkVisible}
                mapStyle={mapStyle}
                onManageMedia={() => setManagingMedia(true)}
                onShare={() => setSharingPlot(true)}
              />
            </div>

            {/* Compact, Clean Bottom Legend Capsule */}
            <div className="lm-gis-legend-dock">
              {showZones && (data.zones || []).length > 0 ? (
                <>
                  <span className="lm-gis-legend-label" style={{ fontSize: "11px", fontWeight: 700, color: "#173F35", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Zones:
                  </span>
                  {data.zones.map((z) => {
                    const count = data.plots.filter((p) => {
                      const pz = zonesById[p.zone_id];
                      return p.zone_id === z.id || (pz && pz.id === z.id);
                    }).length;
                    const isSel = selectedZone === z.id;
                    return (
                      <button
                        key={z.id}
                        className={`lm-legend-pill ${isSel ? "active" : ""}`}
                        onClick={() => setSelectedZone(isSel ? null : z.id)}
                        data-testid={`admin-zone-filter-${z.code || z.id}`}
                      >
                        <i style={{ background: z.color }} />
                        <span>{z.name || `Zone ${z.code}`}</span>
                        <span className="lm-legend-pill-count">{count}</span>
                      </button>
                    );
                  })}
                  <span className="lm-fsep" style={{ width: "1px", height: "16px", background: "#D1D5DB", margin: "0 4px" }} />
                </>
              ) : null}

              {!showStatusColors && !showZones && (
                <span className="lm-gis-legend-warning" data-testid="status-colors-hidden">
                  Colors hidden
                </span>
              )}
              {data.statuses.map((s) => {
                const count = data.plots.filter((p) => p.status_id === s.id).length;
                return (
                  <button
                    key={s.id}
                    className={`lm-legend-pill ${selectedStatus === s.id ? "active" : ""} ${!showStatusColors && !showZones ? "muted" : ""}`}
                    onClick={() => setSelectedStatus(selectedStatus === s.id ? null : s.id)}
                    data-testid={`admin-status-filter-${s.id}`}
                  >
                    <i style={{ background: s.color }} />
                    <span>{s.name}</span>
                    <span className="lm-legend-pill-count">{count}</span>
                  </button>
                );
              })}
              {(data.colony.roads || []).length > 0 && (
                <span className="lm-legend-feature-tag" data-testid="map-legend-roads">
                  <i className="road" /> Road
                </span>
              )}
              {(data.colony.greens || []).length > 0 && (
                <span className="lm-legend-feature-tag" data-testid="map-legend-gardens">
                  <i className="garden" /> Garden
                </span>
              )}
            </div>
          </div>

          {/* Clean, Docked Right Sidebar */}
          {showPanel && (
            <aside className="lm-gis-telemetry-deck">
              {/* Header */}
              <div className="lm-deck-header">
                <div>
                  <span className="lm-deck-eyebrow">Inventory Overview</span>
                  <h2 className="lm-deck-colony-title">{data.colony.name}</h2>
                </div>
              </div>

              {/* Clean 4-Card Metric Grid */}
              <div className="lm-deck-metrics-grid">
                <div className="lm-metric-box avail">
                  <div className="lm-metric-val">{availablePlotsCount}</div>
                  <div className="lm-metric-tag">Available</div>
                </div>
                <div className="lm-metric-box total">
                  <div className="lm-metric-val">{totalPlotsCount}</div>
                  <div className="lm-metric-tag">Total Plots</div>
                </div>
                <div className="lm-metric-box hold">
                  <div className="lm-metric-val">{holdPlotsCount + reservedPlotsCount}</div>
                  <div className="lm-metric-tag">Hold / Reserved</div>
                </div>
                <div className="lm-metric-box sold">
                  <div className="lm-metric-val">{soldPlotsCount}</div>
                  <div className="lm-metric-tag">Sold</div>
                </div>
              </div>

              {/* Sectors & Zones */}
              {data.zones.length > 0 && (
                <div className="lm-deck-zones-bar">
                  <div className="lm-deck-zones-header">
                    <span className="lm-deck-eyebrow">Zones</span>
                    {selectedZone && (
                      <button className="lm-deck-clear-link" onClick={() => setSelectedZone(null)}>
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="lm-deck-zones-chips">
                    {data.zones.map((z) => {
                      const sel = selectedZone === z.id;
                      const count = data.plots.filter((p) => {
                        const pz = zonesById[p.zone_id];
                        return p.zone_id === z.id || (pz && pz.id === z.id);
                      }).length;
                      return (
                        <button
                          key={z.id}
                          className={`lm-deck-zone-chip ${sel ? "active" : ""}`}
                          onClick={() => setSelectedZone(sel ? null : z.id)}
                          data-testid={`admin-zone-chip-${z.code || z.id}`}
                        >
                          <span className="lm-deck-zone-dot" style={{ background: z.color }} />
                          <span>{z.name || `Zone ${z.code}`}</span>
                          <span className="lm-deck-zone-qty">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Dynamic Plot Inspection or Idle Prompt */}
              {selectedPlot ? (
                <div className="lm-gis-inspector-card" data-testid="admin-plot-detail">
                  <div className="lm-gis-inspector-head">
                    <div className="lm-gis-inspector-badge">
                      {selectedPlot.is_generated_candidate_id
                        ? "REVIEW CANDIDATE"
                        : selectedPlot.is_pdf_detected
                        ? "PDF REGION"
                        : "PLOT SPECIFICATION"}
                    </div>
                    <button
                      className="lm-gis-close-btn"
                      onClick={() => setSelectedPlot(null)}
                      data-testid="admin-close-plot"
                      title="Close Inspector"
                    >
                      <X size={15} />
                    </button>
                  </div>

                  <div className="lm-gis-inspector-title-row">
                    <h2>{selectedPlot.number ? `Plot #${selectedPlot.number}` : "Detected Region"}</h2>
                    {!selectedPlot.is_pdf_detected && (
                      <div className="lm-gis-inspector-quick-tools">
                        <button className="lm-gis-mini-tool" onClick={() => setManagingMedia(true)} data-testid="manage-media-btn" title="Media & Photos">
                          <ImageIcon size={13} />
                        </button>
                        <button className="lm-gis-mini-tool" onClick={() => setManagingOwnership(true)} data-testid="manage-ownership-btn" title="Ownership Records">
                          <UserCheck size={13} />
                        </button>
                        <button className="lm-gis-mini-tool" onClick={() => setSharingPlot(true)} data-testid="share-property-btn" title="Share Plot">
                          <Share2 size={13} />
                        </button>
                        <button className="lm-gis-mini-tool" onClick={() => setEditingPlot(true)} data-testid="edit-property-btn" title="Edit Plot Details">
                          <Edit3 size={13} />
                        </button>
                      </div>
                    )}
                  </div>

                  {selectedPlot.is_pdf_detected ? (
                    <>
                      <p className="lm-gis-inspector-note" data-testid="pdf-detected-plot-note">
                        Detected boundary from {selectedPlot.detection_source || "vector trace"}.
                      </p>
                      <PlotSummary plot={selectedPlotSummary} showGps={false} />
                      <div className="lm-gis-status-module" data-testid="pdf-region-status-controls">
                        <div className="lm-gis-eyebrow">
                          REGION STATUS {busy && <span className="text-amber-400 font-normal ml-2">(Updating…)</span>}
                        </div>
                        <div className="lm-gis-status-grid">
                          {data.statuses.map((status) => (
                            <button
                              key={status.id}
                              type="button"
                              className={`lm-gis-status-pill ${selectedPlot.status_id === status.id ? "active" : ""}`}
                              style={{ "--c": status.color }}
                              disabled={busy || status.id === "sold"}
                              onClick={() => handleStatusClick(selectedPlot, status.id)}
                              data-testid={`pdf-region-status-${status.id}`}
                            >
                              <i style={{ background: status.color }} /> {status.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <PlotSummary
                        plot={selectedPlot}
                        status={statusesById[selectedPlot.status_id]}
                        zone={zonesById[selectedPlot.zone_id]}
                      />

                      {/* Change Status Module */}
                      <div className="lm-gis-status-module">
                        <div className="lm-gis-eyebrow">
                          UPDATE STATUS {busy && <span className="text-amber-400 font-normal ml-2">(Syncing…)</span>}
                        </div>
                        <div className="lm-gis-status-grid">
                          {data.statuses.map((s) => (
                            <button
                              key={s.id}
                              className={`lm-gis-status-pill ${selectedPlot.status_id === s.id ? "active" : ""}`}
                              style={{ "--c": s.color }}
                              disabled={busy}
                              onClick={() => handleStatusClick(selectedPlot, s.id)}
                              data-testid={`change-status-${s.id}`}
                            >
                              <i style={{ background: s.color }} /> {s.name}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Registry Document Vault */}
                      <div className="lm-gis-registry-vault" data-testid="registry-section">
                        <div className="lm-gis-eyebrow">REGISTRY DOCUMENTS ({registry.length} / 3)</div>
                        {registry.length === 0 && selectedPlot.status_id !== "sold" && (
                          <div className="lm-gis-vault-warning">
                            <Lock size={13} />
                            <span>Registry required for <b>Sold</b> status</span>
                          </div>
                        )}
                        {registry.map((doc) => (
                          <div className="lm-gis-doc-row" key={doc.id} data-testid={`registry-row-${doc.version}`}>
                            <div className="lm-gis-doc-info">
                              <b>{registryLabels[doc.version - 1] || `Registry v${doc.version}`}</b>
                              <small>{doc.filename} · {Math.round(doc.size / 1024)} KB</small>
                            </div>
                            <button
                              className="lm-gis-doc-download"
                              onClick={() => downloadRegistry(doc)}
                              data-testid={`download-registry-${doc.version}`}
                              title="Download PDF"
                            >
                              <Download size={13} />
                            </button>
                          </div>
                        ))}
                        {registry.length < 3 ? (
                          <div className="mt-2">
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept="application/pdf"
                              hidden
                              onChange={(e) => uploadRegistry(e.target.files?.[0])}
                              data-testid="registry-file-input"
                            />
                            <button
                              className="lm-gis-upload-btn"
                              disabled={uploading}
                              onClick={() => fileInputRef.current?.click()}
                              data-testid="upload-registry-btn"
                            >
                              <Upload size={13} /> {uploading ? "Uploading PDF…" : `Attach ${registryLabels[registry.length]}`}
                            </button>
                          </div>
                        ) : (
                          <div className="lm-gis-vault-warning">
                            <Lock size={13} /> Maximum 3 registries recorded.
                          </div>
                        )}
                        {uploadErr && <div className="lm-error mt-2">{uploadErr}</div>}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                /* When no plot is selected: Show Clean Helper Card */
                <div className="lm-deck-idle-container">
                  <div className="lm-deck-idle-card">
                    <p>Select any plot on the 2D map to inspect measurements, verify ownership, or upload registry deeds.</p>
                  </div>
                  <button
                    type="button"
                    className="lm-deck-view-table-btn"
                    onClick={() => setTab("list")}
                    data-testid="open-plot-list-status"
                  >
                    <List size={14} /> Open Full Plot Table
                  </button>
                </div>
              )}

              {/* Panel Footer */}
              <div className="lm-deck-footer">
                <span>
                  {overlay
                    ? `${isCadOverlay ? "CAD" : "PDF"} labels: ${overlay.plot_count ?? detectedPdfLabels} · Plots: ${data.plots.length}`
                    : `Showing ${filteredIds ? filteredIds.size : data.plots.length} / ${data.plots.length} plots`}
                </span>
              </div>
            </aside>
          )}
        </div>
      )}

      {settings && (
        <ColonySettingsModal colony={data.colony} onClose={() => setSettings(false)}
          onSaved={(c) => {
            if (c.import_summary) {
              const summary = c.import_summary;
              setImportNotice({
                boundaryOnly: summary.plot_geometry_updated === false,
                warnings: summary.warnings || [],
              });
              load();
            }
            else setData((d) => ({ ...d, colony: { ...d.colony, ...c } }));
            setSettings(false);
          }} />
      )}

      {editingPlot && selectedPlot && (
        <AdminPlotEditModal
          plot={selectedPlot}
          zones={data.zones || []}
          statuses={data.statuses || []}
          onClose={() => setEditingPlot(false)}
          onSaved={(updated) => {
            setSelectedPlot(updated);
            setData((d) => ({
              ...d,
              plots: (d.plots || []).map((p) => {
                const isTarget =
                  (updated.id && p.id === updated.id) ||
                  (updated._id && (p._id === updated._id || p.id === updated._id)) ||
                  (selectedPlot && (p.id === selectedPlot.id || p._id === selectedPlot._id || p._id === selectedPlot.id)) ||
                  (updated.number && String(p.number) === String(updated.number));
                return isTarget ? { ...p, ...updated } : p;
              }),
            }));
            setEditingPlot(false);
            load();
          }}
        />
      )}

      {showCsvModal && (
        <AdminPlotCsvModal
          colonyId={id}
          colonyName={data.colony?.name || "colony"}
          onClose={() => setShowCsvModal(false)}
          onImported={(newPlots) => {
            setData((d) => ({ ...d, plots: newPlots }));
            if (selectedPlot) {
              const found = newPlots.find(
                (p) => p.id === selectedPlot.id || String(p.number) === String(selectedPlot.number)
              );
              if (found) setSelectedPlot(found);
            }
          }}
        />
      )}

      {sharingPlot && selectedPlot && (
        <AdminShareModal
          plot={selectedPlot}
          onClose={() => setSharingPlot(false)}
        />
      )}

      {managingMedia && selectedPlot && (
        <AdminPlotMediaModal
          plot={selectedPlot}
          onClose={() => setManagingMedia(false)}
        />
      )}

      {managingOwnership && selectedPlot && (
        <AdminPlotOwnershipModal
          plot={selectedPlot}
          onClose={() => setManagingOwnership(false)}
          onOwnershipUpdated={() => load()}
        />
      )}

      {soldModalPlot && (
        <div className="lm-modal-shade" onClick={() => setSoldModalPlot(null)}>
          <div className="lm-modal" onClick={(e) => e.stopPropagation()} data-testid="complete-sale-modal">
            <div className="lm-modal-head">
              <h3>Complete Sale — Plot {soldModalPlot.number}</h3>
              <button type="button" className="lm-icon-btn" onClick={() => setSoldModalPlot(null)} data-testid="close-sold-modal"><X size={14} /></button>
            </div>
            <p className="lm-muted" style={{ marginBottom: "12px" }}>
              Current Status: <b>{statusesById[soldModalPlot.status_id]?.name || soldModalPlot.status_id}</b>
            </p>

            <div className="lm-locked" style={{ background: "#eff6ff", borderColor: "#bfdbfe", color: "#1e40af", marginBottom: "16px" }}>
              <Lock size={14} />
              <span>Registry document is required before this plot can be marked Sold.</span>
            </div>

            <label className={`lm-dropzone ${soldFile ? "has-file" : ""}`} style={{ padding: "16px", cursor: "pointer", border: "1px dashed var(--line)", borderRadius: "10px", textAlign: "center", display: "block" }}>
              <input type="file" accept="application/pdf" hidden data-testid="sold-modal-file-input" onChange={(e) => { const f = e.target.files?.[0]; if (f) setSoldFile(f); }} />
              <Upload size={20} style={{ margin: "0 auto 8px" }} />
              {soldFile ? (
                <><b>{soldFile.name}</b><small className="block text-xs text-slate-500">{Math.round(soldFile.size / 1024)} KB · Click to replace</small></>
              ) : (
                <><b>Upload Registry Document (.pdf)</b><small className="block text-xs text-slate-500">Attach the registered deed PDF to proceed with marking as Sold</small></>
              )}
            </label>

            {soldModalErr && <div className="lm-error" style={{ marginTop: "12px" }} data-testid="sold-modal-error">{soldModalErr}</div>}

            <div style={{ display: "flex", gap: "10px", marginTop: "20px" }}>
              <button type="button" className="lm-btn-ghost flex-1" onClick={() => setSoldModalPlot(null)} data-testid="cancel-sold-btn">Cancel</button>
              <button type="button" className="lm-btn-primary flex-1" disabled={soldSubmitting || (!soldFile && (selectedPlot?.id === soldModalPlot.id ? registry.length : (soldModalPlot.registry_count || 0)) === 0)}
                onClick={handleSoldSubmit} data-testid="submit-sold-btn">
                {soldSubmitting ? "Saving & Marking Sold…" : "Upload & Mark Sold"}
              </button>
            </div>
          </div>
        </div>
      )}
      {showDataUsed && (
        <ColonyDataUsedModal
          colony={{ ...data.colony, plots: data.plots }}
          onClose={() => setShowDataUsed(false)}
        />
      )}
      {showPlacementModal && (
        <PlacementCalibrationModal
          colony={data.colony}
          plots={data.plots}
          roads={data.colony?.roads || []}
          greens={data.colony?.greens || []}
          onClose={() => setShowPlacementModal(false)}
          onConfirmed={() => load()}
        />
      )}
    </div>
  );
}
