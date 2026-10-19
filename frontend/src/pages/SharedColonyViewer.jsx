import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  MapPin,
  MessageCircle,
  Maximize,
  Minimize,
  ShieldAlert,
  ShieldCheck,
  Compass,
  Info,
  RefreshCw,
  Satellite,
  Box,
} from "lucide-react";
import { api, errMsg } from "@/lib/api";
import InteractiveMap from "@/components/InteractiveMap";
import Canonical3DCanvas from "@/components/canonical/Canonical3DCanvas";
import PlotCard from "@/components/PlotCard";
import WhatsAppDialog from "@/components/WhatsAppDialog";

export default function SharedColonyViewer() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [verifyError, setVerifyError] = useState(null);
  const [data, setData] = useState(null);
  const [selectedPlot, setSelectedPlot] = useState(null);
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [viewMode, setViewMode] = useState("satellite"); // "satellite" | "3d"
  const [resetKey, setResetKey] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [waOpen, setWaOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastSynced, setLastSynced] = useState(null);

  // Get or initialize persistent client device UID
  const getDeviceUid = () => {
    let uid = localStorage.getItem("_sp_colony_dev_uid");
    if (!uid) {
      uid = "dev-" + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
      localStorage.setItem("_sp_colony_dev_uid", uid);
    }
    return uid;
  };

  // Initial load & device verification
  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setVerifyError(null);

    const deviceUid = getDeviceUid();
    const screenRes = `${window.screen.width}x${window.screen.height}`;

    api
      .post(`/public/colony-share/${token}/verify`, {
        device_uid: deviceUid,
        screen_resolution: screenRes,
      })
      .then(() => {
        return api.get(`/public/colony-share/${token}/data`);
      })
      .then((res) => {
        if (isMounted) {
          setData(res.data);
          setLastSynced(new Date());
        }
      })
      .catch((err) => {
        if (isMounted) {
          const detail = err.response?.data?.detail || errMsg(err);
          setVerifyError(detail);
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [token]);

  // Real-time live polling & auto-sync when admin/superadmin modifies anything
  useEffect(() => {
    if (!token || verifyError) return;

    let isMounted = true;

    const syncLatestData = async (silent = true) => {
      if (!silent) setIsRefreshing(true);
      try {
        const res = await api.get(`/public/colony-share/${token}/data`);
        if (!isMounted) return;

        setData((prevData) => {
          if (selectedPlot) {
            const updated = (res.data?.plots || []).find((p) => p.id === selectedPlot.id);
            if (updated) setSelectedPlot(updated);
          }
          return res.data;
        });
        setLastSynced(new Date());
      } catch (err) {
        if (!isMounted) return;
        if (err.response?.status === 403) {
          const detail = err.response?.data?.detail || "Link access revoked or expired.";
          setVerifyError(detail);
        }
      } finally {
        if (isMounted && !silent) setIsRefreshing(false);
      }
    };

    const interval = setInterval(() => {
      syncLatestData(true);
    }, 8000);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        syncLatestData(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      isMounted = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [token, verifyError, selectedPlot]);

  // Lookup maps
  const statusesById = useMemo(() => {
    return Object.fromEntries((data?.statuses || []).map((s) => [s.id, s]));
  }, [data?.statuses]);

  const zonesById = useMemo(() => {
    return Object.fromEntries((data?.zones || []).map((z) => [z.id, z]));
  }, [data?.zones]);

  // Filtered Plot IDs for InteractiveMap
  const filteredIds = useMemo(() => {
    if (!data?.plots || !selectedStatus) return null;
    return new Set(
      data.plots
        .filter((p) => p.status_id === selectedStatus)
        .map((p) => p.id)
    );
  }, [data?.plots, selectedStatus]);

  // Quick stats
  const stats = useMemo(() => {
    if (!data?.plots) return { total: 0, available: 0, booked: 0, sold: 0 };
    const total = data.plots.length;
    const available = data.plots.filter((p) => {
      const st = (p.status_id || "available").toLowerCase();
      return st === "available" || st === "avail";
    }).length;
    const booked = data.plots.filter((p) => (p.status_id || "").toLowerCase() === "booked").length;
    const sold = data.plots.filter((p) => (p.status_id || "").toLowerCase() === "sold").length;
    return { total, available, booked, sold };
  }, [data?.plots]);

  // 3D Dataset prepared for Canonical3DCanvas
  const dataset3D = useMemo(() => {
    if (!data) return null;
    return {
      plots: data.plots || [],
      roads: data.colony?.roads || [],
      greens: data.colony?.greens || [],
      boundary: data.colony?.boundary,
      colony_boundary: data.colony?.boundary,
      crs_metadata: data.colony?.crs_metadata || {
        crs_type: "geographic_wgs84",
        units: "deg",
      },
    };
  }, [data]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  const handleManualRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const res = await api.get(`/public/colony-share/${token}/data`);
      setData(res.data);
      if (selectedPlot) {
        const updated = (res.data?.plots || []).find((p) => p.id === selectedPlot.id);
        if (updated) setSelectedPlot(updated);
      }
      setLastSynced(new Date());
    } catch (err) {
      if (err.response?.status === 403) {
        setVerifyError(err.response?.data?.detail || "Link access revoked.");
      }
    } finally {
      setTimeout(() => setIsRefreshing(false), 400);
    }
  };

  // =========================================================================
  // 1. LOADING SCREEN
  // =========================================================================
  if (loading) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-[#172A25] flex flex-col items-center justify-center p-6 text-center space-y-4">
        <div className="w-16 h-16 rounded-3xl bg-[#173F35] text-white flex items-center justify-center shadow-2xl animate-pulse">
          <Compass size={32} />
        </div>
        <h2 className="text-xl font-bold tracking-tight text-[#172A25]">
          Loading Masterplan Presentation…
        </h2>
        <p className="text-xs text-[#5C6470] max-w-sm">
          Verifying secure device access and loading calibrated satellite layout.
        </p>
      </div>
    );
  }

  // =========================================================================
  // 2. DEVICE LIMIT BREACHED / EXPIRED / REVOKED SCREEN
  // =========================================================================
  if (verifyError || !data) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-[#172A25] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white border border-rose-200 shadow-2xl rounded-3xl p-7 text-center space-y-5">
          <div className="w-16 h-16 rounded-3xl bg-rose-100 text-rose-600 flex items-center justify-center mx-auto shadow-inner">
            <ShieldAlert size={32} />
          </div>

          <div className="space-y-2">
            <h2 className="text-lg font-bold tracking-tight text-[#172A25]">
              Access Link Expired / Restricted
            </h2>
            <p className="text-xs text-[#5C6470] leading-relaxed">
              {verifyError ||
                "This colony share link has expired or reached its maximum allowed device limit."}
            </p>
          </div>

          <div className="p-4 rounded-2xl bg-[#F3EFE6] border border-[#DCD2BE] text-xs space-y-1.5 text-left text-[#5C6470]">
            <span className="font-bold text-[#172A25] flex items-center gap-1.5">
              <Info size={14} className="text-[#173F35]" /> Why am I seeing this?
            </span>
            <p className="text-[11px] leading-normal">
              Property developers configure private links with a strict device threshold (e.g. 5 devices).
              When the link is opened across more devices than allowed, it automatically expires to protect project confidentiality.
            </p>
          </div>

          <div className="pt-2 flex flex-col gap-2.5">
            <a
              href="https://wa.me/?text=Hello!%20My%20colony%20masterplan%20share%20link%20has%20expired.%20Could%20you%20please%20send%20a%20new%20link?"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full py-3 rounded-xl bg-[#173F35] hover:bg-[#0F2922] text-white font-bold text-xs flex items-center justify-center gap-2 shadow-md transition"
            >
              <MessageCircle size={16} />
              Request New Link on WhatsApp
            </a>
            <Link
              to="/"
              className="w-full py-2.5 rounded-xl bg-[#F3EFE6] hover:bg-[#EDE6D6] text-[#172A25] font-semibold text-xs border border-[#DCD2BE] transition"
            >
              Back to LiveMap Platform
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const { colony } = data;

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 font-sans text-[#172A25]">
      {/* =====================================================================
          MAIN GIS VIEWPORT (SATELLITE 2D OR REAL 3D VIEW)
         ===================================================================== */}
      {viewMode === "satellite" ? (
        <div className="lm-gis-canvas">
          <InteractiveMap
            data={data}
            filteredPlotIds={filteredIds}
            selectedZone={null}
            setSelectedZone={() => {}}
            selectedPlot={selectedPlot}
            setSelectedPlot={setSelectedPlot}
            resetKey={resetKey}
            showZones={false}
            showStatus={true}
            showPdfArtwork={false}
            mapStyle="satellite"
            onWhatsApp={() => setWaOpen(true)}
            onEnquire={() => setWaOpen(true)}
          />
        </div>
      ) : (
        <div className="lm-gis-canvas">
          <Canonical3DCanvas
            dataset={dataset3D}
            selectedPlot={selectedPlot}
            onSelectPlot={setSelectedPlot}
            showStatusColors={true}
            zones={data.zones || []}
            zonesById={zonesById}
            hideTopBadges={true}
          />
        </div>
      )}

      {/* =====================================================================
          TOP FLOATING HEADER (Clean & Minimalist: Live, Available, Satellite, 3D, Fullscreen, Inquire)
         ===================================================================== */}
      <header className="absolute top-4 left-4 right-4 z-[900] flex flex-wrap items-center justify-between gap-3 pointer-events-none">
        {/* Brand & Project Info */}
        <div className="pointer-events-auto flex items-center gap-3 p-2 pr-4 rounded-2xl bg-white/95 backdrop-blur-md border border-[#DCD2BE] shadow-xl">
          <div className="w-10 h-10 rounded-xl bg-[#173F35] text-white flex items-center justify-center font-bold shadow-sm">
            <Compass size={20} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold tracking-tight text-[#172A25]" data-testid="shared-colony-title">
                {colony.name}
              </h1>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#F3EFE6] border border-[#DCD2BE] text-[#173F35]">
                Verified Layout
              </span>
            </div>
            <p className="text-[11px] text-[#5C6470] flex items-center gap-1 mt-0.5">
              <MapPin size={11} className="text-[#173F35]" />
              {colony.location || "Masterplan Enclave"}
            </p>
          </div>
        </div>

        {/* Right Header Controls: Live, Available, Satellite, 3D View, Fullscreen, Inquire */}
        <div className="pointer-events-auto flex items-center gap-2">
          {/* 1. Live Sync Status & Manual Refresh */}
          <button
            onClick={handleManualRefresh}
            title={lastSynced ? `Synced at ${lastSynced.toLocaleTimeString()} (Click to refresh)` : "Click to refresh"}
            className="flex items-center gap-1.5 p-2 px-3 rounded-2xl bg-white/95 backdrop-blur-md border border-[#DCD2BE] shadow-md text-xs font-semibold text-[#172A25] hover:bg-[#F4EFE6] transition"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Live</span>
            <RefreshCw size={12} className={`text-[#5C6470] ${isRefreshing ? "animate-spin" : ""}`} />
          </button>

          {/* 2. Available Plots Pill */}
          <div className="flex items-center gap-1.5 p-2 px-3 rounded-2xl bg-white/95 backdrop-blur-md border border-[#DCD2BE] shadow-md text-xs font-semibold text-emerald-700">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>{stats.available} Available</span>
          </div>

          {/* 3. Satellite View Button */}
          <button
            onClick={() => setViewMode("satellite")}
            className={`flex items-center gap-1.5 p-2 px-3.5 rounded-2xl border shadow-md font-semibold text-xs transition ${
              viewMode === "satellite"
                ? "bg-[#173F35] text-white border-[#173F35]"
                : "bg-white/95 text-[#5C6470] border-[#DCD2BE] hover:bg-[#F4EFE6] hover:text-[#172A25]"
            }`}
            title="Satellite 2D Layout"
            data-testid="toggle-satellite-view"
          >
            <Satellite size={14} />
            <span>Satellite</span>
          </button>

          {/* 4. 3D View Button */}
          <button
            onClick={() => setViewMode("3d")}
            className={`flex items-center gap-1.5 p-2 px-3.5 rounded-2xl border shadow-md font-semibold text-xs transition ${
              viewMode === "3d"
                ? "bg-[#173F35] text-white border-[#173F35]"
                : "bg-white/95 text-[#5C6470] border-[#DCD2BE] hover:bg-[#F4EFE6] hover:text-[#172A25]"
            }`}
            title="3D Spatial Spatial View"
            data-testid="toggle-3d-view"
          >
            <Box size={14} />
            <span>3D View</span>
          </button>

          {/* 5. Fullscreen Toggle */}
          <button
            onClick={toggleFullscreen}
            className="p-2 px-2.5 rounded-2xl bg-white/95 text-[#5C6470] hover:text-[#172A25] hover:bg-[#F4EFE6] border border-[#DCD2BE] shadow-md transition"
            title={isFullscreen ? "Exit Fullscreen" : "Fullscreen View"}
          >
            {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>

          {/* 6. Primary WhatsApp Inquiry CTA */}
          <button
            onClick={() => setWaOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md transition"
            data-testid="shared-whatsapp-cta"
          >
            <MessageCircle size={15} />
            <span className="hidden sm:inline">Inquire on WhatsApp</span>
          </button>
        </div>
      </header>

      {/* =====================================================================
          SELECTED PLOT DETAILS CARD (When a plot is clicked)
         ===================================================================== */}
      {selectedPlot && (
        <PlotCard
          plot={selectedPlot}
          status={statusesById[selectedPlot.status_id]}
          zone={zonesById[selectedPlot.zone_id]}
          onClose={() => setSelectedPlot(null)}
          onWhatsApp={() => setWaOpen(true)}
          onEnquire={() => setWaOpen(true)}
        />
      )}

      {/* =====================================================================
          COMPACT BOTTOM LEGEND DOCK (Available, Hold, Reserved, Sold, Blocked)
         ===================================================================== */}
      {viewMode !== "3d" && (
        <div className="lm-gis-legend-dock" data-testid="shared-legend-dock">
          {(data.statuses || []).map((s) => {
            const count = (data.plots || []).filter((p) => p.status_id === s.id).length;
            const isActive = selectedStatus === s.id;
            return (
              <button
                key={s.id}
                className={`lm-legend-pill ${isActive ? "active" : ""}`}
                onClick={() => setSelectedStatus(isActive ? null : s.id)}
                data-testid={`shared-status-filter-${s.id}`}
              >
                <i style={{ background: s.color }} />
                <span>{s.name}</span>
                <span className="lm-legend-pill-count">{count}</span>
              </button>
            );
          })}
          {(colony.roads || []).length > 0 && (
            <span className="lm-legend-feature-tag" data-testid="map-legend-roads">
              <i className="road" /> Road
            </span>
          )}
          {(colony.greens || []).length > 0 && (
            <span className="lm-legend-feature-tag" data-testid="map-legend-gardens">
              <i className="garden" /> Garden
            </span>
          )}
        </div>
      )}

      {/* =====================================================================
          WHATSAPP DIALOG
         ===================================================================== */}
      {waOpen && (
        <WhatsAppDialog
          colony={colony}
          plot={selectedPlot}
          zone={selectedPlot ? zonesById[selectedPlot.zone_id] : null}
          onClose={() => setWaOpen(false)}
        />
      )}

      {/* Discreet Security Badge Footer */}
      <div className="absolute bottom-4 right-4 z-[800] hidden md:flex items-center gap-2 px-3 py-1 rounded-xl bg-black/40 backdrop-blur-md text-[10px] text-white/80 pointer-events-none">
        <ShieldCheck size={12} className="text-emerald-400" />
        <span>Secure Client Link • Protected Session</span>
      </div>
    </div>
  );
}
