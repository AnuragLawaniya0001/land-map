import React from "react";
import { X, CheckCircle2, AlertTriangle, FileText, Database, ShieldCheck, Layers, Cpu, ArrowUpRight, BarChart2 } from "lucide-react";

export default function ColonyDataUsedModal({ colony, onClose }) {
  if (!colony) return null;

  const importSource = colony.import_source || {};
  const sources = importSource.sources || {};
  const validation = importSource.validation || {};
  const registrationMetrics = importSource.registration_metrics || importSource.diagnostics || {};
  const plotFootprintRatio = Number.isFinite(registrationMetrics.plot_footprint_ratio)
    ? Math.round(registrationMetrics.plot_footprint_ratio * 100)
    : null;
  const mode = importSource.mode || "qgis_direct";
  const warnings = importSource.warnings || validation.warnings || [];
  const detectedLabelCount = registrationMetrics.detected_label_count
    ?? registrationMetrics.detected_plot_label_count
    ?? importSource.pdf_plot_count
    ?? null;
  const recoveredPlotCount = registrationMetrics.recovered_plot_count
    ?? importSource.plots
    ?? null;
  const persistedPlotCount = Number.isFinite(colony.plot_count)
    ? colony.plot_count
    : Array.isArray(colony.plots)
      ? colony.plots.length
      : null;
  const registrationIou = Number.isFinite(registrationMetrics.iou)
    ? Math.round(registrationMetrics.iou * 100)
    : null;
  const labelMatchCount = Number.isFinite(validation.pdf_plot_number_matches)
    ? validation.pdf_plot_number_matches
    : null;
  const labelMatchRate = labelMatchCount !== null && Number.isFinite(detectedLabelCount) && detectedLabelCount > 0
    ? Math.round((labelMatchCount / detectedLabelCount) * 100)
    : null;
  const boundaryCoverage = Number.isFinite(validation.kml_contained_plot_coverage)
    ? Math.round(validation.kml_contained_plot_coverage * 100)
    : Number.isFinite(validation.kml_land_boundary_overlap)
      ? Math.round(validation.kml_land_boundary_overlap * 100)
      : null;

  const hasGeojson = Boolean(sources.geojson && sources.geojson.trim());
  const hasPdf = Boolean(sources.pdf || importSource.reference_filename || sources.plot_geometry === "pdf_recovered_plot_parcels" || (importSource.filename && importSource.filename.toLowerCase().endsWith(".pdf")));
  const hasCompanion = Boolean(sources.companion || (importSource.filename && (importSource.filename.toLowerCase().endsWith(".kml") || importSource.filename.toLowerCase().endsWith(".dwg"))) || mode.includes("kml") || mode.includes("dwg"));

  // Build File Usage List
  const fileUsageList = [
    {
      type: "GeoJSON Mapping Source",
      ext: ".geojson / .json",
      filename: hasGeojson ? sources.geojson : "Not Uploaded (Optional)",
      uploaded: hasGeojson,
      purpose: "Provided WGS84 plot polygons, EPSG:4326 spatial coordinates, and plot label points.",
      role: hasGeojson
        ? (sources.plot_geometry === "geojson_plot_polygons" ? "Primary Plot Polygons & Spatial Index" : "Plot Label Reference Points")
        : "Not Used (PDF Vector Extraction Active)",
      accuracyImpact: hasGeojson ? "Geometry source supplied; CRS and accuracy require validation." : "Not provided",
    },
    {
      type: "PDF Layout Plan",
      ext: ".pdf",
      filename: sources.pdf || importSource.reference_filename || (importSource.filename && importSource.filename.toLowerCase().endsWith(".pdf") ? importSource.filename : "colony_layout.pdf"),
      uploaded: hasPdf,
      purpose: "Extracted high-resolution vector drawing lines for plot parcel recovery & plot label cross-check.",
      role: sources.plot_geometry === "pdf_recovered_plot_parcels"
        ? "Recovered Plot Parcels & Vector Alignment"
        : "Plot Label Cross-Check & Geometry Verification",
      accuracyImpact: labelMatchCount !== null && detectedLabelCount !== null
        ? `Label matches: ${labelMatchCount}/${detectedLabelCount}${labelMatchRate !== null ? ` (${labelMatchRate}%)` : ""}`
        : "Label and parcel-boundary matching not fully evaluated.",
    },
    {
      type: "KML / DWG Companion",
      ext: ".kml / .dwg",
      filename: sources.companion || (importSource.filename && (importSource.filename.toLowerCase().endsWith(".kml") || importSource.filename.toLowerCase().endsWith(".dwg")) ? importSource.filename : "boundary.kml"),
      uploaded: hasCompanion,
      purpose: (sources.companion || "").toLowerCase().endsWith(".dwg") || mode.includes("dwg")
        ? "Converted DWG CAD drawing for direct parcel polygon vector extraction."
        : "Georeferenced Google Earth site boundary & land containment verification.",
      role: mode.includes("dwg")
        ? "CAD Plot Parcel Source"
        : (sources.plot_geometry === "kml_plot_polygons" ? "Primary KML Plot Parcels & Spatial Index" : "Land Boundary & Containment Verification"),
      accuracyImpact: registrationIou !== null
        ? `Outer-shape IoU: ${registrationIou}% (not survey accuracy)`
        : "Boundary source; positional accuracy not evaluated.",
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto space-y-6 text-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-violet-500/10 text-violet-400 border border-violet-500/20">
              <Database size={22} />
            </div>
            <div>
              <h2 className="text-xl font-bold font-serif tracking-tight">Sources & Reconstruction Evidence</h2>
              <p className="text-xs text-slate-400">Recorded extraction counts and geometry-fit diagnostics; missing evidence is not treated as a pass</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition"
            data-testid="data-used-close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Measured evidence only; neither a fit score nor a label match rate is survey accuracy. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className={`p-4 rounded-xl border flex flex-col justify-between ${
            registrationIou === null
              ? "bg-slate-800/60 border-slate-700/60 text-slate-300"
              : registrationIou >= 85
                ? "bg-amber-500/10 border-amber-500/30 text-amber-200"
                : "bg-red-500/10 border-red-500/30 text-red-200"
          }`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider opacity-80">Boundary-fit IoU</span>
              <ShieldCheck size={18} />
            </div>
            <div className="mt-2">
              <div className="text-3xl font-black font-mono tracking-tight">
                {registrationIou === null ? "Not evaluated" : `${registrationIou}%`}
              </div>
              <p className="text-[11px] opacity-90 mt-0.5">Shape overlap only; not positional accuracy</p>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-800/60 border border-slate-700/60 flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-xs font-bold uppercase tracking-wider">Geometry counts</span>
              <BarChart2 size={18} className="text-violet-400" />
            </div>
            <div className="mt-2">
              <p className="text-sm font-mono text-white">
                {detectedLabelCount ?? "—"} labels detected
              </p>
              <p className="text-sm font-mono text-white">
                {recoveredPlotCount ?? "—"} recovered / {persistedPlotCount ?? "—"} persisted
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                {labelMatchCount === null ? "Label-to-parcel match: not evaluated" : `Matched labels: ${labelMatchCount}${labelMatchRate !== null ? ` (${labelMatchRate}%)` : ""}`}
              </p>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-800/60 border border-slate-700/60 flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-xs font-bold uppercase tracking-wider">Boundary Method</span>
              <Layers size={18} className="text-cyan-400" />
            </div>
            <div className="mt-2">
              <div className="text-xs font-bold text-cyan-300 truncate">
                {importSource.land_boundary_method
                  ? importSource.land_boundary_method.replace(/_/g, " ")
                  : mode.includes("kml")
                    ? "KML Site Outline"
                    : "Explicit Site Boundary"}
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {boundaryCoverage === null ? "Plot containment: not evaluated" : `${boundaryCoverage}% plot containment`}
              </p>
              {plotFootprintRatio !== null && (
                <p className={`text-[11px] mt-0.5 ${plotFootprintRatio < 10 ? "text-amber-300" : "text-slate-400"}`}>
                  Plot parcels cover {plotFootprintRatio}% of the land
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Files Uploaded & Use Case Table */}
        <div className="space-y-3">
          <h3 className="text-xs uppercase font-bold tracking-wider text-violet-400 flex items-center gap-1.5">
            <FileText size={14} /> Uploaded Files & Usage Breakdown
          </h3>
          <div className="space-y-2.5">
            {fileUsageList.map((file, idx) => (
              <div
                key={idx}
                className={`p-3.5 rounded-xl border transition-all ${
                  file.uploaded
                    ? "bg-slate-800/80 border-slate-700/80"
                    : "bg-slate-950/40 border-slate-800/40 opacity-50"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-slate-100">{file.type}</span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-700/50 text-slate-300 border border-slate-600/40">
                        {file.ext}
                      </span>
                      {file.uploaded ? (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                          <CheckCircle2 size={10} /> Used
                        </span>
                      ) : (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                          Not Provided
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-300 font-mono">
                      File: {file.filename || "No file uploaded"}
                    </p>
                    <p className="text-xs text-slate-400 pt-1">
                      <strong className="text-slate-300">Purpose & Usage:</strong> {file.purpose}
                    </p>
                  </div>
                  {file.uploaded && (
                    <div className="text-right text-xs shrink-0 bg-violet-500/10 border border-violet-500/20 rounded-lg p-2 space-y-0.5">
                      <div className="text-[10px] uppercase font-bold text-violet-300">{file.role}</div>
                      <div className="text-[11px] font-mono text-emerald-400">{file.accuracyImpact}</div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Pipeline Execution Details */}
        <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-800 space-y-2 text-xs">
          <div className="flex items-center justify-between text-slate-300 font-medium">
            <span className="flex items-center gap-1.5 text-violet-400 font-semibold">
              <Cpu size={14} /> Pipeline Execution Mode
            </span>
            <span className="font-mono bg-slate-800 px-2 py-0.5 rounded border border-slate-700 text-slate-200">
              {mode}
            </span>
          </div>
          <div className="flex items-center justify-between text-slate-400 pt-1 border-t border-slate-800">
            <span>Import Timestamp</span>
            <span className="font-mono text-slate-300">{importSource.imported_at ? new Date(importSource.imported_at).toLocaleString() : "Live Active"}</span>
          </div>
          <div className="flex items-center justify-between text-slate-400">
            <span>Plot Geometry Source</span>
            <span className="font-mono text-emerald-400">{sources.plot_geometry || "QGIS Polygons"}</span>
          </div>
        </div>

        {/* Warnings Section if present */}
        {warnings.length > 0 && (
          <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 space-y-1.5 text-xs">
            <div className="flex items-center gap-1.5 font-semibold text-amber-400">
              <AlertTriangle size={15} /> System Warnings & Discrepancies ({warnings.length})
            </div>
            <ul className="list-disc list-inside space-y-1 text-[11px] text-amber-200/80">
              {warnings.map((w, idx) => (
                <li key={idx}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer */}
        <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span>Importer diagnostics are evidence, not proof of survey accuracy. Unmeasured values remain unevaluated.</span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-medium transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
