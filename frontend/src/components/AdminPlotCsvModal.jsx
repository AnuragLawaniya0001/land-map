import { useState, useRef } from "react";
import { Download, Upload, FileText, CheckCircle2, AlertTriangle, AlertCircle, X, Loader2, Table } from "lucide-react";
import { api, errMsg } from "@/lib/api";

export default function AdminPlotCsvModal({
  colonyId,
  colonyName = "colony",
  onClose,
  onImported,
}) {
  const [file, setFile] = useState(null);
  const [previewRows, setPreviewRows] = useState([]);
  const [totalRows, setTotalRows] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null);
  const fileInputRef = useRef(null);

  // Handle Export Current Plots CSV as a helper
  const handleExport = async () => {
    setExporting(true);
    setErr("");
    try {
      const res = await api.get(`/admin/colonies/${colonyId}/plots/export-csv`, {
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "text/csv;charset=utf-8;" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cleanName = colonyName.replace(/[^a-zA-Z0-9_-]/g, "_");
      a.download = `${cleanName}_plots.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setExporting(false);
    }
  };

  // Download Sample Template CSV
  const handleDownloadTemplate = () => {
    const headers =
      "Plot Number,Length (ft),Breadth (ft),Dimensions,Area (sq.ft),Area (sq.yd),Area (sq.m),Zone,Facing,Status,Price,Rate (per sq.ft)\n";
    const sample1 =
      "101,30,50,30ft × 50ft,1500,166.67,139.35,Residential,East,available,4500000,3000\n";
    const sample2 =
      "102,40,60,40ft × 60ft,2400,266.67,222.97,Commercial,North,available,7200000,3000\n";
    const blob = new Blob([headers + sample1 + sample2], {
      type: "text/csv;charset=utf-8;",
    });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "plots_sample_template.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  // Simple client-side CSV parser for quick preview
  const parseCsvPreview = (text) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= 1) return { headers: [], rows: [], count: 0 };

    const splitLine = (str) => {
      const result = [];
      let cur = "";
      let inQuotes = false;
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === '"') {
          inQuotes = !inQuotes;
        } else if (c === "," && !inQuotes) {
          result.push(cur.trim());
          cur = "";
        } else {
          cur += c;
        }
      }
      result.push(cur.trim());
      return result;
    };

    const headers = splitLine(lines[0]);
    const rows = [];
    for (let i = 1; i < Math.min(lines.length, 6); i++) {
      const vals = splitLine(lines[i]);
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = vals[idx] || "";
      });
      rows.push(obj);
    }
    return { headers, rows, count: lines.length - 1 };
  };

  const handleFileChange = (e) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setErr("");
    setResult(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result;
        if (typeof content === "string") {
          const { rows, count } = parseCsvPreview(content);
          setPreviewRows(rows);
          setTotalRows(count);
        }
      } catch (err) {
        console.warn("CSV preview parse error", err);
      }
    };
    reader.readAsText(selected);
  };

  const handleUpload = async () => {
    if (!file) {
      setErr("Please select a CSV file to import");
      return;
    }

    setUploading(true);
    setErr("");
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await api.post(
        `/admin/colonies/${colonyId}/plots/import-csv`,
        formData,
        {
          headers: { "Content-Type": "multipart/form-data" },
        }
      );

      setResult(res.data);
      if (res.data.plots && onImported) {
        onImported(res.data.plots);
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="lm-modal-shade" onClick={onClose} data-testid="plot-csv-modal-shade">
      <div
        className="lm-modal"
        style={{ width: "min(680px, 98vw)", maxHeight: "90vh", overflowY: "auto" }}
        data-testid="plot-csv-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lm-modal-head">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#173F35]/10 border border-[#173F35]/20 flex items-center justify-center text-[#173F35]">
              <Upload size={18} />
            </div>
            <div>
              <p className="lm-eyebrow">BULK UPDATE</p>
              <h3 className="text-xl font-bold">Import Plots (CSV)</h3>
            </div>
          </div>
          <button className="lm-icon-btn" onClick={onClose} type="button" data-testid="close-csv-modal">
            <X size={16} />
          </button>
        </div>

        {err && (
          <div className="lm-error" style={{ marginBottom: "14px" }} data-testid="csv-error">
            <AlertCircle size={15} /> {err}
          </div>
        )}

        {/* Success Result View */}
        {result ? (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2.5 text-emerald-800 font-bold text-sm">
              <CheckCircle2 size={18} className="text-emerald-600" />
              <span>Bulk Plot Import Completed Successfully!</span>
            </div>
            <p className="text-xs text-emerald-700">
              Updated <b>{result.updated_count}</b> plots out of <b>{result.total_plots}</b> total plots in colony. All map, satellite, 3D, and table views have been updated.
            </p>

            {result.unmatched && result.unmatched.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-xs text-amber-800">
                <div className="flex items-center gap-1.5 font-semibold mb-1">
                  <AlertTriangle size={13} />
                  <span>{result.unmatched.length} plot numbers not found in colony:</span>
                </div>
                <div className="font-mono text-[11px] text-amber-900 break-all">
                  {result.unmatched.join(", ")}
                </div>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                type="button"
                className="lm-btn-primary text-xs px-5"
                onClick={onClose}
                data-testid="csv-done-btn"
              >
                Close & View Map
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Helper row for downloading template or current plots */}
            <div className="flex items-center justify-between text-xs bg-[#FAF7F2] p-3 rounded-xl border border-[#E8E2D6]">
              <span className="text-slate-600">Need a template or current colony plots file?</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="lm-btn-ghost text-xs px-2.5 py-1 flex items-center gap-1 text-[#173F35] font-semibold"
                  onClick={handleDownloadTemplate}
                  data-testid="download-template-btn"
                >
                  <FileText size={12} />
                  Sample Template
                </button>
                <button
                  type="button"
                  className="lm-btn-ghost text-xs px-2.5 py-1 flex items-center gap-1 text-[#173F35] font-semibold"
                  onClick={handleExport}
                  disabled={exporting}
                  data-testid="export-csv-btn"
                >
                  {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                  Current Data (.csv)
                </button>
              </div>
            </div>

            {/* Upload Zone */}
            <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8E2D6] space-y-3">
              <label
                className={`lm-dropzone ${file ? "has-file" : ""} block p-5 border-2 border-dashed border-[#C5D3CD] hover:border-[#173F35] rounded-xl text-center cursor-pointer transition-colors bg-white`}
              >
                <input
                  type="file"
                  accept=".csv,text/csv"
                  hidden
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  data-testid="csv-file-input"
                />
                <Upload size={24} className="mx-auto text-slate-400 mb-2" />
                {file ? (
                  <div>
                    <p className="text-xs font-bold text-slate-800">{file.name}</p>
                    <p className="text-[11px] text-slate-500 font-mono mt-0.5">
                      {Math.round(file.size / 1024)} KB · {totalRows} rows detected · Click to change file
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="text-xs font-bold text-slate-700">Choose CSV file or drag & drop</p>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Supported columns: Plot Number, Length, Breadth, Dimensions, Area, Zone, Facing, Status, Price
                    </p>
                  </div>
                )}
              </label>

              {/* Data Preview Table */}
              {previewRows.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span className="font-semibold text-slate-700">Preview (first {previewRows.length} rows):</span>
                    <span>Total: {totalRows} rows</span>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-[#E8E2D6] bg-white">
                    <table className="w-full text-[11px] text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-100/70 border-b border-[#E8E2D6] text-slate-600 font-mono">
                          {Object.keys(previewRows[0]).slice(0, 6).map((k) => (
                            <th key={k} className="p-2 whitespace-nowrap">{k}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#E8E2D6]">
                        {previewRows.map((r, idx) => (
                          <tr key={idx} className="hover:bg-slate-50/50">
                            {Object.values(r).slice(0, 6).map((v, i) => (
                              <td key={i} className="p-2 whitespace-nowrap text-slate-800 font-mono">{String(v)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-2.5 justify-end pt-2 border-t border-[#E8E2D6]">
              <button
                type="button"
                className="lm-btn-ghost text-xs px-4"
                onClick={onClose}
                disabled={uploading}
              >
                Cancel
              </button>
              <button
                type="button"
                className="lm-btn-primary text-xs px-5 flex items-center gap-1.5"
                onClick={handleUpload}
                disabled={!file || uploading}
                data-testid="apply-csv-upload-btn"
              >
                {uploading ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Updating Plots…
                  </>
                ) : (
                  <>
                    <Upload size={13} />
                    Apply Bulk Updates ({totalRows || 0} plots)
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
