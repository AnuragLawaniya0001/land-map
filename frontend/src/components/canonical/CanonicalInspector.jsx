/**
 * Canonical Detail Inspector Panel.
 *
 * Provides exhaustive inspection for selected plots and roads, strictly separating
 * source-declared measurements from geometry-derived values, and showing complete
 * provenance, topology, and QA validation evidence.
 */

import { useState, useEffect } from "react";
import { formatMeasurement, CANONICAL_THEME } from "@/lib/canonicalGeo";
import { api } from "@/lib/api";
import {
  FileText,
  Compass,
  AlertTriangle,
  CheckCircle,
  HelpCircle,
  Link2,
  Maximize,
  Layers,
  Ruler,
  Info,
  X,
  Edit3,
  Check,
} from "lucide-react";

export default function CanonicalInspector({
  selectedPlot,
  selectedRoad,
  selectedLandUse,
  onClose,
  onSelectNeighbor,
  colonyName = "",
  datasetVersion = 1,
  isReviewMode = false,
  colonyId,
  onRefreshData,
}) {
  const [editNumber, setEditNumber] = useState("");
  const [editStatus, setEditStatus] = useState("review_required");
  const [editReason, setEditReason] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editFeedback, setEditFeedback] = useState(null);

  useEffect(() => {
    if (selectedPlot) {
      setEditNumber(selectedPlot.original_number || selectedPlot.number || "");
      setEditStatus(selectedPlot.semantic_validation_status || "review_required");
      setEditReason("");
      setEditFeedback(null);
    }
  }, [selectedPlot?.id]);
  if (!selectedPlot && !selectedRoad && !selectedLandUse) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center text-slate-400 bg-white border-l border-slate-200">
        <Compass className="w-12 h-12 text-slate-300 mb-3" />
        <h3 className="text-sm font-semibold text-slate-600 mb-1">Entity Inspector</h3>
        <p className="text-xs text-slate-400 max-w-xs leading-relaxed">
          Click any plot or road on the colony map to inspect available measurements,
          topology, QA issues, and source provenance.
        </p>
      </div>
    );
  }

  if (selectedLandUse) {
    const feature = selectedLandUse;
    const status = feature.validation_status || "review_required";
    const statusClass = status === "verified"
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : status === "conflicted"
        ? "bg-red-100 text-red-800 border-red-300"
        : "bg-amber-100 text-amber-800 border-amber-300";
    return (
      <div className="h-full flex flex-col bg-white border-l border-slate-200 shadow-lg overflow-y-auto">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div>
            <span className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
              Imported Land Use
            </span>
            <h2 className="text-base font-bold text-slate-800">
              {feature.name || feature.source_label || "Unlabeled open-space feature"}
            </h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-200 rounded text-slate-500" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 text-xs">
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 space-y-2">
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Feature class:</span>
              <span className="text-slate-700">{feature.feature_class || "Not classified"}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Review status:</span>
              <span className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${statusClass}`}>
                {status}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Stable feature ID:</span>
              <span className="font-mono text-slate-700 break-all">{feature.id}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Geometry:</span>
              <span className="font-mono text-slate-700">{feature.geometry?.type || "Unknown"}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-slate-500">Source / page:</span>
              <span className="font-mono text-slate-700">
                {feature.source_document_id || feature.source_filename || "Not recorded"}
                {feature.source_page ? ` / ${feature.source_page}` : ""}
              </span>
            </div>
          </div>
          {Array.isArray(feature.source_evidence) && feature.source_evidence.length > 0 ? (
            <div>
              <h3 className="font-semibold text-slate-700 mb-1">Source evidence</h3>
              <ul className="list-disc list-inside text-slate-600 space-y-1">
                {feature.source_evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}
              </ul>
            </div>
          ) : (
            <p className="text-slate-500">
              Geometry was imported from the colony land-use layer. Detailed page provenance,
              measurement and classification confidence were not recorded.
            </p>
          )}
          {feature.is_provisional_legacy && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900">
              This legacy feature is displayed for review and has not been verified.
            </p>
          )}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // ROAD INSPECTOR
  // ---------------------------------------------------------------------------
  if (selectedRoad) {
    const roadCrs = selectedRoad.crs_metadata || {};
    const roadLengthMethod = selectedRoad.provenance?.derived_measurements?.length_method;
    const roadMeasurementsSupported =
      selectedRoad.provenance?.derived_width_method === "area_perimeter_approximation" &&
      (
        roadCrs.units === "m" ||
        Number(roadCrs.scale_ratio) > 0 ||
        (roadCrs.units === "deg" && roadLengthMethod === "WGS84 ellipsoidal length")
      );
    const roadStatus = selectedRoad.validation_status || "review_required";
    return (
      <div className="h-full flex flex-col bg-white border-l border-slate-200 shadow-lg overflow-y-auto">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div>
            <span className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
              Road Corridor
            </span>
            <h2 className="text-base font-bold text-slate-800">
              {selectedRoad.source_label || "Unnamed Road"}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-slate-200 rounded text-slate-500"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 text-xs">
          {/* Identity & Status */}
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 space-y-1.5">
            <div className="flex justify-between">
              <span className="text-slate-500">Road ID:</span>
              <span className="font-mono text-slate-700">{selectedRoad.id}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-500">Status:</span>
              <span className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                roadStatus === "verified"
                  ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                  : roadStatus === "conflicted"
                    ? "bg-red-100 text-red-800 border-red-300"
                    : "bg-amber-100 text-amber-800 border-amber-300"
              }`}>
                {roadStatus}
              </span>
            </div>
          </div>

          {/* Width Measurements */}
          <div className="space-y-2">
            <h4 className="font-semibold text-slate-700 flex items-center gap-1.5">
              <Ruler className="w-3.5 h-3.5 text-blue-600" />
              Width Measurements
            </h4>
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2.5 bg-blue-50/50 rounded-lg border border-blue-100">
                <span className="text-[10px] text-blue-700 font-medium block">
                  Declared (Drawing)
                </span>
                <span className="text-sm font-bold text-blue-900">
                  {formatMeasurement(
                    selectedRoad.declared_width_m,
                    selectedRoad.declared_width_m != null ? "m" : ""
                  )}
                </span>
                {selectedRoad.declared_width_raw && (
                  <span className="text-[10px] text-slate-500 block mt-0.5">
                    Printed: "{selectedRoad.declared_width_raw}"
                  </span>
                )}
              </div>
              <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                <span className="text-[10px] text-slate-600 font-medium block">
                  Derived (Geometry)
                </span>
                <span className="text-sm font-bold text-slate-800">
                  {formatMeasurement(
                    roadMeasurementsSupported ? selectedRoad.derived_width_m : null,
                    "m"
                  )}
                </span>
                <span className="text-[10px] text-slate-500 block mt-0.5">
                  {selectedRoad.provenance?.derived_width_method === "area_perimeter_approximation"
                    ? "Area/perimeter approximation"
                    : "Only shown when its source CRS supports metric calculation"}
                </span>
              </div>
            </div>
          </div>

          {/* Connected Plots */}
          {selectedRoad.adjacent_plot_ids?.length > 0 && (
            <div className="space-y-1.5">
              <h4 className="font-semibold text-slate-700 flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-slate-500" />
                Adjacent Plots ({selectedRoad.adjacent_plot_ids.length})
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {selectedRoad.adjacent_plot_ids.map((pid) => (
                  <button
                    key={pid}
                    onClick={() => onSelectNeighbor(pid)}
                    className="px-2 py-1 bg-slate-100 hover:bg-blue-100 hover:text-blue-700 text-slate-700 rounded text-[11px] font-mono transition"
                  >
                    {pid}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // PLOT INSPECTOR
  // ---------------------------------------------------------------------------
  const plot = selectedPlot;
  const plotStatus = plot.semantic_validation_status || "review_required";
  const plotCrs = plot.crs_metadata || {};
  const derivedMethods = plot.provenance?.derived_measurements || {};
  const derivedMeasurementsSupported =
    plotCrs.units === "m" ||
    Number(plotCrs.scale_ratio) > 0 ||
    (plotCrs.units === "deg" &&
      derivedMethods.area_method === "WGS84 ellipsoidal area" &&
      derivedMethods.length_method === "WGS84 ellipsoidal length");
  const derivedAreaSupported =
    plotCrs.units !== "deg" || derivedMethods.area_method === "WGS84 ellipsoidal area";
  const derivedLengthSupported =
    plotCrs.units !== "deg" || derivedMethods.length_method === "WGS84 ellipsoidal length";
  const statusTheme = plotStatus === "verified"
    ? CANONICAL_THEME.verified
    : plotStatus === "conflicted"
      ? CANONICAL_THEME.conflicted
      : CANONICAL_THEME.reviewRequired;

  return (
    <div className="h-full flex flex-col bg-white border-l border-slate-200 shadow-lg overflow-y-auto">
      {/* Header */}
      <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
        <div>
          <span className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
            Colony Plot Record
          </span>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <span>{plot.original_number || plot.number || "Unlabeled"}</span>
            {plot.normalized_number && plot.normalized_number !== plot.original_number && (
              <span className="text-xs font-normal text-slate-500">
                (Norm: {plot.normalized_number})
              </span>
            )}
          </h2>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-slate-200 rounded text-slate-500"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-4 text-xs">
        {/* Status Badge & Basic Info */}
        <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 space-y-1.5">
          <div className="flex justify-between items-center">
            <span className="text-slate-500 font-medium">Validation Status:</span>
            <span
              className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${statusTheme.badgeBg}`}
            >
              {plotStatus}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500 font-medium">Canonical ID:</span>
            <span className="font-mono text-slate-700">{plot.id}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500 font-medium">Dataset Version:</span>
            <span className="font-mono text-slate-700">v{plot.dataset_version || datasetVersion}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500 font-medium">Source Document:</span>
            <span className="font-mono text-slate-700">{plot.source_document_id || "Not recorded"}</span>
          </div>
          {plot.source_page != null && (
            <div className="flex justify-between">
              <span className="text-slate-500 font-medium">Source Page:</span>
              <span className="font-mono text-slate-700">{plot.source_page}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-slate-500 font-medium">Geometry:</span>
            <span className="font-mono text-slate-700">{plot.geometry?.type || "Unknown"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500 font-medium">CRS / Units:</span>
            <span className="font-mono text-slate-700">
              {plotCrs.crs_type || "Not recorded"} / {plotCrs.units || "unknown"}
            </span>
          </div>
          {plot.confidence_signals && Object.keys(plot.confidence_signals).length > 0 && (
            <div className="text-slate-600">
              Confidence evidence:{" "}
              {Object.entries(plot.confidence_signals)
                .map(([key, value]) => `${key} ${value}`)
                .join(", ")}
            </div>
          )}
          {(!plot.confidence_signals || Object.keys(plot.confidence_signals).length === 0) && (
            <div className="text-slate-500">Geometry confidence: Not evaluated</div>
          )}
        </div>
        {plot.is_generated_candidate_id && (
          <p
            className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900"
            role="status"
            data-testid="generated-candidate-id-warning"
          >
            This is a temporary review ID, not a plot number read from the PDF. Confirm the label against the source artwork before saving it.
          </p>
        )}

        {/* Review & Manual Correction Mode Controls (Phase 12) */}
        {isReviewMode && (
          <div className="bg-amber-50/80 p-3 rounded-lg border border-amber-200 space-y-2.5">
            <div className="flex items-center gap-1.5 font-bold text-amber-900 text-xs">
              <Edit3 size={14} className="text-amber-700" />
              <span>Review & Correction Controls</span>
            </div>

            <div>
              <label className="text-[10px] font-semibold text-slate-600 block mb-1">Plot Number</label>
              <input
                type="text"
                value={editNumber}
                onChange={(e) => setEditNumber(e.target.value)}
                className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-xs font-mono"
                placeholder="e.g. 42-A"
              />
            </div>

            <div>
              <label className="text-[10px] font-semibold text-slate-600 block mb-1">Validation Status</label>
              <select
                value={editStatus}
                onChange={(e) => setEditStatus(e.target.value)}
                className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-xs"
              >
                <option value="verified">Verified (Approved)</option>
                <option value="candidate">Candidate</option>
                <option value="review_required">Review Required</option>
                <option value="conflicted">Conflicted</option>
              </select>
            </div>

            <div>
              <label className="text-[10px] font-semibold text-slate-600 block mb-1">Reason / Note</label>
              <input
                type="text"
                value={editReason}
                onChange={(e) => setEditReason(e.target.value)}
                className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-xs"
                placeholder="Reason for correction..."
              />
            </div>

            {editFeedback && (
              <div
                className={`p-2 rounded text-[11px] ${
                  editFeedback.success ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
                }`}
              >
                {editFeedback.message}
              </div>
            )}

            <button
              type="button"
              disabled={savingEdit}
              onClick={async () => {
                if (!colonyId || !plot?.id) return;
                setSavingEdit(true);
                setEditFeedback(null);
                try {
                  const corrections = [];
                  if (editNumber !== (plot.original_number || plot.number)) {
                    corrections.push({
                      entity_type: "Plot",
                      entity_id: plot.id,
                      field_name: "original_number",
                      previous_value: plot.original_number || plot.number,
                      corrected_value: editNumber,
                      reason: editReason || "Manual label correction",
                    });
                  }
                  if (editStatus !== plotStatus) {
                    corrections.push({
                      entity_type: "Plot",
                      entity_id: plot.id,
                      field_name: "semantic_validation_status",
                      previous_value: plotStatus,
                      corrected_value: editStatus,
                      reason: editReason || "Review status update",
                    });
                  }

                  if (corrections.length === 0) {
                    setEditFeedback({ success: true, message: "No changes to commit." });
                    return;
                  }

                  const res = await api.post(`/admin/colonies/${colonyId}/canonical/corrections/commit`, {
                    base_version: plot.dataset_version || datasetVersion,
                    corrections,
                    commit_note: editReason || `Manual corrections for plot ${editNumber}`,
                  });

                  setEditFeedback({
                    success: true,
                    message: `Committed as Version v${res.data.new_version}! Base version v${plot.dataset_version} preserved.`,
                  });
                  if (onRefreshData) onRefreshData();
                } catch (err) {
                  setEditFeedback({
                    success: false,
                    message: err.response?.data?.detail || err.message,
                  });
                } finally {
                  setSavingEdit(false);
                }
              }}
              className="w-full bg-amber-600 hover:bg-amber-700 text-white font-semibold py-1.5 px-3 rounded text-xs transition flex items-center justify-center gap-1 shadow-sm"
            >
              <Check size={14} />
              <span>{savingEdit ? "Committing..." : "Commit Correction (New Version)"}</span>
            </button>
          </div>
        )}

        {/* Declared vs. Derived Measurements */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-slate-800 flex items-center gap-1.5">
              <Ruler className="w-3.5 h-3.5 text-blue-600" />
              Dimensions & Area
            </h4>
            <span className="text-[10px] text-slate-400">Declared vs. Derived</span>
          </div>

          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 text-slate-600 font-semibold border-b">
                <tr>
                  <th className="p-2">Metric</th>
                  <th className="p-2 text-blue-700">Source-Declared</th>
                  <th className="p-2 text-slate-700">Geometry-Derived</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="p-2 font-medium text-slate-600">Frontage</td>
                  <td className="p-2 font-mono text-blue-800 font-semibold">
                    {formatMeasurement(plot.frontage_declared, plot.declared_units || "")}
                  </td>
                  <td className="p-2 font-mono text-slate-700">
                    {formatMeasurement(
                      derivedMeasurementsSupported && derivedLengthSupported
                        ? plot.frontage_derived
                        : null,
                      "m"
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="p-2 font-medium text-slate-600">Depth</td>
                  <td className="p-2 font-mono text-blue-800 font-semibold">
                    {formatMeasurement(plot.depth_declared, plot.declared_units || "")}
                  </td>
                  <td className="p-2 font-mono text-slate-700">
                    {formatMeasurement(
                      derivedMeasurementsSupported && derivedLengthSupported
                        ? plot.depth_derived
                        : null,
                      "m"
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="p-2 font-medium text-slate-600">Area</td>
                  <td className="p-2 font-mono text-blue-800 font-semibold">
                    {formatMeasurement(
                      plot.area_declared,
                      plot.area_declared_unit || plot.area_unit ||
                        (plot.declared_units ? `sq ${plot.declared_units}` : "")
                    )}
                  </td>
                  <td className="p-2 font-mono text-slate-700 font-semibold">
                    {formatMeasurement(
                      derivedMeasurementsSupported && derivedAreaSupported
                        ? plot.area_derived
                        : null,
                      "sq m"
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Road & Frontage Adjacency */}
        <div className="space-y-1.5">
          <h4 className="font-semibold text-slate-800 flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5 text-slate-600" />
            Road & Frontage Relationships
          </h4>
          {plot.adjacent_road_ids?.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {plot.adjacent_road_ids.map((rid) => (
                <span
                  key={rid}
                  className="px-2 py-1 bg-blue-50 text-blue-800 rounded font-mono text-[11px] border border-blue-200"
                >
                  {rid}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-slate-400 italic">No verified adjacent road recorded</span>
          )}
        </div>

        {/* Neighboring Plots */}
        <div className="space-y-1.5">
          <h4 className="font-semibold text-slate-800 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-slate-600" />
            Shared Boundary Neighbors
          </h4>
          {plot.neighboring_plot_ids?.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {plot.neighboring_plot_ids.map((nid) => (
                <button
                  key={nid}
                  onClick={() => onSelectNeighbor(nid)}
                  className="px-2 py-1 bg-slate-100 hover:bg-blue-100 hover:text-blue-700 text-slate-700 rounded font-mono text-[11px] transition"
                  title="Click to inspect neighbor"
                >
                  {nid}
                </button>
              ))}
            </div>
          ) : (
            <span className="text-slate-400 italic">No shared boundaries recorded</span>
          )}
        </div>

        {/* Source Document & Lineage */}
        <div className="space-y-1.5 pt-2 border-t">
          <h4 className="font-semibold text-slate-800 flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-slate-600" />
            Document Lineage & Provenance
          </h4>
          <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200 text-[11px] space-y-1 font-mono text-slate-600">
            <div>Doc: {plot.source_document_id || "Colony Layout PDF"}</div>
            <div>Page: {plot.source_page || 1}</div>
            {plot.provenance?.run_id && <div>Run ID: {plot.provenance.run_id}</div>}
            {plot.provenance?.repaired && (
              <div className="text-amber-700 font-sans font-medium">
                ⚠ Repaired: {plot.provenance.repair_note}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
