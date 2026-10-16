import { useState } from "react";
import { Edit3, Check, X, AlertCircle } from "lucide-react";
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

export default function AdminPlotEditModal({ plot, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: plot.title || "",
    description: plot.description || "",
    price: plot.price !== undefined && plot.price !== null ? String(plot.price) : "",
    price_per_sqft: plot.price_per_sqft !== undefined && plot.price_per_sqft !== null ? String(plot.price_per_sqft) : "",
    facing: plot.facing || "",
    visibility: plot.visibility || "PRIVATE",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const setField = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErr("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErr("");

    const payload = {};

    payload.title = form.title.trim();
    payload.description = form.description.trim();
    payload.facing = form.facing;
    payload.visibility = form.visibility;

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
        setErr("Price per sq.ft must be a valid non-negative number");
        return;
      }
      payload.price_per_sqft = r;
    }

    setBusy(true);
    try {
      const res = await api.patch(`/admin/plots/${plot.id}`, payload);
      onSaved(res.data);
    } catch (error) {
      setErr(errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lm-modal-shade" data-testid="plot-edit-modal-shade">
      <div className="lm-modal" style={{ width: "min(520px, 100%)" }} data-testid="plot-edit-modal">
        <div className="lm-modal-head">
          <div>
            <p className="lm-eyebrow">EDIT PROPERTY DETAILS</p>
            <h3>Plot {plot.number}</h3>
          </div>
          <button className="lm-icon-btn" onClick={onClose} data-testid="close-edit-plot-modal">
            <X size={16} />
          </button>
        </div>

        {err && (
          <div className="lm-error" style={{ marginBottom: "12px" }} data-testid="plot-edit-error">
            <AlertCircle size={14} /> {err}
          </div>
        )}

        <form onSubmit={handleSubmit} data-testid="plot-edit-form">
          <label htmlFor="edit-title">Property Title</label>
          <input
            id="edit-title"
            className="lm-input full"
            placeholder="e.g. East Facing Corner Plot"
            value={form.title}
            onChange={(e) => setField("title", e.target.value)}
            data-testid="edit-title-input"
          />

          <label htmlFor="edit-description">Description</label>
          <textarea
            id="edit-description"
            className="lm-input full"
            rows={3}
            placeholder="Property description or notes..."
            value={form.description}
            onChange={(e) => setField("description", e.target.value)}
            data-testid="edit-description-input"
          />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "10px" }}>
            <div>
              <label htmlFor="edit-price">Total Price (₹)</label>
              <input
                id="edit-price"
                type="number"
                min="0"
                step="any"
                className="lm-input full"
                placeholder="e.g. 4500000"
                value={form.price}
                onChange={(e) => setField("price", e.target.value)}
                data-testid="edit-price-input"
              />
            </div>
            <div>
              <label htmlFor="edit-price-sqft">Rate (₹ / sq.ft)</label>
              <input
                id="edit-price-sqft"
                type="number"
                min="0"
                step="any"
                className="lm-input full"
                placeholder="e.g. 2322.58"
                value={form.price_per_sqft}
                onChange={(e) => setField("price_per_sqft", e.target.value)}
                data-testid="edit-price-sqft-input"
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "10px" }}>
            <div>
              <label htmlFor="edit-facing">Facing Direction</label>
              <select
                id="edit-facing"
                className="lm-input full"
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
              <label htmlFor="edit-visibility">Visibility State</label>
              <select
                id="edit-visibility"
                className="lm-input full"
                value={form.visibility}
                onChange={(e) => setField("visibility", e.target.value)}
                data-testid="edit-visibility-select"
              >
                {VISIBILITY_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "24px" }}>
            <button
              type="button"
              className="lm-btn-ghost"
              onClick={onClose}
              disabled={busy}
              data-testid="cancel-edit-plot-btn"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="lm-btn-primary"
              disabled={busy}
              data-testid="save-edit-plot-btn"
            >
              {busy ? "Saving..." : "Save Property"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
