import { useState, useEffect, useMemo } from "react";
import { X, RotateCcw, Move, RotateCw, CheckCircle, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";
import { MapContainer, TileLayer, Polygon, useMap } from "react-leaflet";
import L from "leaflet";
import { api, errMsg } from "@/lib/api";
import CanvasImageOverlay from "@/components/CanvasImageOverlay";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

function toLeafletCoords(geo) {
  if (!geo || !geo.coordinates) return [];
  const coords = geo.type === "Polygon" ? geo.coordinates[0] : (geo.coordinates[0] ? geo.coordinates[0][0] : []);
  if (!Array.isArray(coords)) return [];
  return coords.map(([lng, lat]) => [lat, lng]);
}

function MapFit({ boundary }) {
  const map = useMap();
  useEffect(() => {
    const pts = toLeafletCoords(boundary);
    if (pts.length) {
      map.fitBounds(pts, { padding: [50, 50] });
    }
  }, [boundary, map]);
  return null;
}

export default function PlacementCalibrationModal({ colony, plots: initialPlots, onClose, onConfirmed }) {
  const pdfOverlay = colony.pdf_overlay;
  const isPdfOverlay = Boolean(pdfOverlay?.base_url && pdfOverlay?.bounds);
  const savedOverlayTransform = pdfOverlay?.transform || {};
  const [rotation, setRotation] = useState(
    isPdfOverlay ? savedOverlayTransform.rotation_deg || 0 : colony.placement?.transform?.rotation || 0,
  );
  const [tx, setTx] = useState(
    isPdfOverlay ? savedOverlayTransform.translation_x_m || 0 : colony.placement?.transform?.translation_x || 0,
  );
  const [ty, setTy] = useState(
    isPdfOverlay ? savedOverlayTransform.translation_y_m || 0 : colony.placement?.transform?.translation_y || 0,
  );
  const [scaleX, setScaleX] = useState(savedOverlayTransform.scale_x ?? 1);
  const [scaleY, setScaleY] = useState(savedOverlayTransform.scale_y ?? 1);
  const [stepSize, setStepSize] = useState(isPdfOverlay ? 5 : 0.00005);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [plots, setPlots] = useState(initialPlots || []);

  const boundaryPts = useMemo(() => toLeafletCoords(colony.boundary), [colony.boundary]);
  const center = useMemo(() => {
    if (colony.map_center?.lat && colony.map_center?.lng) {
      return [colony.map_center.lat, colony.map_center.lng];
    }
    if (boundaryPts.length) return boundaryPts[0];
    return [27.237, 78.244];
  }, [colony.map_center, boundaryPts]);

  // Apply real-time preview rotation/translation to plots locally
  const previewPlotPositions = useMemo(() => {
    if (isPdfOverlay) return [];
    const rad = (rotation * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    const cx = center[1]; // lng
    const cy = center[0]; // lat

    return plots.map((plot) => {
      const origGeo = plot.original_geometry || plot.geometry;
      const rawCoords = toLeafletCoords(origGeo);
      const transformed = rawCoords.map(([lat, lng]) => {
        const dlng = lng - cx;
        const dlat = lat - cy;
        const rLng = dlng * cosA - dlat * sinA;
        const rLat = dlng * sinA + dlat * cosA;
        return [cy + rLat + ty, cx + rLng + tx];
      });
      return { id: plot.id, number: plot.number, positions: transformed };
    });
  }, [plots, rotation, tx, ty, center, isPdfOverlay]);

  const handleRotate = (delta) => {
    setRotation((r) => Math.round((r + delta + 360) % 360 * 10) / 10);
  };

  const handleMove = (dir) => {
    if (dir === "N") setTy((v) => v + stepSize);
    if (dir === "S") setTy((v) => v - stepSize);
    if (dir === "E") setTx((v) => v + stepSize);
    if (dir === "W") setTx((v) => v - stepSize);
  };

  const handleReset = async () => {
    if (isPdfOverlay) {
      setRotation(0);
      setTx(0);
      setTy(0);
      setScaleX(1);
      setScaleY(1);
      setError("");
      return;
    }
    setResetting(true);
    setError("");
    try {
      const res = await api.post(`/admin/colonies/${colony.id || colony._id}/placement/reset`);
      const t = res.data.placement?.transform || {};
      setRotation(t.rotation || 0);
      setTx(t.translation_x || 0);
      setTy(t.translation_y || 0);
    } catch (err) {
      setError(`Reset failed: ${errMsg(err)}`);
    } finally {
      setResetting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      if (isPdfOverlay) {
        await api.patch(`/admin/colonies/${colony.id || colony._id}/pdf-overlay/transform`, {
          rotation_deg: rotation,
          scale_x: scaleX,
          scale_y: scaleY,
          translation_x_m: tx,
          translation_y_m: ty,
        });
      } else {
        await api.patch(`/admin/colonies/${colony.id || colony._id}/placement`, {
          rotation,
          translation_x: tx,
          translation_y: ty,
          placement_status: "confirmed",
        });
      }
      onConfirmed?.();
      onClose();
    } catch (err) {
      setError(`Save failed: ${errMsg(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-hidden">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-6xl h-[90vh] flex flex-col shadow-2xl overflow-hidden text-slate-100">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
              <Move className="text-violet-400" size={20} />
              Interactive Placement Calibration — {colony.name}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {isPdfOverlay
                ? "Preview rotation, position and aspect adjustments to the complete PDF image, then save the fitted overlay."
                : "Align the PDF layout plot drawing with satellite ground. Rotate and move the plot geometry."}
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition">
            <X size={18} />
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
          {/* Map Preview */}
          <div className="flex-1 relative bg-slate-950">
            <MapContainer center={center} zoom={17} scrollWheelZoom className="w-full h-full" zoomControl={false}>
              <TileLayer url={ESRI} attribution="Imagery &copy; Esri" maxZoom={22} maxNativeZoom={17} />
              <MapFit boundary={colony.boundary} />
              {isPdfOverlay && (
                <CanvasImageOverlay
                  overlay={pdfOverlay}
                  boundary={colony.boundary}
                  transform={{
                    rotation_deg: rotation,
                    scale_x: scaleX,
                    scale_y: scaleY,
                    translation_x_m: tx,
                    translation_y_m: ty,
                  }}
                />
              )}

              {/* Fixed Green KML Boundary */}
              {boundaryPts.length > 0 && (
                <Polygon
                  positions={boundaryPts}
                  interactive={false}
                  pathOptions={{ color: "#3fe081", weight: 3.5, fillColor: "#3fe081", fillOpacity: 0.1, dashArray: "6 6" }}
                />
              )}

              {/* Preview geometry only for vector-backed imports. */}
              {previewPlotPositions.map((p) => (
                <Polygon
                  key={p.id}
                  positions={p.positions}
                  interactive={false}
                  pathOptions={{ color: "#38bdf8", weight: 1.5, fillColor: "#0284c7", fillOpacity: 0.35 }}
                />
              ))}
            </MapContainer>

            {/* Map Legend */}
            <div className="absolute bottom-4 left-4 z-[1000] bg-slate-900/90 backdrop-blur border border-slate-700/60 rounded-xl px-3 py-2 text-[11px] space-y-1.5 shadow-lg">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm border-2 border-emerald-400 bg-emerald-400/20"></span>
                <span className="font-semibold text-emerald-300">KML Outer Land Boundary (Fixed Ground Truth)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm border-2 border-sky-400 bg-sky-500/40"></span>
                <span className="font-semibold text-sky-200">PDF Plot Layout Blueprint Overlay</span>
              </div>
            </div>
          </div>

          {/* Controls Sidebar */}
          <div className="w-full md:w-80 bg-slate-900 border-l border-slate-800 p-5 flex flex-col gap-5 overflow-y-auto">
            {/* ROTATION SECTION */}
            <div className="space-y-3 bg-slate-950/50 p-4 rounded-xl border border-slate-800">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase font-bold tracking-wider text-violet-400 flex items-center gap-1.5">
                  <RotateCw size={14} /> Rotation Angle
                </span>
                <span className="font-mono text-sm font-bold text-white bg-violet-950/80 px-2 py-0.5 rounded border border-violet-800/60">
                  {rotation.toFixed(1)}°
                </span>
              </div>

              <input
                type="range"
                min="0"
                max="360"
                step="0.5"
                value={rotation}
                onChange={(e) => setRotation(parseFloat(e.target.value))}
                className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-violet-500"
              />

              <div className="grid grid-cols-4 gap-1.5">
                <button onClick={() => handleRotate(-15)} className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded text-slate-300 transition">
                  -15°
                </button>
                <button onClick={() => handleRotate(-1)} className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded text-slate-300 transition">
                  -1°
                </button>
                <button onClick={() => handleRotate(1)} className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded text-slate-300 transition">
                  +1°
                </button>
                <button onClick={() => handleRotate(15)} className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded text-slate-300 transition">
                  +15°
                </button>
              </div>
            </div>

            {isPdfOverlay && (
              <div className="space-y-3 bg-slate-950/50 p-4 rounded-xl border border-slate-800">
                <span className="text-xs uppercase font-bold tracking-wider text-emerald-400">
                  Horizontal / Vertical Scale
                </span>
                <label className="block text-[11px] text-slate-400">
                  Horizontal · {scaleX.toFixed(3)}×
                  <input
                    type="range"
                    min="0.6"
                    max="1.4"
                    step="0.005"
                    value={scaleX}
                    onChange={(event) => setScaleX(Number(event.target.value))}
                    className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                  />
                </label>
                <label className="block text-[11px] text-slate-400">
                  Vertical · {scaleY.toFixed(3)}×
                  <input
                    type="range"
                    min="0.6"
                    max="1.4"
                    step="0.005"
                    value={scaleY}
                    onChange={(event) => setScaleY(Number(event.target.value))}
                    className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                  />
                </label>
              </div>
            )}

            {/* POSITION TRANSLATION SECTION */}
            <div className="space-y-3 bg-slate-950/50 p-4 rounded-xl border border-slate-800">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase font-bold tracking-wider text-sky-400 flex items-center gap-1.5">
                  <Move size={14} /> {isPdfOverlay ? "Image Offset (N / S / E / W)" : "Position Offset (N / S / E / W)"}
                </span>
              </div>

              {/* D-Pad Controls */}
              <div className="flex flex-col items-center gap-1.5 my-1">
                <button onClick={() => handleMove("N")} className="w-10 h-9 bg-slate-800 hover:bg-sky-600 text-white rounded-lg flex items-center justify-center font-bold text-xs transition shadow-sm">
                  N ↑
                </button>
                <div className="flex items-center gap-3">
                  <button onClick={() => handleMove("W")} className="w-10 h-9 bg-slate-800 hover:bg-sky-600 text-white rounded-lg flex items-center justify-center font-bold text-xs transition shadow-sm">
                    ← W
                  </button>
                  <button onClick={() => { setTx(0); setTy(0); }} className="w-9 h-9 bg-slate-850 hover:bg-slate-700 text-slate-400 rounded-lg flex items-center justify-center text-[10px] font-bold border border-slate-700">
                    CENTER
                  </button>
                  <button onClick={() => handleMove("E")} className="w-10 h-9 bg-slate-800 hover:bg-sky-600 text-white rounded-lg flex items-center justify-center font-bold text-xs transition shadow-sm">
                    E →
                  </button>
                </div>
                <button onClick={() => handleMove("S")} className="w-10 h-9 bg-slate-800 hover:bg-sky-600 text-white rounded-lg flex items-center justify-center font-bold text-xs transition shadow-sm">
                  S ↓
                </button>
              </div>

              {/* Step Size Selector */}
              <div className="flex items-center justify-between text-[11px] pt-1 border-t border-slate-800/80">
                <span className="text-slate-400">Step Size:</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setStepSize(isPdfOverlay ? 1 : 0.00001)}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold transition ${stepSize === (isPdfOverlay ? 1 : 0.00001) ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-400"}`}
                  >
                    {isPdfOverlay ? "Fine (1m)" : "Fine (~1m)"}
                  </button>
                  <button
                    onClick={() => setStepSize(isPdfOverlay ? 5 : 0.00005)}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold transition ${stepSize === (isPdfOverlay ? 5 : 0.00005) ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-400"}`}
                  >
                    {isPdfOverlay ? "Medium (5m)" : "Medium (~5m)"}
                  </button>
                  <button
                    onClick={() => setStepSize(isPdfOverlay ? 20 : 0.0002)}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold transition ${stepSize === (isPdfOverlay ? 20 : 0.0002) ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-400"}`}
                  >
                    {isPdfOverlay ? "Coarse (20m)" : "Coarse (~20m)"}
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <div className="p-3 bg-red-950/60 border border-red-800/60 rounded-xl text-xs text-red-300">
                {error}
              </div>
            )}

            {/* ACTION BUTTONS */}
            <div className="mt-auto space-y-2 pt-2 border-t border-slate-800">
              <button
                onClick={handleReset}
                disabled={resetting}
                className="w-full py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs rounded-xl flex items-center justify-center gap-2 transition"
              >
                <RotateCcw size={14} /> {resetting ? "Resetting…" : isPdfOverlay ? "Reset Automatic Fit" : "Reset Placement"}
              </button>

              <button
                onClick={handleSave}
                disabled={saving}
                className="w-full py-3 px-4 bg-violet-600 hover:bg-violet-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition shadow-lg shadow-violet-900/30"
              >
                <CheckCircle size={16} /> {saving ? "Saving Transformation…" : isPdfOverlay ? "Save Image Fit" : "Confirm & Save Placement"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
