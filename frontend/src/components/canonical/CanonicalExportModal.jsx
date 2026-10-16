import React, { useState } from "react";
import { Download, X, FileCode, FileSpreadsheet, FileCheck, Layers, AlertCircle } from "lucide-react";
import { api, errMsg } from "@/lib/api";

const EXPORT_FORMATS = [
  {
    id: "geojson",
    name: "GeoJSON",
    desc: "Standard RFC 7946 spatial vector format with declared & derived attributes",
    ext: ".geojson",
    icon: FileCode,
    badge: "GIS / Web",
  },
  {
    id: "csv",
    name: "CSV (Plot Table)",
    desc: "Tabular spreadsheet with plot numbers, declared vs derived measurements, and topology",
    ext: ".csv",
    icon: FileSpreadsheet,
    badge: "Excel / Sheets",
  },
  {
    id: "qa_json",
    name: "QA & Lineage Report",
    desc: "Machine-readable audit report of validation checks, quality grade, and reviewer corrections",
    ext: ".json",
    icon: FileCheck,
    badge: "Audit / QA",
  },
  {
    id: "dxf",
    name: "AutoCAD DXF",
    desc: "CAD vector drawing (R2010) with organized PLOTS, ROADS, and LABELS layers",
    ext: ".dxf",
    icon: Layers,
    badge: "CAD / Civil",
  },
];

export default function CanonicalExportModal({
  isOpen,
  onClose,
  colonyId,
  colonyName = "Colony",
  datasetVersion = 1,
  availableVersions = [],
  plotsCount = 0,
  roadsCount = 0,
}) {
  const [selectedFormat, setSelectedFormat] = useState("geojson");
  const [targetVersion, setTargetVersion] = useState(datasetVersion);
  const [includeReviewRequired, setIncludeReviewRequired] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");

  if (!isOpen) return null;

  const handleDownload = async () => {
    setDownloading(true);
    setError("");
    try {
      const url = `/admin/colonies/${colonyId}/canonical/export?format=${selectedFormat}&version=${targetVersion}&include_review_required=${includeReviewRequired}`;
      const res = await api.get(url, { responseType: "blob" });

      const fmt = EXPORT_FORMATS.find((f) => f.id === selectedFormat);
      const safeName = (colonyName || "colony").replace(/[^a-zA-Z0-9_-]/g, "_");
      const filename = `${safeName}_v${targetVersion}${fmt?.ext || ""}`;

      const blobUrl = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement("a");
      link.href = blobUrl;
      link.setAttribute("download", filename);
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);

      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div>
            <h3 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <Download size={18} className="text-blue-600" />
              <span>Export Canonical Colony Dataset</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Download validated geospatial data and audit records for {colonyName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 hover:bg-slate-200 rounded text-slate-500 transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs">
          {error && (
            <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded-lg flex items-center gap-2">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {/* Format Selection */}
          <div>
            <label className="font-semibold text-slate-700 block mb-2">Choose Export Format</label>
            <div className="grid grid-cols-2 gap-2.5">
              {EXPORT_FORMATS.map((fmt) => {
                const Icon = fmt.icon;
                const isSelected = selectedFormat === fmt.id;
                return (
                  <button
                    key={fmt.id}
                    type="button"
                    onClick={() => setSelectedFormat(fmt.id)}
                    className={`p-3 rounded-lg border text-left flex flex-col justify-between transition ${
                      isSelected
                        ? "border-blue-600 bg-blue-50/60 ring-2 ring-blue-500/20"
                        : "border-slate-200 hover:border-slate-300 bg-white"
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <Icon size={18} className={isSelected ? "text-blue-600" : "text-slate-500"} />
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">
                          {fmt.badge}
                        </span>
                      </div>
                      <div className="font-bold text-slate-800 text-xs mb-0.5">{fmt.name}</div>
                      <p className="text-[11px] text-slate-500 leading-tight">{fmt.desc}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Version Selection */}
          <div className="grid grid-cols-2 gap-3 pt-2 border-t">
            <div>
              <label className="font-semibold text-slate-700 block mb-1">Dataset Version</label>
              <select
                value={targetVersion}
                onChange={(e) => setTargetVersion(Number(e.target.value))}
                className="w-full bg-slate-50 border border-slate-300 rounded px-2.5 py-1.5 text-xs text-slate-800"
              >
                {availableVersions.length > 0 ? (
                  availableVersions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version} {v.is_active ? "(Active)" : ""}
                    </option>
                  ))
                ) : (
                  <option value={datasetVersion}>v{datasetVersion} (Active)</option>
                )}
              </select>
            </div>

            {/* Scope Toggle */}
            <div>
              <label className="font-semibold text-slate-700 block mb-1">Record Scope</label>
              <label className="flex items-center gap-2 mt-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeReviewRequired}
                  onChange={(e) => setIncludeReviewRequired(e.target.checked)}
                  className="rounded text-blue-600 focus:ring-blue-500"
                />
                <span className="text-slate-600 text-[11px]">Include Review-Required</span>
              </label>
            </div>
          </div>

          {/* Dataset Summary Notice */}
          <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-slate-600 space-y-1">
            <div className="font-semibold text-slate-700">Export Summary:</div>
            <div className="text-[11px]">
              • Entities: <b>{plotsCount}</b> plots, <b>{roadsCount}</b> roads
            </div>
            <div className="text-[11px]">
              • Dimensions: Declared drawing measurements & derived geometric measurements preserved
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 rounded transition"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={downloading}
            onClick={handleDownload}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded transition shadow-sm flex items-center gap-1.5"
          >
            <Download size={14} />
            <span>{downloading ? "Generating..." : "Download Export"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
