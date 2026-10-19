import React, { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api, errMsg } from "@/lib/api";
import { usePortalBase } from "@/lib/portal";
import {
  Upload, FileText, CheckCircle2, AlertTriangle, ArrowRight, ArrowLeft,
  MapPin, Layers, Settings2, ShieldCheck, XCircle, Check
} from "lucide-react";
import InteractiveMap from "@/components/InteractiveMap";

export default function AdminGisImportPreview() {
  const { colonyId, importId: paramImportId } = useParams();
  const navigate = useNavigate();
  const base = usePortalBase();

  const [colony, setColony] = useState(null);
  const [importSession, setImportSession] = useState(null);
  const [step, setStep] = useState(1); // 1: Upload, 2: Parsing, 3: Preview, 4: Validate, 5: Commit
  const [importMode, setImportMode] = useState("qgis");
  const [secondaryType, setSecondaryType] = useState("kml");
  const [sourceFile, setSourceFile] = useState(null);
  const [pdfFile, setPdfFile] = useState(null);
  const [companionFile, setCompanionFile] = useState(null);
  const [mapsLink, setMapsLink] = useState("");
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const [validating, setValidating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [previewSelectedPlot, setPreviewSelectedPlot] = useState(null);

  // Load colony details
  useEffect(() => {
    if (colonyId) {
      api.get(`/admin/colonies/${colonyId}`)
        .then((r) => setColony(r.data.colony))
        .catch((e) => setErr(errMsg(e)));
    }
  }, [colonyId]);

  // Load existing import session if importId is present
  useEffect(() => {
    if (paramImportId) {
      api.get(`/admin/gis-imports/${paramImportId}`)
        .then((r) => {
          setImportSession(r.data);
          if (r.data.status === "PREVIEW_READY") setStep(3);
          else if (r.data.status === "CALIBRATED") setStep(3);
          else if (r.data.status === "VALIDATED") setStep(4);
          else if (r.data.status === "COMMITTED") setStep(5);
        })
        .catch((e) => setErr(errMsg(e)));
    }
  }, [paramImportId]);

  // Handle File Upload & Parsing Trigger
  const handleUpload = async (e) => {
    e.preventDefault();
    if ((importMode === "qgis" && !sourceFile) ||
        (importMode === "pdf_pair" && (!pdfFile || !companionFile))) {
      setErr(importMode === "qgis"
        ? "Select a QGIS GeoJSON or GeoPackage file"
        : "Select both the PDF layout and the selected DWG/KML companion file");
      return;
    }
    setErr("");
    setUploading(true);
    setStep(2); // Parsing

    try {
      const fd = new FormData();
      fd.append("import_mode", importMode);
      if (importMode === "qgis") {
        fd.append("file", sourceFile);
      } else {
        fd.append("layout_pdf", pdfFile);
        fd.append("cad_file", companionFile);
      }
      if (mapsLink) fd.append("maps_link", mapsLink);

      const res = await api.post(`/admin/colonies/${colonyId}/gis-imports`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120000,
      });

      // Fetch full preview details
      const fullRes = await api.get(`/admin/gis-imports/${res.data.id}`);
      setImportSession(fullRes.data);
      setStep(3); // Preview Ready
    } catch (ex) {
      setErr(errMsg(ex));
      setStep(1);
    } finally {
      setUploading(false);
    }
  };

  // Handle Validation Action
  const handleValidate = async () => {
    if (!importSession) return;
    setValidating(true);
    setErr("");

    try {
      const res = await api.post(`/admin/gis-imports/${importSession.id}/validate`);
      setImportSession((s) => ({ ...s, validation: res.data.validation, status: res.data.status }));
      setStep(4);
    } catch (ex) {
      setErr(errMsg(ex));
    } finally {
      setValidating(false);
    }
  };

  // Handle Production Commit Action
  const handleCommit = async () => {
    if (!importSession) return;
    if (!window.confirm("Confirm production commit? This will write preview plots and zones to the colony map.")) return;

    setCommitting(true);
    setErr("");

    try {
      const res = await api.post(`/admin/gis-imports/${importSession.id}/commit`);
      setImportSession((s) => ({ ...s, status: "COMMITTED", committed_at: res.data.committed_at }));
      setStep(5);
    } catch (ex) {
      setErr(errMsg(ex));
    } finally {
      setCommitting(false);
    }
  };

  // Handle Cancel Action
  const handleCancel = async () => {
    if (!importSession) {
      navigate(`${base}/colonies/${colonyId}`);
      return;
    }
    if (window.confirm("Cancel this import session? Preview data will be discarded.")) {
      try {
        await api.post(`/admin/gis-imports/${importSession.id}/cancel`);
        navigate(`${base}/colonies/${colonyId}`);
      } catch (ex) {
        setErr(errMsg(ex));
      }
    }
  };

  const preview = importSession?.preview_data || {};
  const stats = preview.stats || {};
  const validation = importSession?.validation || {};
  const previewMapData = preview.fields ? {
    colony: {
      ...colony,
      ...preview.fields,
      pdf_overlay: preview.pdf_overlay?.url ? preview.pdf_overlay : null,
    },
    plots: preview.plots || [],
    zones: preview.zones || [],
    statuses: [],
  } : null;

  return (
    <div className="space-y-6 max-w-6xl mx-auto p-4 sm:p-6 text-[#172A25]">
      {/* HEADER */}
      <div className="flex items-center justify-between border-b border-[#E8E2D6] pb-4">
        <div>
          <div className="text-xs uppercase font-mono tracking-wider text-[#6B7280]">GIS LAYOUT IMPORT WORKFLOW</div>
          <h1 className="text-2xl font-bold font-serif text-[#172A25]">{colony?.name || "Colony Layout Import"}</h1>
        </div>
        <button
          onClick={handleCancel}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-500/30 text-red-600 hover:bg-red-500/10 transition-all flex items-center gap-1"
        >
          Cancel Import
        </button>
      </div>

      {/* STEP PROGRESS INDICATOR */}
      <div className="grid grid-cols-5 gap-2 text-center text-xs font-mono font-semibold">
        <div className={`p-2.5 rounded-lg border ${step >= 1 ? "bg-[#173F35]/10 border-[#173F35] text-[#173F35] font-bold" : "opacity-40 border-[#E8E2D6]"}`}>
          ① Upload
        </div>
        <div className={`p-2.5 rounded-lg border ${step >= 2 ? "bg-[#173F35]/10 border-[#173F35] text-[#173F35] font-bold" : "opacity-40 border-[#E8E2D6]"}`}>
          ② Parse
        </div>
        <div className={`p-2.5 rounded-lg border ${step >= 3 ? "bg-[#173F35]/10 border-[#173F35] text-[#173F35] font-bold" : "opacity-40 border-[#E8E2D6]"}`}>
          ③ Preview
        </div>
        <div className={`p-2.5 rounded-lg border ${step >= 4 ? "bg-[#173F35]/10 border-[#173F35] text-[#173F35] font-bold" : "opacity-40 border-[#E8E2D6]"}`}>
          ④ Validate
        </div>
        <div className={`p-2.5 rounded-lg border ${step >= 5 ? "bg-[#047857]/15 border-[#047857] text-[#047857] font-bold" : "opacity-40 border-[#E8E2D6]"}`}>
          ⑤ Commit
        </div>
      </div>

      {err && (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-600 text-xs font-mono">
          {err}
        </div>
      )}

      {/* STEP 1: SOURCE FILE UPLOAD */}
      {step === 1 && (
        <form onSubmit={handleUpload} className="neo-card p-8 space-y-6">
          <div className="text-center space-y-2">
            <h2 className="text-lg font-serif font-bold">Choose land mapping method</h2>
            <p className="text-xs opacity-60">Option 1: a QGIS export. Option 2: PDF + KML (PDF parcels, KML boundary check) or PDF + DWG (DWG parcels, PDF label check).</p>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs">
              <input type="radio" name="gis-import-mode" checked={importMode === "qgis"} onChange={() => setImportMode("qgis")} />
              Option 1 · QGIS export (GeoJSON / GeoPackage)
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="radio" name="gis-import-mode" checked={importMode === "pdf_pair"} onChange={() => setImportMode("pdf_pair")} />
              Option 2 · PDF layout + one companion file
            </label>
          </div>

          {importMode === "qgis" ? (
            <label className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-6 text-center space-y-3 block hover:border-violet-500 transition-colors">
              <Upload className="mx-auto text-violet-500" size={32} />
              <input type="file" accept=".geojson,.json,.gpkg,application/geo+json"
                onChange={(e) => setSourceFile(e.target.files?.[0] || null)} className="hidden" />
              <span className="cursor-pointer text-xs font-semibold text-violet-500 hover:underline block">
                {sourceFile ? sourceFile.name : "Choose QGIS GeoJSON or GeoPackage"}
              </span>
              <small className="block text-[11px] opacity-60">Export layers in WGS84 / EPSG:4326 with plot polygons and plot-number attributes.</small>
            </label>
          ) : (
            <>
              <label className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-6 text-center space-y-3 block">
                <FileText className="mx-auto text-amber-500" size={32} />
                <input type="file" accept=".pdf,application/pdf" onChange={(e) => setPdfFile(e.target.files?.[0] || null)} className="hidden" />
                <span className="cursor-pointer text-xs font-semibold text-amber-500 block">{pdfFile ? pdfFile.name : "Choose PDF layout"}</span>
              </label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="text-xs">Companion format
                  <select value={secondaryType} onChange={(e) => { setSecondaryType(e.target.value); setCompanionFile(null); }}
                    className="w-full mt-1 px-3 py-2 rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700">
                    <option value="kml">KML (supported georeferenced layer)</option>
                    <option value="dwg">DWG (converted by Python GIS worker)</option>
                  </select>
                </label>
                <label className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-4 text-center block">
                  <Upload className="mx-auto text-violet-500" size={24} />
                  <input type="file" accept={secondaryType === "kml" ? ".kml,application/vnd.google-earth.kml+xml" : ".dwg"}
                    onChange={(e) => setCompanionFile(e.target.files?.[0] || null)} className="hidden" />
                  <span className="cursor-pointer text-xs font-semibold block">{companionFile ? companionFile.name : `Choose ${secondaryType.toUpperCase()}`}</span>
                </label>
              </div>
              <div className="p-3 neo-inset rounded-lg text-[11px] opacity-70 text-center">
                {secondaryType === "kml"
                  ? "The PDF page is shown as a cropped image visually fitted to the saved land boundary. KML supplies the clipping outline; this temporary overlay does not georeference individual PDF plots."
                  : "DWG vectors provide plot geometry and are processed separately from PDF geometry; the PDF checks plot labels only. The Python GIS worker requires ODA File Converter."}
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-semibold mb-1 opacity-70">Google Maps Pin Link (Optional)</label>
            <input
              type="text"
              placeholder="e.g. https://maps.app.goo.gl/..."
              value={mapsLink}
              onChange={(e) => setMapsLink(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg neo-input bg-transparent border border-gray-300 dark:border-gray-700"
            />
          </div>

          <button
            type="submit"
            disabled={(importMode === "qgis" ? !sourceFile : (!pdfFile || !companionFile)) || uploading}
            className="w-full neo-btn-primary text-xs py-3 font-semibold flex items-center justify-center gap-2"
          >
            Start GIS Import & Preview Process <ArrowRight size={16} />
          </button>
        </form>
      )}

      {/* STEP 2: PARSING */}
      {step === 2 && (
        <div className="neo-card p-12 text-center space-y-4">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-violet-500 border-t-transparent" />
          <h2 className="text-lg font-serif font-bold">Parsing GIS Drawing Geometry...</h2>
          <p className="text-xs opacity-60 font-mono">Extracting linework, plot boundaries, zones, and texts</p>
        </div>
      )}

      {/* STEP 3 & 4: PREVIEW & VALIDATION */}
      {step >= 3 && step <= 4 && (
        <div className="space-y-6">
          {/* DETECTED GEOMETRY SUMMARY CARDS */}
          <div className="grid grid-cols-4 gap-4 text-center">
            <div className="neo-card p-4 space-y-1">
              <div className="text-[10px] uppercase font-semibold opacity-60">
                {stats.detected_pdf_labels !== undefined ? "PDF Labels / Saved Plots" : "Detected Plots"}
              </div>
              <div className="text-2xl font-bold font-mono text-violet-500">
                {stats.detected_pdf_labels !== undefined
                  ? `${stats.detected_pdf_labels} / ${stats.saved_plot_records || 0}`
                  : stats.plots_count || 0}
              </div>
              {stats.interactive_pdf_regions !== undefined && (
                <div className="text-[10px] opacity-60">
                  {stats.interactive_pdf_regions} heuristic map regions
                </div>
              )}
            </div>
            <div className="neo-card p-4 space-y-1">
              <div className="text-[10px] uppercase font-semibold opacity-60">Detected Zones</div>
              <div className="text-2xl font-bold font-mono">{stats.zones_count || 0}</div>
            </div>
            <div className="neo-card p-4 space-y-1">
              <div className="text-[10px] uppercase font-semibold opacity-60">Road Segments</div>
              <div className="text-2xl font-bold font-mono text-blue-500">{stats.roads_count || 0}</div>
            </div>
            <div className="neo-card p-4 space-y-1">
              <div className="text-[10px] uppercase font-semibold opacity-60">Green Spaces</div>
              <div className="text-2xl font-bold font-mono text-emerald-500">{stats.greens_count || 0}</div>
            </div>
          </div>

          {previewMapData && (
            <div className="neo-card overflow-hidden" style={{ height: 520 }}>
              <InteractiveMap
                data={previewMapData}
                selectedPlot={previewSelectedPlot}
                setSelectedPlot={setPreviewSelectedPlot}
                selectedZone={null}
                setSelectedZone={() => {}}
                resetKey={importSession?.id}
                showStatus={false}
              />
            </div>
          )}

          {/* Validate the geometry already positioned by the importer */}
          {step === 3 && (
            <div className="neo-card p-6 flex items-center justify-between">
              <div>
                <h3 className="font-serif font-bold text-base">Preview Ready</h3>
                <p className="text-xs opacity-60">Review the imported geometry, then validate it before committing.</p>
              </div>
              <button
                onClick={handleValidate}
                disabled={validating}
                className="neo-btn-primary text-xs px-4 py-2 flex items-center gap-1.5"
              >
                {validating ? "Validating..." : "Run Validation Check"} <ArrowRight size={14} />
              </button>
            </div>
          )}

          {step === 4 && (
            <div className="neo-card p-6 space-y-4">
              <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 pb-3">
                <h3 className="font-serif font-bold text-base">Validation Summary</h3>
                <span className={`text-xs font-mono font-bold px-2.5 py-1 rounded ${
                  validation.is_valid ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"
                }`}>
                  {validation.is_valid ? "VALIDATION PASSED" : "VALIDATION FAILED"}
                </span>
              </div>

              {validation.errors?.length > 0 && (
                <div className="p-3 neo-inset rounded-lg space-y-1 text-xs text-red-500">
                  <div className="font-bold">Errors:</div>
                  <ul className="list-disc list-inside space-y-0.5">
                    {validation.errors.map((e, idx) => <li key={idx}>{e}</li>)}
                  </ul>
                </div>
              )}

              {validation.warnings?.length > 0 && (
                <div className="p-3 neo-inset rounded-lg space-y-1 text-xs text-amber-500">
                  <div className="font-bold">Warnings:</div>
                  <ul className="list-disc list-inside space-y-0.5">
                    {validation.warnings.map((w, idx) => <li key={idx}>{w}</li>)}
                  </ul>
                </div>
              )}

              <button
                onClick={handleCommit}
                disabled={!validation.is_valid || committing}
                className="w-full neo-btn-primary text-xs py-3 font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
              >
                {committing ? "Committing to Production..." : "Commit GIS Import to Production Colony"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* STEP 5: COMMITTED SUCCESS STATE */}
      {step === 5 && (
        <div className="neo-card p-12 text-center space-y-4">
          <CheckCircle2 className="mx-auto text-emerald-500" size={48} />
          <h2 className="text-xl font-serif font-bold text-emerald-500">GIS Import Committed to Production</h2>
          <p className="text-xs opacity-70">
            Preview plot polygons and zones have been safely written to the colony map database.
          </p>
          <Link
            to={`${base}/colonies/${colonyId}`}
            className="inline-flex items-center gap-2 neo-btn-primary text-xs px-6 py-2.5 font-semibold"
          >
            Open Colony Production Map <ArrowRight size={14} />
          </Link>
        </div>
      )}
    </div>
  );
}
