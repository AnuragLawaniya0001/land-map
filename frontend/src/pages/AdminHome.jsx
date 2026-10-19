import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, MapPin, ArrowUpRight, X, ExternalLink, Trash2, Upload, Building2, Grid, CheckCircle2, Tag, MessageSquare, Share2, Image as ImageIcon, FileText, Users, Loader2, Sparkles, RefreshCw } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { usePortalBase } from "@/lib/portal";

function CreateColonyModal({ onClose, onCreated, base }) {
  const [form, setForm] = useState({ name: "", whatsapp_number: "+91 ", maps_link: "", location: "", description: "", public_enabled: true });
  const [kmlFile, setKmlFile] = useState(null);
  const [pdfFile, setPdfFile] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [liveStatus, setLiveStatus] = useState(null);
  const [finalColony, setFinalColony] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Live polling for the created colony until pipeline is complete
  useEffect(() => {
    if (!result?.id) return;
    let timer;
    let cancelled = false;

    const checkStatus = async () => {
      try {
        const res = await api.get(`/admin/colonies/${result.id}/status`);
        if (cancelled) return;
        setLiveStatus(res.data);
        if (res.data.status === "ready") {
          try {
            const cRes = await api.get(`/admin/colonies/${result.id}`);
            if (!cancelled) setFinalColony(cRes.data);
          } catch {}
          onCreated(res.data);
        } else if (res.data.status !== "failed") {
          timer = setTimeout(checkStatus, 2000);
        }
      } catch (e) {
        if (!cancelled) timer = setTimeout(checkStatus, 3000);
      }
    };

    checkStatus();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [result?.id]); // eslint-disable-line

  const submit = async (e) => {
    e.preventDefault();
    if (!kmlFile && !pdfFile) {
      setErr("Please upload at least one file (KML boundary file or PDF/DXF layout file).");
      return;
    }
    if (kmlFile) {
      const ext = kmlFile.name.toLowerCase().slice(kmlFile.name.lastIndexOf("."));
      if (ext !== ".kml") {
        setErr("Only .kml files are allowed for boundary.");
        return;
      }
    }
    if (pdfFile) {
      const ext = pdfFile.name.toLowerCase().slice(pdfFile.name.lastIndexOf("."));
      if (ext !== ".pdf" && ext !== ".dxf") {
        setErr("Only .pdf and .dxf files are allowed for layout drawing.");
        return;
      }
    }
    setBusy(true); setErr("");
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      if (kmlFile) fd.append("file", kmlFile);
      if (pdfFile) fd.append("layout_pdf", pdfFile);
      const r = await api.post("/admin/colonies", fd, { headers: { "Content-Type": "multipart/form-data" }, timeout: 300000 });
      setResult(r.data);
      setLiveStatus({ status: "running", progress: 10, stage: "Queued for processing..." });
      onCreated(r.data);
    } catch (ex) { setErr(errMsg(ex)); } finally { setBusy(false); }
  };

  if (result) {
    const isReady = liveStatus?.status === "ready" || result.import_summary;
    const progress = liveStatus?.progress ?? 20;
    const stage = liveStatus?.stage || "Processing layout files...";
    const plotCount = finalColony?.plots?.length || result.import_summary?.plots;

    return (
      <div className="lm-modal-shade" onClick={onClose}>
        <div className="lm-modal" onClick={(e) => e.stopPropagation()} data-testid="import-result-modal">
          <div className="lm-modal-head">
            <h3 className="flex items-center gap-2">
              {isReady ? (
                <>
                  <CheckCircle2 size={18} className="text-emerald-400" />
                  <span>Layout Ready</span>
                </>
              ) : (
                <>
                  <Loader2 size={18} className="animate-spin text-amber-400" />
                  <span>Pipeline Processing...</span>
                </>
              )}
            </h3>
            <button type="button" className="lm-icon-btn" onClick={onClose}><X size={14} /></button>
          </div>

          <p className="lm-muted">
            {isReady
              ? `${form.name || result.name} was mapped successfully from the uploaded KML boundary and layout drawing.`
              : `AI GIS pipeline is actively processing ${form.name || result.name}. Vectors, OCR labels, and plot boundaries are generating in the background.`}
          </p>

          {/* Active Processing Box */}
          {!isReady && (
            <div className="bg-amber-50/90 border border-amber-300 rounded-xl p-4 my-3 space-y-3 shadow-sm">
              <div className="flex items-center justify-between text-xs">
                <span className="text-amber-900 font-semibold flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
                  {stage}
                </span>
                <span className="font-mono text-amber-800 font-bold bg-amber-100/90 px-2 py-0.5 rounded border border-amber-300">
                  {progress}%
                </span>
              </div>
              <div className="w-full h-2 bg-amber-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-amber-500 to-emerald-600 transition-all duration-300"
                  style={{ width: `${Math.max(progress, 15)}%` }}
                />
              </div>
              <p className="text-[11px] text-[#64748B]">
                You can wait here or view on the dashboard. The colony card will show a live processing animation and update automatically when complete.
              </p>
            </div>
          )}

          {isReady && (
            <div className="lm-ps-areas lm-import-stats">
              <div><b>{plotCount || 0}</b><span>plots</span></div>
              <div><b>{finalColony?.zones?.length || result.import_summary?.zones || 0}</b><span>zones</span></div>
              <div><b>{finalColony?.colony?.greens?.length || result.import_summary?.greens || 0}</b><span>greens</span></div>
              <div><b>{finalColony?.colony?.roads?.length || result.import_summary?.roads || 0}</b><span>roads</span></div>
            </div>
          )}

          <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
            {!isReady ? (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="lm-btn-secondary"
                  style={{ flex: 1 }}
                >
                  View on Dashboard
                </button>
                <Link
                  to={`${base}/colonies/${result.id}`}
                  className="lm-btn-primary"
                  style={{ flex: 1, textDecoration: "none", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                >
                  Open Live Map <ArrowUpRight size={14} />
                </Link>
              </>
            ) : (
              <Link
                to={`${base}/colonies/${result.id}`}
                className="lm-btn-primary"
                style={{ flex: 1, textDecoration: "none", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                data-testid="open-imported-colony"
              >
                Open Map <ArrowUpRight size={14} />
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="lm-modal-shade" onClick={onClose}>
      <form className="lm-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} data-testid="create-colony-modal">
        <div className="lm-modal-head">
          <h3>New Colony (KML + PDF/DXF Pipeline)</h3>
          <button type="button" className="lm-icon-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <label>Colony name<input required data-testid="colony-name-input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Shri Ram Enclave" /></label>
        <fieldset className="lm-import-mode">
          <legend>Layout Source Files (KML + PDF/DXF)</legend>
          <p className="lm-muted">Upload the KML file (site boundary polygon) and layout file (PDF or DXF drawing) to create the colony map.</p>
          <label className={`lm-dropzone ${kmlFile ? "has-file" : ""}`} data-testid="colony-file-drop">
            <input type="file" accept=".kml,application/vnd.google-earth.kml+xml" hidden data-testid="colony-file-input" onChange={(e) => setKmlFile(e.target.files?.[0] || null)} />
            <Upload size={18} />
            {kmlFile ? <><b>{kmlFile.name}</b><small>{Math.round(kmlFile.size / 1024)} KB · click to replace</small></>
              : <><b>1 · KML File (.kml)</b><small>Upload KML file for site boundary & georeferenced GIS vectors.</small></>}
          </label>
          <label className={`lm-dropzone ${pdfFile ? "has-file" : ""}`}>
            <input type="file" accept=".pdf,.dxf,application/pdf" hidden data-testid="colony-pdf-input" onChange={(e) => setPdfFile(e.target.files?.[0] || null)} />
            <Upload size={18} />
            {pdfFile ? <><b>{pdfFile.name}</b><small>{Math.round(pdfFile.size / 1024)} KB · click to replace</small></>
              : <><b>2 · Layout Drawing File (.pdf, .dxf)</b><small>Upload layout drawing (PDF or DXF) for visual overlay & plot parcel extraction.</small></>}
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
  const [searchQuery, setSearchQuery] = useState("");
  const isSuper = user.role === "super_admin";

  const reload = () => {
    Promise.all([api.get("/admin/dashboard"), api.get("/admin/colonies")])
      .then(([a, b]) => { setDash(a.data); setColonies(b.data); })
      .catch((e) => setErr(errMsg(e)));
  };
  useEffect(() => { reload(); }, []);

  // Auto-poll colonies list when any colony is still processing
  useEffect(() => {
    const hasProcessing = colonies.some(
      (c) => c.processing_status === "running" || c.processing_status === "queued"
    );
    if (!hasProcessing) return;

    const interval = setInterval(() => {
      api
        .get("/admin/colonies")
        .then((res) => {
          setColonies(res.data);
          // If all just finished, also refresh dashboard totals
          if (!res.data.some((c) => c.processing_status === "running" || c.processing_status === "queued")) {
            api.get("/admin/dashboard").then((d) => setDash(d.data)).catch(() => {});
          }
        })
        .catch(() => {});
    }, 2500);

    return () => clearInterval(interval);
  }, [colonies]);

  const statIcons = {
    colonies: <Building2 size={16} className="text-emerald-400" />,
    plots: <Grid size={16} className="text-sky-400" />,
    available: <CheckCircle2 size={16} className="text-emerald-400" />,
    sold: <Tag size={16} className="text-rose-400" />,
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

  const filteredColonies = colonies.filter((c) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      c.name?.toLowerCase().includes(q) ||
      c.location?.toLowerCase().includes(q) ||
      c.owner?.name?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="lm-page-container" data-testid="admin-home-page">
      <header className="lm-modern-header">
        <div className="lm-modern-header-left">
          <span className="lm-modern-eyebrow">
            {isSuper ? "Super Admin Governance" : "Developer Admin Workspace"}
          </span>
          <h1 className="lm-modern-title">
            Welcome back, {user.name.split(" ")[0]}.
          </h1>
          <p className="lm-modern-subtitle">
            {isSuper
              ? "Platform-wide intelligence over every colony, plot parcel, and tenant administrator."
              : "Manage your active colonies, plot statuses, and public showcase links in real time."}
          </p>
        </div>
        <div className="lm-modern-header-actions">
          <button className="lm-btn-glow" onClick={() => setShowModal(true)} data-testid="create-colony-btn">
            <Plus size={16} /> New Colony
          </button>
        </div>
      </header>

      {/* KPI Stats Grid */}
      <section className="lm-stat-row" data-testid="stat-row">
        {stats.map(([label, value, slug]) => (
          <div className={`lm-stat ${slug}`} key={slug} data-testid={`stat-${slug}`}>
            <div className="flex items-center justify-between mb-1">
              <span>{label}</span>
              <div className="lm-stat-icon-wrap">
                {statIcons[slug]}
              </div>
            </div>
            <strong>{value}</strong>
          </div>
        ))}
      </section>

      {/* Colonies Section */}
      <section className="mt-8">
        <div className="lm-modern-toolbar">
          <div>
            <h2 className="text-xl font-bold font-serif text-[#0F1E36] tracking-tight">
              {isSuper ? "All Colonies" : "My Colonies"} ({colonies.length})
            </h2>
            <p className="text-xs text-[#64748B] mt-0.5">Select any colony to inspect 2D/3D map, plots, and inventory.</p>
          </div>

          <div className="lm-search-box">
            <MapPin size={14} className="text-[#164E3F]" />
            <input
              type="text"
              placeholder="Search colonies or location..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-testid="colony-search-input"
            />
          </div>
        </div>

        {err && (
          <div className="lm-badge-danger p-3 rounded-xl mb-4 text-xs font-medium w-full">
            {err}
          </div>
        )}

        <div className="lm-colony-grid">
          {filteredColonies.map((c) => {
            const isProcessing = c.processing_status === "running" || c.processing_status === "queued";
            return (
              <div className="lm-colony-card-wrap" key={c.id}>
                <Link
                  to={`${base}/colonies/${c.id}`}
                  className={`lm-colony-card ${isProcessing ? "is-processing" : ""}`}
                  data-testid={`admin-colony-card-${c.slug}`}
                >
                  <div className="lm-colony-art">
                    {isProcessing ? (
                      <>
                        <div className="lm-pipeline-scanner" />
                        <span className="lm-processing-tag">
                          <Loader2 size={11} className="animate-spin text-amber-400" />
                          <span>AI PROCESSING</span>
                        </span>
                        <div className="lm-pipeline-progress-bar">
                          <div
                            className="lm-pipeline-progress-fill"
                            style={{ width: `${Math.max(c.processing_progress || 0, 15)}%` }}
                          />
                        </div>
                      </>
                    ) : (
                      <span className={`lm-colony-tag ${c.public_enabled ? "text-emerald-400" : "text-slate-400"}`}>
                        {c.public_enabled ? "PUBLIC" : "DRAFT"}
                      </span>
                    )}
                    <div className="lm-contour" />
                  </div>
                  <div className="lm-colony-body">
                    <div style={{ flex: 1, minWidth: 0, paddingRight: "8px" }}>
                      <h3 style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</h3>
                      {isProcessing ? (
                        <p style={{ color: "#fbbf24", fontWeight: 600, fontSize: "11px", marginTop: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
                          <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#fbbf24" }} className="animate-ping" />
                          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {c.processing_stage || "Processing layout files..."}
                          </span>
                        </p>
                      ) : (
                        <p><MapPin size={13} className="text-emerald-400 shrink-0" /> {c.location || "Location unassigned"}</p>
                      )}
                      {isSuper && c.owner && (
                        <small className="lm-owner-chip text-indigo-400">by {c.owner.name} · /u/{c.owner.slug}</small>
                      )}
                    </div>
                    <div className="lm-colony-meta" style={{ flexShrink: 0 }}>
                      {isProcessing ? (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "3px" }}>
                          <div className="lm-processing-pill">
                            <Loader2 size={11} className="animate-spin text-amber-400" />
                            <span>{c.processing_progress ? `${c.processing_progress}%` : "5%"}</span>
                          </div>
                          <span style={{ fontSize: "9px", color: "#fbbf24", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>Mapping...</span>
                        </div>
                      ) : (
                        <>
                          <span className="font-mono">{c.plot_count}</span>
                          <small>plots</small>
                          <ArrowUpRight size={14} className="text-emerald-400" />
                        </>
                      )}
                    </div>
                  </div>
                </Link>
                <button
                  className="lm-card-delete"
                  title="Delete colony"
                  data-testid={`delete-colony-${c.slug}`}
                  onClick={async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!window.confirm(`Delete colony "${c.name}" and all its plots?`)) return;
                    try { await api.delete(`/admin/colonies/${c.id}`); reload(); } catch (errDelete) { setErr(errMsg(errDelete)); }
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          {!filteredColonies.length && (
            <div className="lm-empty-state col-span-full py-12 text-center text-[#64748B]">
              <p>No colonies match your search or none added yet.</p>
            </div>
          )}
        </div>
      </section>

      {showModal && <CreateColonyModal base={base} onClose={() => setShowModal(false)} onCreated={() => reload()} />}
    </div>
  );
}
