import { useState, useId } from "react";
import { Edit3, Check, X, AlertCircle, Calculator, Sparkles, Layers, Compass, Tag, IndianRupee } from "lucide-react";
import { api, errMsg } from "@/lib/api";

const FACING_OPTIONS = [
  "",
  "North",
  "South",
  "East",
  "West",
  "North-East",
  "North-West",
  "South-East",
  "South-West",
];

const VISIBILITY_OPTIONS = ["PRIVATE", "PUBLIC", "SHARED"];

function parseDims(dimStr) {
  if (!dimStr) return { length: "", breadth: "" };
  const match = String(dimStr).match(/([0-9.]+)\s*(?:ft|'|m)?\s*[×x*X]\s*([0-9.]+)/);
  if (match) {
    return { length: match[1], breadth: match[2] };
  }
  return { length: "", breadth: "" };
}

export default function AdminPlotEditModal({
  plot,
  zones = [],
  statuses = [],
  onClose,
  onSaved,
}) {
  const initialDims = parseDims(plot.dimensions);
  const initialLength = plot.length_ft !== undefined && plot.length_ft !== null
    ? String(plot.length_ft)
    : initialDims.length;
  const initialBreadth = plot.breadth_ft !== undefined && plot.breadth_ft !== null
    ? String(plot.breadth_ft)
    : initialDims.breadth;

  const matchedZone = zones.find(
    (z) =>
      z.id === plot.zone_id ||
      z.code === plot.zone_id ||
      z.name === plot.zone_id ||
      (z.name && String(z.name).toLowerCase() === String(plot.zone_id || "").toLowerCase()) ||
      (z.code && String(z.code).toLowerCase() === String(plot.zone_id || "").toLowerCase())
  );
  const initialZoneId = matchedZone ? matchedZone.id : (plot.zone_id || "");

  const [form, setForm] = useState({
    number: plot.number || "",
    length_ft: initialLength,
    breadth_ft: initialBreadth,
    dimensions: plot.dimensions || (initialLength && initialBreadth ? `${initialLength}ft × ${initialBreadth}ft` : ""),
    area_sqft: plot.area_sqft !== undefined && plot.area_sqft !== null ? String(Math.round(plot.area_sqft * 100) / 100) : "",
    area_sqyd: plot.area_sqyd !== undefined && plot.area_sqyd !== null ? String(Math.round(plot.area_sqyd * 100) / 100) : "",
    area_sqm: plot.area_sqm !== undefined && plot.area_sqm !== null ? String(Math.round(plot.area_sqm * 100) / 100) : "",
    zone_id: initialZoneId,
    status_id: plot.status_id || "available",
    facing: plot.facing || "",
    title: plot.title || "",
    description: plot.description || "",
    price: plot.price !== undefined && plot.price !== null ? String(plot.price) : "",
    price_per_sqft: plot.price_per_sqft !== undefined && plot.price_per_sqft !== null ? String(plot.price_per_sqft) : "",
    visibility: plot.visibility || "PRIVATE",
  });

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [autoCalc, setAutoCalc] = useState(true);

  const setField = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErr("");
  };

  // Auto-calculation when length or breadth changes
  const handleDimChange = (dimKey, val) => {
    setForm((prev) => {
      const next = { ...prev, [dimKey]: val };
      if (!autoCalc) return next;

      const l = parseFloat(dimKey === "length_ft" ? val : next.length_ft);
      const b = parseFloat(dimKey === "breadth_ft" ? val : next.breadth_ft);

      if (!isNaN(l) && l > 0 && !isNaN(b) && b > 0) {
        next.dimensions = `${l}ft × ${b}ft`;
        const sqft = Math.round(l * b * 100) / 100;
        next.area_sqft = String(sqft);
        next.area_sqyd = String(Math.round((sqft / 9.0) * 100) / 100);
        next.area_sqm = String(Math.round(sqft * 0.092903 * 100) / 100);

        const rate = parseFloat(next.price_per_sqft);
        if (!isNaN(rate) && rate > 0) {
          next.price = String(Math.round(sqft * rate));
        }
      }
      return next;
    });
    setErr("");
  };

  const handleSqftChange = (val) => {
    setForm((prev) => {
      const next = { ...prev, area_sqft: val };
      const sqft = parseFloat(val);
      if (!isNaN(sqft) && sqft > 0) {
        next.area_sqyd = String(Math.round((sqft / 9.0) * 100) / 100);
        next.area_sqm = String(Math.round(sqft * 0.092903 * 100) / 100);
        const rate = parseFloat(next.price_per_sqft);
        if (!isNaN(rate) && rate > 0) {
          next.price = String(Math.round(sqft * rate));
        }
      }
      return next;
    });
    setErr("");
  };

  const handleSqydChange = (val) => {
    setForm((prev) => {
      const next = { ...prev, area_sqyd: val };
      const sqyd = parseFloat(val);
      if (!isNaN(sqyd) && sqyd > 0) {
        const sqft = Math.round(sqyd * 9.0 * 100) / 100;
        next.area_sqft = String(sqft);
        next.area_sqm = String(Math.round(sqft * 0.092903 * 100) / 100);
        const rate = parseFloat(next.price_per_sqft);
        if (!isNaN(rate) && rate > 0) {
          next.price = String(Math.round(sqft * rate));
        }
      }
      return next;
    });
    setErr("");
  };

  const handleRateChange = (val) => {
    setForm((prev) => {
      const next = { ...prev, price_per_sqft: val };
      const rate = parseFloat(val);
      const sqft = parseFloat(next.area_sqft);
      if (!isNaN(rate) && rate > 0 && !isNaN(sqft) && sqft > 0) {
        next.price = String(Math.round(sqft * rate));
      }
      return next;
    });
    setErr("");
  };

  const handlePriceChange = (val) => {
    setForm((prev) => {
      const next = { ...prev, price: val };
      const price = parseFloat(val);
      const sqft = parseFloat(next.area_sqft);
      if (!isNaN(price) && price > 0 && !isNaN(sqft) && sqft > 0) {
        next.price_per_sqft = String(Math.round((price / sqft) * 100) / 100);
      }
      return next;
    });
    setErr("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErr("");

    const plotNum = form.number.trim();
    if (!plotNum) {
      setErr("Plot Number cannot be empty");
      return;
    }

    const payload = {
      number: plotNum,
      dimensions: form.dimensions.trim(),
      facing: form.facing,
      visibility: form.visibility,
      title: form.title.trim(),
      description: form.description.trim(),
    };

    if (form.zone_id) {
      payload.zone_id = form.zone_id;
    }
    if (form.status_id) {
      payload.status_id = form.status_id;
    }

    if (form.length_ft !== "") {
      const l = Number(form.length_ft);
      if (isNaN(l) || l < 0) {
        setErr("Length must be a valid positive number");
        return;
      }
      payload.length_ft = l;
    }

    if (form.breadth_ft !== "") {
      const b = Number(form.breadth_ft);
      if (isNaN(b) || b < 0) {
        setErr("Breadth must be a valid positive number");
        return;
      }
      payload.breadth_ft = b;
    }

    if (form.area_sqft !== "") {
      const s = Number(form.area_sqft);
      if (isNaN(s) || s < 0) {
        setErr("Area (sq.ft) must be a valid positive number");
        return;
      }
      payload.area_sqft = s;
    }

    if (form.area_sqyd !== "") {
      const y = Number(form.area_sqyd);
      if (isNaN(y) || y < 0) {
        setErr("Area (sq.yd) must be a valid positive number");
        return;
      }
      payload.area_sqyd = y;
    }

    if (form.area_sqm !== "") {
      const m = Number(form.area_sqm);
      if (!isNaN(m) && m >= 0) {
        payload.area_sqm = m;
      }
    }

    if (form.price !== "") {
      const p = Number(form.price);
      if (isNaN(p) || p < 0) {
        setErr("Price must be a valid non-negative number");
        return;
      }
      payload.price = p;
    }

    if (form.price_per_sqft !== "") {
      const r = Number(form.price_per_sqft);
      if (isNaN(r) || r < 0) {
        setErr("Rate per sq.ft must be a valid non-negative number");
        return;
      }
      payload.price_per_sqft = r;
    }

    setBusy(true);
    try {
      const targetId = plot.id || plot._id;
      const res = await api.patch(`/admin/plots/${targetId}`, payload);
      onSaved(res.data);
    } catch (error) {
      setErr(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lm-modal-shade" data-testid="plot-edit-modal-shade" onClick={onClose}>
      <div
        className="lm-modal"
        style={{ width: "min(640px, 98vw)", maxHeight: "90vh", overflowY: "auto" }}
        data-testid="plot-edit-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lm-modal-head">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#173F35]/10 border border-[#173F35]/20 flex items-center justify-center text-[#173F35]">
              <Edit3 size={18} />
            </div>
            <div>
              <p className="lm-eyebrow">EDIT PLOT METADATA</p>
              <h3 className="text-xl font-bold">Plot {form.number || plot.number}</h3>
            </div>
          </div>
          <button className="lm-icon-btn" onClick={onClose} data-testid="close-edit-plot-modal" type="button">
            <X size={16} />
          </button>
        </div>

        {err && (
          <div className="lm-error" style={{ marginBottom: "14px" }} data-testid="plot-edit-error">
            <AlertCircle size={15} /> {err}
          </div>
        )}

        <form onSubmit={handleSubmit} data-testid="plot-edit-form" className="space-y-4">
          {/* Section: Basic Identity */}
          <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8E2D6] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                <Tag size={14} className="text-[#173F35]" /> Identification & Classification
              </span>
              <span className="text-[11px] text-slate-500 font-mono">ID: {plot.id}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="edit-plot-number" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                  Plot Number *
                </label>
                <input
                  id="edit-plot-number"
                  className="lm-modern-input w-full text-xs font-bold"
                  placeholder="e.g. 101, A-12"
                  value={form.number}
                  onChange={(e) => setField("number", e.target.value)}
                  data-testid="edit-plot-number-input"
                  required
                />
              </div>

              <div>
                <label htmlFor="edit-zone" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                  Zone / Sector
                </label>
                <select
                  id="edit-zone"
                  className="lm-modern-input w-full text-xs"
                  value={form.zone_id}
                  onChange={(e) => setField("zone_id", e.target.value)}
                  data-testid="edit-zone-select"
                >
                  <option value="">Unassigned</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name || `Zone ${z.code}`}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="edit-status" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                  Status
                </label>
                <select
                  id="edit-status"
                  className="lm-modern-input w-full text-xs capitalize"
                  value={form.status_id}
                  onChange={(e) => setField("status_id", e.target.value)}
                  data-testid="edit-status-select"
                >
                  {statuses.length > 0 ? (
                    statuses.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="available">Available</option>
                      <option value="reserved">Reserved</option>
                      <option value="hold">Hold</option>
                      <option value="sold">Sold</option>
                      <option value="blocked">Blocked</option>
                    </>
                  )}
                </select>
              </div>
            </div>
          </div>

          {/* Section: Dimensions & Area with Calculator */}
          <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8E2D6] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                <Calculator size={14} className="text-[#173F35]" /> Dimensions & Area
              </span>
              <label className="flex items-center gap-1.5 text-[11px] text-[#173F35] font-semibold cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoCalc}
                  onChange={(e) => setAutoCalc(e.target.checked)}
                  className="rounded text-[#173F35]"
                />
                Auto-calculate area
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="edit-length" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                  Length (ft)
                </label>
                <input
                  id="edit-length"
                  type="number"
                  step="any"
                  min="0"
                  className="lm-modern-input w-full text-xs font-mono"
                  placeholder="e.g. 30"
                  value={form.length_ft}
                  onChange={(e) => handleDimChange("length_ft", e.target.value)}
                  data-testid="edit-length-input"
                />
              </div>

              <div>
                <label htmlFor="edit-breadth" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                  Breadth (ft)
                </label>
                <input
                  id="edit-breadth"
                  type="number"
                  step="any"
                  min="0"
                  className="lm-modern-input w-full text-xs font-mono"
                  placeholder="e.g. 50"
                  value={form.breadth_ft}
                  onChange={(e) => handleDimChange("breadth_ft", e.target.value)}
                  data-testid="edit-breadth-input"
                />
              </div>

              <div>
                <label htmlFor="edit-dims-text" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                  Dimensions Text
                </label>
                <input
                  id="edit-dims-text"
                  className="lm-modern-input w-full text-xs font-mono"
                  placeholder="e.g. 30ft × 50ft"
                  value={form.dimensions}
                  onChange={(e) => setField("dimensions", e.target.value)}
                  data-testid="edit-dims-input"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1 border-t border-[#E8E2D6]/60">
              <div>
                <label htmlFor="edit-sqft" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                  Area (sq.ft)
                </label>
                <input
                  id="edit-sqft"
                  type="number"
                  step="any"
                  min="0"
                  className="lm-modern-input w-full text-xs font-mono"
                  placeholder="e.g. 1500"
                  value={form.area_sqft}
                  onChange={(e) => handleSqftChange(e.target.value)}
                  data-testid="edit-sqft-input"
                />
              </div>

              <div>
                <label htmlFor="edit-sqyd" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                  Area (sq.yd / Gaj)
                </label>
                <input
                  id="edit-sqyd"
                  type="number"
                  step="any"
                  min="0"
                  className="lm-modern-input w-full text-xs font-mono"
                  placeholder="e.g. 166.67"
                  value={form.area_sqyd}
                  onChange={(e) => handleSqydChange(e.target.value)}
                  data-testid="edit-sqyd-input"
                />
              </div>

              <div>
                <label htmlFor="edit-sqm" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                  Area (sq.m)
                </label>
                <input
                  id="edit-sqm"
                  type="number"
                  step="any"
                  min="0"
                  className="lm-modern-input w-full text-xs font-mono bg-slate-50"
                  placeholder="e.g. 139.35"
                  value={form.area_sqm}
                  onChange={(e) => setField("area_sqm", e.target.value)}
                  data-testid="edit-sqm-input"
                />
              </div>
            </div>
          </div>

          {/* Section: Orientation & Pricing */}
          <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8E2D6] space-y-3">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
              <Compass size={14} className="text-[#173F35]" /> Orientation & Commercials
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="edit-facing" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                  Facing Direction
                </label>
                <select
                  id="edit-facing"
                  className="lm-modern-input w-full text-xs"
                  value={form.facing}
                  onChange={(e) => setField("facing", e.target.value)}
                  data-testid="edit-facing-select"
                >
                  <option value="">Unset / Unknown</option>
                  {FACING_OPTIONS.filter(Boolean).map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="edit-price-sqft" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                  Rate (₹ / sq.ft)
                </label>
                <input
                  id="edit-price-sqft"
                  type="number"
                  min="0"
                  step="any"
                  className="lm-modern-input w-full text-xs font-mono"
                  placeholder="e.g. 3000"
                  value={form.price_per_sqft}
                  onChange={(e) => handleRateChange(e.target.value)}
                  data-testid="edit-price-sqft-input"
                />
              </div>

              <div>
                <label htmlFor="edit-price" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                  Total Price (₹)
                </label>
                <input
                  id="edit-price"
                  type="number"
                  min="0"
                  step="any"
                  className="lm-modern-input w-full text-xs font-mono font-semibold text-[#173F35]"
                  placeholder="e.g. 4500000"
                  value={form.price}
                  onChange={(e) => handlePriceChange(e.target.value)}
                  data-testid="edit-price-input"
                />
              </div>
            </div>
          </div>

          {/* Section: Title & Description */}
          <div className="space-y-3">
            <div>
              <label htmlFor="edit-title" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                Property Title (Optional)
              </label>
              <input
                id="edit-title"
                className="lm-modern-input w-full text-xs"
                placeholder="e.g. Prime Corner Plot near Main Road"
                value={form.title}
                onChange={(e) => setField("title", e.target.value)}
                data-testid="edit-title-input"
              />
            </div>

            <div>
              <label htmlFor="edit-description" className="block text-[11px] font-mono font-bold text-slate-500 mb-1 uppercase tracking-wider">
                Description / Notes
              </label>
              <textarea
                id="edit-description"
                className="lm-modern-input w-full text-xs resize-none"
                rows={2}
                placeholder="Plot specifications, survey notes or features..."
                value={form.description}
                onChange={(e) => setField("description", e.target.value)}
                data-testid="edit-description-input"
              />
            </div>
          </div>

          <div className="flex gap-2.5 justify-end pt-3 border-t border-[#E8E2D6] mt-4">
            <button
              type="button"
              className="lm-btn-ghost text-xs px-4"
              onClick={onClose}
              disabled={busy}
              data-testid="cancel-edit-plot-btn"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="lm-btn-primary text-xs px-5 flex items-center gap-1.5"
              disabled={busy}
              data-testid="save-edit-plot-btn"
            >
              {busy ? (
                "Saving…"
              ) : (
                <>
                  <Check size={14} /> Save Changes
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
