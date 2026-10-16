import { useRef, useState } from "react";
import { X, Database } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { inspectGeoJsonPlotFile } from "@/lib/geoImport";
import ColonyDataUsedModal from "./ColonyDataUsedModal";

export default function ColonySettingsModal({ colony, onClose, onSaved }) {
  const [showDataUsed, setShowDataUsed] = useState(false);
  const [form, setForm] = useState({
    whatsapp_number: colony.whatsapp_number || "",
    description: colony.description || "",
    location: colony.location || "",
    public_enabled: !!colony.public_enabled,
  });
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [geojsonFile, setGeojsonFile] = useState(null);
  const [pdfFile, setPdfFile] = useState(null);
  const [companionFile, setCompanionFile] = useState(null);
  const [companionType, setCompanionType] = useState(colony.import_source?.sources?.companion?.toLowerCase().endsWith(".dwg") ? "dwg" : "kml");
  const [geojsonReview, setGeojsonReview] = useState("");
  const geojsonReviewRequest = useRef(0);
  const selectedSourceFiles = [geojsonFile, pdfFile, companionFile].filter(Boolean).length;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    if (geojsonFile) {
      const review = await inspectGeoJsonPlotFile(geojsonFile);
      const boundaryOnly = review.polygonCount === 0;
      const companionIsKmlOrDwg = companionFile?.name.toLowerCase().endsWith(".kml") || companionFile?.name.toLowerCase().endsWith(".dwg") || review.isKml;
      const hasPdfLayout = Boolean(pdfFile);
      if (review.error || (!hasPdfLayout && boundaryOnly && (!review.boundaryCount && !companionIsKmlOrDwg))) {
        const message = review.error || "A boundary-only update requires a KML land boundary.";
        setGeojsonReview(message);
        setErr(`${message} No colony data has been changed.`);
        return;
      }
    }
    setSaving(true); setErr("");
    try {
      let payload = form;
      let config;
      if (selectedSourceFiles > 0) {
        payload = new FormData();
        Object.entries(form).forEach(([key, value]) => payload.append(key, value));
        if (geojsonFile) payload.append("file", geojsonFile);
        if (pdfFile) payload.append("layout_pdf", pdfFile);
        if (companionFile) payload.append("cad_file", companionFile);
        config = { headers: { "Content-Type": "multipart/form-data" }, timeout: 120000 };
      }
      const r = await api.patch(`/admin/colonies/${colony.id}`, payload, config);
      onSaved(r.data);
    } catch (ex) { setErr(errMsg(ex)); } finally { setSaving(false); }
  };

  return (
    <div className="lm-modal-shade" onClick={onClose}>
      <form className="lm-modal" onClick={(e) => e.stopPropagation()} onSubmit={save} data-testid="colony-settings-modal">
        <div className="lm-modal-head">
          <h3>Colony settings</h3>
          <button type="button" className="lm-icon-btn" onClick={onClose} data-testid="settings-close"><X size={16} /></button>
        </div>
        <label>Company WhatsApp number (with country code)</label>
        <input value={form.whatsapp_number} onChange={(e) => set("whatsapp_number", e.target.value)} placeholder="+91 98XXX XXXXX" data-testid="settings-whatsapp" />
        <label>Location</label>
        <input value={form.location} onChange={(e) => set("location", e.target.value)} data-testid="settings-location" />
        <label>Description</label>
        <textarea rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} data-testid="settings-description" />
        <fieldset className="lm-import-mode" data-testid="settings-mapping-sources">
          <legend>Replace colony mapping (optional)</legend>
          <div style={{ display: "flex", items: "center", justifyContent: "space-between", gap: "8px", marginBottom: "8px" }}>
            <p className="lm-muted" style={{ margin: 0 }}>Current sources: {[
              colony.import_source?.sources?.geojson,
              colony.import_source?.sources?.pdf,
              colony.import_source?.sources?.companion,
            ].filter(Boolean).join(" · ") || "Source filenames are not available for this colony."}</p>
            <button
              type="button"
              onClick={() => setShowDataUsed(true)}
              style={{
                padding: "4px 10px",
                borderRadius: "6px",
                background: "rgba(16, 185, 129, 0.15)",
                color: "#10b981",
                border: "1px solid rgba(16, 185, 129, 0.3)",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
                display: "flex",
                alignItems: "center",
                gap: "4px"
              }}
              data-testid="settings-data-used-btn"
            >
              <Database size={12} /> Data Used & Accuracy
            </button>
          </div>
          <legend>Update Layout Source Files (KML + PDF)</legend>
          <p className="lm-muted">Upload KML file (site boundary polygon) and/or PDF layout file to update the colony map.</p>
          <label>1 · KML Boundary File (.kml)
            <input type="file" accept=".kml,application/vnd.google-earth.kml+xml,.geojson,.json" onChange={(e) => setGeojsonFile(e.target.files?.[0] || null)} data-testid="settings-kml" />
          </label>
          <label>2 · PDF Layout File (.pdf)
            <input type="file" accept=".pdf,application/pdf" onChange={(e) => setPdfFile(e.target.files?.[0] || null)} data-testid="settings-pdf" />
          </label>
        </fieldset>
        <label className="lm-check-row">
          <input type="checkbox" checked={form.public_enabled} onChange={(e) => set("public_enabled", e.target.checked)} data-testid="settings-public" />
          Public map enabled
        </label>
        {err && <div className="lm-error" data-testid="settings-error">{err}</div>}
        <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
          <button type="submit" className="lm-btn-primary" style={{ flex: 1 }} disabled={saving} data-testid="settings-save">{saving ? "Saving…" : "Save settings"}</button>
          <button
            type="button"
            className="lm-btn-danger"
            style={{
              padding: "8px 16px",
              borderRadius: "6px",
              background: "#ef4444",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              gap: "6px"
            }}
            onClick={async () => {
              if (!window.confirm(`Are you sure you want to permanently delete colony "${colony.name || colony.id}" and all associated plot/GIS data? This action cannot be undone.`)) return;
              try {
                setSaving(true);
                setErr("");
                const colonyId = colony.id || colony._id;
                await api.delete(`/admin/colonies/${colonyId}`);
                onClose();
                if (onSaved) onSaved({ deleted: true, colonyId });
              } catch (ex) {
                setErr(errMsg(ex));
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving}
            data-testid="settings-delete"
          >
            Delete Colony
          </button>
        </div>
      </form>
      {showDataUsed && <ColonyDataUsedModal colony={colony} onClose={() => setShowDataUsed(false)} />}
    </div>
  );
}
