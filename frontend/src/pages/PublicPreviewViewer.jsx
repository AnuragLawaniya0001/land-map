import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  MapPin,
  X,
  Menu,
  Search,
  LocateFixed,
  Layers,
  SlidersHorizontal,
  Maximize,
  Minimize,
} from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { fmt } from "@/lib/geo";
import InteractiveMap, { plotCenter } from "@/components/InteractiveMap";
import MapControls from "@/components/MapControls";
import PlotCard, { PlotSummary } from "@/components/PlotCard";
import WhatsAppDialog from "@/components/WhatsAppDialog";

export default function PublicPreviewViewer() {
  const { previewToken } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [selectedPlot, setSelectedPlot] = useState(null);
  const [selectedZone, setSelectedZone] = useState(null);
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [showZones, setShowZones] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [waOpen, setWaOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [userPos, setUserPos] = useState(null);
  const [flyTarget, setFlyTarget] = useState(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [shareMsg, setShareMsg] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    api
      .get(`/public/preview/${previewToken}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(errMsg(e)));
  }, [previewToken]);

  const filteredIds = useMemo(() => {
    if (!data) return null;
    const query = searchInput.trim().toLowerCase().replace(/^plot\s*/, "");
    if (!selectedZone && !selectedStatus && !query) return null;

    return new Set(
      data.plots
        .filter((p) => {
          const matchZone = !selectedZone || p.zone_id === selectedZone;
          const matchStatus = !selectedStatus || p.status_id === selectedStatus;
          const matchQuery =
            !query ||
            p.number.toLowerCase().includes(query) ||
            p.facing?.toLowerCase().includes(query);
          return matchZone && matchStatus && matchQuery;
        })
        .map((p) => p.id)
    );
  }, [data, selectedZone, selectedStatus, searchInput]);

  const flash = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(""), 2600);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  if (error)
    return (
      <div className="lm-error-page">
        <h2>Preview unavailable</h2>
        <p>{error}</p>
        <Link
          to="/owner-panel"
          className="lm-btn-primary px-6 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-lg font-semibold text-white transition"
        >
          Go to Control Panel
        </Link>
      </div>
    );

  if (!data) return <div className="lm-loading">Loading project preview map…</div>;

  const zonesById = Object.fromEntries(data.zones.map((z) => [z.id, z]));
  const statusesById = Object.fromEntries(data.statuses.map((s) => [s.id, s]));
  const colony = data.colony;

  const onSearch = (q) => {
    const clean = q.toLowerCase().replace(/^plot\s*/, "").trim();
    const m = data.plots.find(
      (p) => p.number.toLowerCase() === clean || p.number.toLowerCase().includes(clean)
    );
    if (m) setSelectedPlot(m);
    else flash(`No plot matching "${q}" in ${colony.name}`);
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === "Enter" && searchInput.trim()) {
      onSearch(searchInput.trim());
    }
    if (e.key === "Escape") {
      setSearchInput("");
    }
  };

  const onGps = () => {
    if (!navigator.geolocation) {
      flash("GPS not supported on this device");
      return;
    }
    setGpsBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = [pos.coords.latitude, pos.coords.longitude];
        setUserPos(p);
        setFlyTarget({ pos: p, zoom: 17 });
        setGpsBusy(false);
      },
      () => {
        setGpsBusy(false);
        flash("Location permission denied");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const onShare = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: colony.name, url });
      else {
        await navigator.clipboard.writeText(url);
        setShareMsg("Preview Link copied");
        setTimeout(() => setShareMsg(""), 2000);
      }
    } catch {
      /* cancelled */
    }
  };

  return (
    <div className="lm-stage" data-testid="public-preview-viewer">
      <InteractiveMap
        data={data}
        filteredPlotIds={filteredIds}
        selectedZone={selectedZone}
        setSelectedZone={setSelectedZone}
        selectedPlot={selectedPlot}
        setSelectedPlot={setSelectedPlot}
        resetKey={resetKey}
        showZones={showZones}
        showStatus={showStatus}
        userPos={userPos}
        flyTarget={flyTarget}
      />

      {/* Modern Floating Top Bar (Matching Reference Screenshot) */}
      <header className="lm-modern-topbar">
        <div className="lm-topbar-left">
          <button
            className="lm-topbar-icon-btn"
            onClick={() => setInfoOpen((o) => !o)}
            title="Project Menu & Details"
            aria-label="Open menu"
          >
            <Menu size={19} />
          </button>

          {/* Search plots or features pill */}
          <div className="lm-topbar-search-pill" data-testid="topbar-search">
            <Search size={16} />
            <input
              type="text"
              placeholder="Search plots or features"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              data-testid="search-input"
            />
            {searchInput && (
              <button
                type="button"
                className="text-slate-400 hover:text-white"
                onClick={() => setSearchInput("")}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="lm-topbar-right">
          <button
            className={`lm-topbar-icon-btn ${gpsBusy ? "opacity-60" : ""}`}
            onClick={onGps}
            title="Locate via GPS"
            aria-label="GPS location"
            data-testid="gps-btn"
          >
            <LocateFixed size={18} />
          </button>

          <button
            className={`lm-topbar-icon-btn ${showZones ? "active" : ""}`}
            onClick={() => {
              setShowZones((v) => !v);
              if (showZones) setSelectedZone(null);
            }}
            title="Toggle Zones & Layers"
            aria-label="Toggle layers"
            data-testid="toggle-zones"
          >
            <Layers size={18} />
          </button>

          <button
            className={`lm-topbar-icon-btn ${showStatus ? "active" : ""}`}
            onClick={() => {
              setShowStatus((v) => !v);
              if (showStatus) setSelectedStatus(null);
            }}
            title="Filter Plot Status"
            aria-label="Filter status"
            data-testid="toggle-status"
          >
            <SlidersHorizontal size={18} />
          </button>

          <button
            className="lm-topbar-icon-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit Fullscreen" : "Fullscreen View"}
            aria-label="Toggle fullscreen"
          >
            {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
          </button>
        </div>
      </header>

      {/* Brand & Preview Badge Bar */}
      <header className="lm-stage-brand" style={{ top: "72px" }}>
        <div className="lm-stage-logo">
          <span className="lm-brand-dot bg-amber-400" />
        </div>
        <div>
          <h1 data-testid="preview-colony-name" className="flex items-center gap-2">
            {colony.name}
            <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
              Live Preview
            </span>
          </h1>
          <p>
            <MapPin size={11} /> {colony.location}
          </p>
        </div>
      </header>

      {/* Filter strip for zones and statuses */}
      {(showZones || showStatus) && (
        <div className="lm-filter-strip" style={{ top: "72px" }} data-testid="filter-strip">
          {showZones &&
            data.zones.map((z) => (
              <button
                key={z.id}
                className={`lm-fchip ${selectedZone === z.id ? "on" : ""}`}
                style={{ "--c": z.color }}
                onClick={() => setSelectedZone(selectedZone === z.id ? null : z.id)}
                data-testid={`zone-chip-${z.code}`}
              >
                <i /> {z.name}{" "}
                <span>{data.plots.filter((p) => p.zone_id === z.id).length}</span>
              </button>
            ))}
          {showZones && showStatus && <span className="lm-fsep" />}
          {showStatus &&
            data.statuses.map((s) => (
              <button
                key={s.id}
                className={`lm-fchip ${selectedStatus === s.id ? "on" : ""}`}
                style={{ "--c": s.color }}
                onClick={() => setSelectedStatus(selectedStatus === s.id ? null : s.id)}
                data-testid={`status-filter-${s.id}`}
              >
                <i /> {s.name}{" "}
                <span>{data.plots.filter((p) => p.status_id === s.id).length}</span>
              </button>
            ))}
        </div>
      )}

      {/* Selected Plot Modern Card */}
      {selectedPlot && (
        <PlotCard
          plot={selectedPlot}
          status={statusesById[selectedPlot.status_id]}
          zone={zonesById[selectedPlot.zone_id]}
          onClose={() => setSelectedPlot(null)}
          onWhatsApp={() => setWaOpen(true)}
          onEnquire={() => setWaOpen(true)}
          onShare={onShare}
        />
      )}

      {infoOpen && (
        <div className="lm-info-card" data-testid="info-card">
          <div className="lm-plot-card-head">
            <div>
              <p className="lm-eyebrow light">PROJECT PREVIEW</p>
              <h2>{colony.name}</h2>
            </div>
            <button
              className="lm-card-icon-btn"
              onClick={() => setInfoOpen(false)}
              data-testid="info-close"
              aria-label="Close info"
            >
              <X size={16} />
            </button>
          </div>
          <p className="lm-info-desc">{colony.description}</p>
          <div className="lm-ps-areas">
            <div>
              <b>{colony.pdf_overlay?.plot_count ?? data.plots.length}</b>
              <span>
                {colony.pdf_overlay
                  ? `${colony.pdf_overlay.source_type === "cad" ? "CAD" : "PDF"} plot labels`
                  : "plots"}
              </span>
            </div>
            <div>
              <b>{data.zones.length}</b>
              <span>zones</span>
            </div>
            <div>
              <b>{fmt(colony.total_area_sqm || 0)}</b>
              <span>sq m land</span>
            </div>
          </div>
          <p className="lm-info-foot">
            {colony.location} · Entry via {colony.map_road}
          </p>
        </div>
      )}

      <MapControls
        showZones={showZones}
        setShowZones={(v) => {
          setShowZones(v);
          if (!v) setSelectedZone(null);
        }}
        showStatus={showStatus}
        setShowStatus={(v) => {
          setShowStatus(v);
          if (!v) setSelectedStatus(null);
        }}
        selectedPlot={selectedPlot}
        onWhatsApp={() => setWaOpen(true)}
        onShare={onShare}
        onSearch={onSearch}
        onGps={onGps}
        gpsBusy={gpsBusy}
        onLocate={() => {
          setFlyTarget(null);
          setResetKey((k) => k + 1);
        }}
        onInfo={() => setInfoOpen((o) => !o)}
        shareMsg={shareMsg}
      />

      {notice && (
        <div className="lm-notice" data-testid="map-notice">
          {notice}
        </div>
      )}

      {waOpen && (
        <WhatsAppDialog
          colony={colony}
          plot={selectedPlot}
          zone={selectedPlot ? zonesById[selectedPlot.zone_id] : null}
          onClose={() => setWaOpen(false)}
        />
      )}
    </div>
  );
}
