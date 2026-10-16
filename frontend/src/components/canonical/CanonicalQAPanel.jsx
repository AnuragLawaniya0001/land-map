/**
 * Canonical QA Findings & Review Drawer.
 *
 * Displays QA validation results, severity categories, and allows interactive navigation
 * directly to affected plots or roads on the map canvas.
 */

import { useState } from "react";
import { AlertCircle, AlertTriangle, Info, ChevronUp, ChevronDown } from "lucide-react";

export default function CanonicalQAPanel({
  qaFindings = [],
  qualityGrade = "NOT_EVALUATED",
  onSelectEntity = () => {},
}) {
  const [isOpen, setIsOpen] = useState(false);

  const errors = qaFindings.filter((f) => f.severity === "error" || f.severity === "critical");
  const warnings = qaFindings.filter((f) => f.severity === "warning");
  const infos = qaFindings.filter((f) => f.severity === "info" || !f.severity);

  return (
    <div className="border-t border-slate-200 bg-white shadow-lg transition-all duration-200 z-20">
      {/* Header Bar */}
      <div
        className="px-4 py-2.5 flex items-center justify-between cursor-pointer hover:bg-slate-50 transition"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-slate-800 tracking-wide uppercase">
            QA Findings & Validation
          </span>

          {/* Quality Grade Badge */}
          <span
            className={`px-2 py-0.5 rounded text-[11px] font-bold border ${
              qualityGrade === "A_VERIFIED"
                ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                : qualityGrade === "B_ACCEPTABLE"
                ? "bg-blue-100 text-blue-800 border-blue-300"
                : qualityGrade === "C_REVIEW_NEEDED"
                ? "bg-amber-100 text-amber-800 border-amber-300"
                  : qualityGrade === "NOT_EVALUATED"
                  ? "bg-slate-100 text-slate-700 border-slate-300"
                  : "bg-red-100 text-red-800 border-red-300"
            }`}
          >
              Grade: {qualityGrade}
            </span>

          {/* Counter Badges */}
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            {errors.length > 0 && (
              <span className="flex items-center gap-1 bg-red-50 text-red-700 px-2 py-0.5 rounded border border-red-200">
                <AlertCircle className="w-3.5 h-3.5" />
                {errors.length} Errors
              </span>
            )}
            {warnings.length > 0 && (
              <span className="flex items-center gap-1 bg-amber-50 text-amber-700 px-2 py-0.5 rounded border border-amber-200">
                <AlertTriangle className="w-3.5 h-3.5" />
                {warnings.length} Warnings
              </span>
            )}
            {errors.length === 0 && warnings.length === 0 && (
              <span className="flex items-center gap-1 bg-slate-50 text-slate-600 px-2 py-0.5 rounded border border-slate-200">
                <Info className="w-3.5 h-3.5" />
                No findings reported
              </span>
            )}
          </div>
        </div>

        <button className="text-slate-500 hover:text-slate-700 p-1">
          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </button>
      </div>

      {/* Expandable Findings Drawer */}
      {isOpen && (
        <div className="p-4 border-t border-slate-100 max-h-56 overflow-y-auto space-y-2 text-xs bg-slate-50">
          {qaFindings.length === 0 ? (
            <div className="text-slate-500 italic p-3 text-center">
              No QA findings were returned for this dataset. This does not imply that geometry or topology validation passed.
            </div>
          ) : (
            qaFindings.map((finding, idx) => {
              const isError = finding.severity === "error" || finding.severity === "critical";
              const isWarn = finding.severity === "warning";
              return (
                <div
                  key={idx}
                  className={`p-2.5 rounded-lg border bg-white flex items-start justify-between gap-3 shadow-xs ${
                    isError
                      ? "border-red-200 text-red-900"
                      : isWarn
                      ? "border-amber-200 text-amber-900"
                      : "border-slate-200 text-slate-800"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {isError ? (
                      <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                    ) : isWarn ? (
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    ) : (
                      <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <p className="font-medium">{finding.message}</p>
                      {finding.details && Object.keys(finding.details).length > 0 && (
                        <p className="text-[11px] text-slate-500 font-mono mt-0.5">
                          {JSON.stringify(finding.details)}
                        </p>
                      )}
                    </div>
                  </div>

                  {finding.entity_ids?.length > 0 && (
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-[10px] text-slate-400">Target:</span>
                      {finding.entity_ids.map((eid) => (
                        <button
                          key={eid}
                          onClick={() => onSelectEntity(eid)}
                          className="px-2 py-0.5 bg-slate-100 hover:bg-blue-100 hover:text-blue-700 text-slate-700 rounded font-mono text-[11px] transition"
                          title="Locate on map"
                        >
                          {eid}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
