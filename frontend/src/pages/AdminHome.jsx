import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, MapPin, ArrowUpRight, X, ExternalLink, Trash2, Upload, Building2, Grid, CheckCircle2, Tag, MessageSquare, Share2, Image as ImageIcon, FileText, Users } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { usePortalBase } from "@/lib/portal";

function CreateColonyModal({ onClose, onCreated, base }) {
  const [form, setForm] = useState({ name: "", whatsapp_number: "+91 ", maps_link: "", location: "", description: "", public_enabled: true });
  const [kmlFile, setKmlFile] = useState(null);
  const [pdfFile, setPdfFile] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!kmlFile && !pdfFile) {
      setErr("Please upload at least one file (KML boundary file or PDF layout file).");
      return;
    }
    setBusy(true); setErr("");
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      if (kmlFile) fd.append("file", kmlFile);
      if (pdfFile) fd.append("layout_pdf", pdfFile);
      const r = await api.post("/admin/colonies", fd, { headers: { "Content-Type": "multipart/form-data" }, timeout: 300000 });
      setResult(r.data);
      onCreated(r.data);
    } catch (ex) { setErr(errMsg(ex)); } finally { setBusy(false); }
  };

  if (result) {
    const s = result.import_summary;
    return (
      <div className="lm-modal-shade" onClick={onClose}>
        <div className="lm-modal" onClick={(e) => e.stopPropagation()} data-testid="import-result-modal">
          <div className="lm-modal-head"><h3>Layout imported</h3><button type="button" className="lm-icon-btn" onClick={onClose}><X size={14} /></button></div>
          <p className="lm-muted">{result.name} was mapped successfully from the uploaded KML boundary and PDF layout.</p>
          <div className="lm-ps-areas lm-import-stats">
            <div><b>{s.plots}</b><span>{s.mode === "pdf_overlay_only" ? "PDF plot labels" : "plots"}</span></div>
            {s.mode === "pdf_overlay_only" && <p className="lm-muted">Labels are counted from the PDF; interactive plot records have not been created.</p>}
            <div><b>{s.zones}</b><span>zones</span></div>
            <div><b>{s.greens}</b><span>greens</span></div>
            <div><b>{s.roads}</b><span>roads</span></div>
          </div>
          {s.warnings && s.warnings.length > 0 && (
            <ul className="lm-import-warnings" data-testid="import-warnings">{s.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          )}
          <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
            <Link to={`${base}/colonies/${result.id}`} className="lm-btn-primary" style={{ flex: 1, textDecoration: "none", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }} data-testid="open-imported-colony">
              Open Map <ArrowUpRight size={14} />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="lm-modal-shade" onClick={onClose}>
      <form className="lm-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} data-testid="create-colony-modal">
        <div className="lm-modal-head">
          <h3>New Colony (KML + PDF Pipeline)</h3>
          <button type="button" className="lm-icon-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <label>Colony name<input required data-testid="colony-name-input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Shri Ram Enclave" /></label>
        <fieldset className="lm-import-mode">
          <legend>Layout Source Files (KML + PDF/DWG/DWF)</legend>
          <p className="lm-muted">Upload the KML file (site boundary polygon) and layout file (PDF, DWG, DWF, or DXF drawing) to create the colony map.</p>
          <label className={`lm-dropzone ${kmlFile ? "has-file" : ""}`} data-testid="colony-file-drop">
            <input type="file" accept=".kml,application/vnd.google-earth.kml+xml,.geojson,.json" hidden data-testid="colony-file-input" onChange={(e) => setKmlFile(e.target.files?.[0] || null)} />
            <Upload size={18} />
            {kmlFile ? <><b>{kmlFile.name}</b><small>{Math.round(kmlFile.size / 1024)} KB · click to replace</small></>
              : <><b>1 · KML File (.kml)</b><small>Upload KML file for site boundary & georeferenced GIS vectors.</small></>}
          </label>
          <label className={`lm-dropzone ${pdfFile ? "has-file" : ""}`}>
            <input type="file" accept=".pdf,.dwg,.dxf,.dwf,application/pdf" hidden data-testid="colony-pdf-input" onChange={(e) => setPdfFile(e.target.files?.[0] || null)} />
            <Upload size={18} />
            {pdfFile ? <><b>{pdfFile.name}</b><small>{Math.round(pdfFile.size / 1024)} KB · click to replace</small></>
              : <><b>2 · Layout Drawing File (.pdf, .dwg, .dwf, .dxf)</b><small>Upload layout drawing for visual overlay & plot parcel extraction.</small></>}
          </label>
        </fieldset>
        <label>Google Maps link <span className="lm-opt">(recommended – confirms the land position)</span>
          <input data-testid="colony-maps-input" value={form.maps_link} onChange={(e) => set("maps_link", e.target.value)} placeholder="https://maps.app.goo.gl/… or https://www.google.com/maps/@22.22,73.10,17z" />
        </label>
        <div className="lm-modal-2col">
          <label>Company WhatsApp (with country code)<input required data-testid="colony-whatsapp-input" value={form.whatsapp_number} onChange={(e) => set("whatsapp_number", e.target.value)} placeholder="+91 98XXX XXXXX" /></label>
          <label>Location <span className="lm-opt">(optional)</span><input data-testid="colony-location-input" value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Village, Taluka, District" /></label>
        </div>
        <label>Description <span className="lm-opt">(optional)</span><textarea rows={2} data-testid="colony-description-input" value={form.description} onChange={(e) => set("description", e.target.value)} /></label>
        <label className="lm-check-row">
          <input type="checkbox" checked={form.public_enabled} onChange={(e) => set("public_enabled", e.target.checked)} data-testid="colony-public-input" />
          <span>Publish on my public link</span>
        </label>
        {err && <div className="lm-error" data-testid="create-colony-error">{err}</div>}
        <button className="lm-btn-primary full" disabled={busy} data-testid="submit-colony">
          {busy ? "Processing KML & PDF layout…" : "Import layout & create colony"}
        </button>
      </form>
    </div>
  );
}

export default function AdminHome({ user }) {
  const base = usePortalBase();
  const [dash, setDash] = useState(null);
  const [colonies, setColonies] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [err, setErr] = useState("");
  const isSuper = user.role === "super_admin";

  const reload = () => {
    Promise.all([api.get("/admin/dashboard"), api.get("/admin/colonies")])
      .then(([a, b]) => { setDash(a.data); setColonies(b.data); })
      .catch((e) => setErr(errMsg(e)));
  };
  useEffect(() => { reload(); }, []);

  const statIcons = {
    colonies: <Building2 size={16} className="text-indigo-400" />,
    plots: <Grid size={16} className="text-cyan-400" />,
    available: <CheckCircle2 size={16} className="text-emerald-400" />,
    sold: <Tag size={16} className="text-red-400" />,
    inquiries: <MessageSquare size={16} className="text-amber-400" />,
    shares: <Share2 size={16} className="text-purple-400" />,
    media: <ImageIcon size={16} className="text-pink-400" />,
    registry: <FileText size={16} className="text-yellow-400" />,
    users: <Users size={16} className="text-blue-400" />,
  };

  const stats = [
    ["Colonies", dash?.colonies || 0, "colonies"],
    ["Plots", dash?.plots || 0, "plots"],
    ["Available", dash?.status_counts?.available || 0, "available"],
    ["Sold", dash?.status_counts?.sold || 0, "sold"],
    ["Inquiries", dash?.inquiries?.new != null ? `${dash.inquiries.new} New (${dash.inquiries.total})` : (dash?.inquiries?.total || 0), "inquiries"],
    ["Active Shares", dash?.shares?.active || 0, "shares"],
    ["Media", dash?.media_total || 0, "media"],
    ["Registry Docs", dash?.registry_docs || 0, "registry"],
  ];
  if (isSuper) stats.push(["Admins", dash?.total_users || 0, "users"]);

  return (
    <div className="lm-page">
      <header className="lm-topbar">
        <div>
          <p className="lm-eyebrow">{isSuper ? "SUPER ADMIN · OVERVIEW" : "ADMIN · OVERVIEW"}</p>
          <h1>Welcome back, {user.name.split(" ")[0]}.</h1>
          <p className="lm-muted">{isSuper ? "Every admin, colony and plot on the platform." : "Only the colonies you add appear here and on your public link."}</p>
        </div>
        <button className="lm-btn-primary" onClick={() => setShowModal(true)} data-testid="create-colony-btn"><Plus size={14} /> New colony</button>
      </header>

      <section className="lm-stat-row" data-testid="stat-row">
        {stats.map(([label, value, slug]) => (
          <div className={`lm-stat ${slug}`} key={slug} data-testid={`stat-${slug}`}>
            <div className="flex items-center justify-between mb-1">
              <span>{label}</span>
              <div className="p-1.5 rounded-lg bg-slate-800/40 border border-slate-700/40">
                {statIcons[slug]}
              </div>
            </div>
            <strong>{value}</strong>
          </div>
        ))}
      </section>

      <section className="lm-section">
        <div className="lm-section-head">
          <div>
            <p className="lm-eyebrow">{isSuper ? "ALL COLONIES" : "YOUR COLONIES"} · {colonies.length}</p>
            <h2>Open the map to manage inventory</h2>
          </div>
        </div>
        {err && <div className="lm-error">{err}</div>}
        <div className="lm-colony-grid">
          {colonies.map((c) => (
            <div className="lm-colony-card-wrap" key={c.id}>
            <Link to={`${base}/colonies/${c.id}`} className="lm-colony-card" data-testid={`admin-colony-card-${c.slug}`}>
              <div className="lm-colony-art">
                <span className="lm-colony-tag">{c.public_enabled ? "PUBLIC" : "DRAFT"}</span>
                <div className="lm-contour" />
              </div>
              <div className="lm-colony-body">
                <div>
                  <h3>{c.name}</h3>
                  <p><MapPin size={13} /> {c.location}</p>
                  {isSuper && c.owner && (
                    <small className="lm-owner-chip">by {c.owner.name} · <ExternalLink size={10} /> /u/{c.owner.slug}</small>
                  )}
                </div>
                <div className="lm-colony-meta"><span>{c.plot_count}</span><small>plots</small><ArrowUpRight size={14} /></div>
              </div>
            </Link>
            <button className="lm-card-delete" title="Delete colony" data-testid={`delete-colony-${c.slug}`}
              onClick={async () => {
                if (!window.confirm(`Delete colony "${c.name}" and all its plots?`)) return;
                try { await api.delete(`/admin/colonies/${c.id}`); reload(); } catch (e) { setErr(errMsg(e)); }
              }}>
              <Trash2 size={13} />
            </button>
            </div>
          ))}
          {!colonies.length && <div className="lm-empty-state"><p>No colonies yet. Create one to get started.</p></div>}
        </div>
      </section>

      {showModal && <CreateColonyModal base={base} onClose={() => setShowModal(false)} onCreated={() => reload()} />}
    </div>
  );
}
