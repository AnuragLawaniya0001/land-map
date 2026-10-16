import { useEffect, useMemo, useRef, useState, Fragment } from "react";
import { MapContainer, TileLayer, ImageOverlay, Polygon, Polyline, Tooltip, Marker, CircleMarker, Pane, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { LocateFixed, Image as ImageIcon, Share2, X, MessageSquare } from "lucide-react";
import {
  toLeaflet, ring, centroid, edgeDims, areaConversions, fmt, mToFt, pxPerMeter, polyMetrics, fitFont,
  findPlotAtPoint, geoJSONBounds, geoJSONToLatLngs, isSelectablePlotGeometry, transformOverlayGeometry,
  estimatePlotDimensions, getUnrepresentedPdfPlots, transformOverlayPoint, geoJSONContainsPoint,
} from "@/lib/geo";
import { BACKEND } from "@/lib/api";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const SELECTED_SCALE = 1.12; // selected plot number + area ~12% larger
const normalizePlotLabel = (number) =>
  String(number ?? "").trim().toUpperCase().replace(/^PLOT\s*(?:NO\.?\s*)?/, "").replace(/[\s/-]/g, "");
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
}[character]));
function createAerialTreeIcon(size = 30, id = 0) {
  const gradId = `tree-canopy-${id}`;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100" class="lm-aerial-tree lm-tree-breeze">
      <defs>
        <radialGradient id="${gradId}" cx="36%" cy="34%" r="66%">
          <stop offset="0%" stop-color="#86efac" stop-opacity="0.95" />
          <stop offset="20%" stop-color="#4ade80" />
          <stop offset="55%" stop-color="#16a34a" />
          <stop offset="85%" stop-color="#15803d" />
          <stop offset="100%" stop-color="#052e16" />
        </radialGradient>
      </defs>
      <!-- Ground Drop Shadow (simulating 10am sun from NW) -->
      <ellipse cx="55" cy="58" rx="36" ry="32" fill="rgba(3,24,10,0.52)" filter="blur(4px)" />
      <!-- Multi-cluster organic foliage crown as seen from drone orthophoto -->
      <circle cx="50" cy="50" r="36" fill="url(#${gradId})" />
      <circle cx="40" cy="36" r="22" fill="url(#${gradId})" opacity="0.95" />
      <circle cx="62" cy="42" r="20" fill="url(#${gradId})" opacity="0.9" />
      <circle cx="44" cy="62" r="21" fill="url(#${gradId})" opacity="0.92" />
      <circle cx="60" cy="58" r="18" fill="url(#${gradId})" opacity="0.88" />
      <!-- Leaf highlights on sunward crest -->
      <ellipse cx="38" cy="34" rx="14" ry="9" fill="#bbf7d0" opacity="0.55" />
      <ellipse cx="54" cy="38" rx="8" ry="6" fill="#bbf7d0" opacity="0.4" />
      <!-- Central crown anchor -->
      <circle cx="49" cy="48" r="3.2" fill="#032109" opacity="0.45" />
    </svg>
  `;
  return L.divIcon({
    className: "lm-aerial-tree-marker",
    html: svg,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function createAerialWaterPoolIcon(width = 44, height = 28) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 120 76" class="lm-aerial-pool">
      <defs>
        <radialGradient id="aerial-water" cx="44%" cy="40%" r="66%">
          <stop offset="0%" stop-color="#bae6fd" />
          <stop offset="28%" stop-color="#38bdf8" />
          <stop offset="68%" stop-color="#0284c7" />
          <stop offset="100%" stop-color="#0369a1" />
        </radialGradient>
      </defs>
      <!-- Ground shadow under pool rim -->
      <rect x="7" y="9" width="108" height="62" rx="31" fill="rgba(2,18,8,0.48)" filter="blur(3px)" />
      <!-- Architectural coping stone rim -->
      <rect x="4" y="4" width="112" height="68" rx="34" fill="#f1f5f9" stroke="#94a3b8" stroke-width="2.5" />
      <!-- Water basin -->
      <rect x="10" y="10" width="100" height="56" rx="28" fill="url(#aerial-water)" />
      <!-- Water shimmer ring -->
      <ellipse cx="60" cy="38" rx="34" ry="17" fill="none" stroke="#e0f2fe" stroke-width="1.4" opacity="0.75" class="lm-pool-water-shimmer" />
      <circle cx="60" cy="38" r="3.5" fill="#ffffff" />
    </svg>
  `;
  return L.divIcon({
    className: "lm-aerial-pool-marker",
    html: svg,
    iconSize: [width, height],
    iconAnchor: [width / 2, height / 2],
  });
}

function getPolygonPerimeterPoints(rawPts, count = 6) {
  if (!rawPts || rawPts.length === 0) return [];
  const coords = Array.isArray(rawPts[0]) && Array.isArray(rawPts[0][0]) ? rawPts[0] : rawPts;
  if (!coords || coords.length < 3) return [];

  const segments = [];
  let totalLen = 0;
  for (let i = 0; i < coords.length; i++) {
    const p1 = coords[i];
    const p2 = coords[(i + 1) % coords.length];
    const lat1 = Array.isArray(p1) ? p1[0] : p1.lat;
    const lng1 = Array.isArray(p1) ? p1[1] : p1.lng;
    const lat2 = Array.isArray(p2) ? p2[0] : p2.lat;
    const lng2 = Array.isArray(p2) ? p2[1] : p2.lng;
    const d = Math.hypot(lat2 - lat1, (lng2 - lng1) * Math.cos((lat1 * Math.PI) / 180));
    segments.push({ p1: [lat1, lng1], p2: [lat2, lng2], len: d });
    totalLen += d;
  }
  if (totalLen <= 0) return [];

  const points = [];
  const step = totalLen / count;
  for (let i = 0; i < count; i++) {
    const target = (i + 0.5) * step;
    let accum = 0;
    for (const seg of segments) {
      if (accum + seg.len >= target || seg === segments[segments.length - 1]) {
        const segProgress = seg.len > 0 ? (target - accum) / seg.len : 0.5;
        const clampedProgress = Math.max(0, Math.min(1, segProgress));
        const lat = seg.p1[0] + clampedProgress * (seg.p2[0] - seg.p1[0]);
        const lng = seg.p1[1] + clampedProgress * (seg.p2[1] - seg.p1[1]);
        points.push([lat, lng]);
        break;
      }
      accum += seg.len;
    }
  }
  return points;
}

function FitBounds({ data, resetKey, entrancePosition }) {
  const map = useMap();
  useEffect(() => {
    const doFit = (animate = false) => {
      if (!map) return;
      map.invalidateSize({ pan: false });
      const b = data?.colony?.boundary;
      let bounds = null;
      if (b) {
        const geo = L.geoJSON(b);
        const gb = geo.getBounds();
        if (gb.isValid()) bounds = gb;
      }
      if (!bounds && data?.plots?.length) {
        const group = L.featureGroup(
          data.plots.filter((p) => p.geometry).map((p) => L.geoJSON(p.geometry))
        );
        const gb = group.getBounds();
        if (gb.isValid()) bounds = gb;
      }
      if (!bounds || !bounds.isValid()) return;

      const fitB = L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
      if (entrancePosition && Array.isArray(entrancePosition) && entrancePosition.length >= 2) {
        fitB.extend(entrancePosition);
      }

      const fitOptions = {
        paddingTopLeft: [8, 8],
        paddingBottomRight: [12, 8],
        maxZoom: 22,
      };

      if (animate) {
        map.flyToBounds(fitB, { ...fitOptions, duration: 0.5 });
      } else {
        map.fitBounds(fitB, { ...fitOptions, animate: false });
      }
    };

    doFit(Boolean(resetKey));
    const timer = setTimeout(() => doFit(Boolean(resetKey)), 80);
    return () => clearTimeout(timer);
  }, [data?.colony?.id, data?.colony?.boundary, resetKey, entrancePosition, map]);
  return null;
}

function FocusPlot({ selected, geometry }) {
  const map = useMap();
  useEffect(() => {
    if (!selected) return;
    const bounds = L.geoJSON(geometry || selected.geometry).getBounds();
    if (bounds.isValid()) {
      map.flyToBounds(bounds, { padding: [90, 90], duration: 0.7, maxZoom: 21.5 });
    }
  }, [selected?.id, geometry, map]); // eslint-disable-line
  return null;
}

function FlyTo({ target }) {
  const map = useMap();
  useEffect(() => { if (target) map.flyTo(target.pos, target.zoom || 17, { duration: 0.8 }); }, [target]); // eslint-disable-line
  return null;
}

function MapWatcher({ onMapClick, onZoom }) {
  const map = useMapEvents({
    zoom: () => onZoom(map.getZoom()),
    click: (event) => onMapClick?.(event),
  });
  useEffect(() => { onZoom(map.getZoom()); }, []); // eslint-disable-line
  return null;
}

function MapResizeObserver() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => {
      map.invalidateSize({ pan: false, debounceMoveend: true });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);
  return null;
}

function PlotSelectionManager({ selectedPlot, setSelectedPlot, colonyBoundary, entrancePosition, clearSelectionRef }) {
  const map = useMap();
  const hadSelection = useRef(Boolean(selectedPlot));
  const clearSelection = () => setSelectedPlot(null);

  useEffect(() => {
    clearSelectionRef.current = clearSelection;
    return () => { clearSelectionRef.current = null; };
  }, [clearSelectionRef]); // eslint-disable-line

  useEffect(() => {
    if (selectedPlot) {
      hadSelection.current = true;
      return;
    }
    if (!hadSelection.current) return;
    hadSelection.current = false;
    const bounds = L.geoJSON(colonyBoundary).getBounds();
    if (bounds.isValid()) {
      const fitB = L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
      if (entrancePosition && Array.isArray(entrancePosition) && entrancePosition.length >= 2) {
        fitB.extend(entrancePosition);
      }
      map.invalidateSize({ pan: false });
      map.flyToBounds(fitB, {
        paddingTopLeft: [8, 8],
        paddingBottomRight: [12, 8],
        duration: 0.5,
        maxZoom: 22,
      });
    }
  }, [selectedPlot?.id, colonyBoundary, entrancePosition, map]); // eslint-disable-line

  useEffect(() => {
    if (!selectedPlot) return undefined;
    const onKeyDown = (event) => {
      const target = event.target;
      if (event.key !== "Escape" || target?.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)) return;
      clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedPlot?.id, colonyBoundary]); // eslint-disable-line

  return null;
}

// Label whose font is computed so the text always fits inside its polygon
function FitLabel({ positions, lines, ppm, className, rotate = true, minFont = 8, max = 48, chars, testId, fill = 0.8, fontCap, scale = 1, metrics }) {
  const own = useMemo(() => polyMetrics(positions), [positions]);
  const m = metrics || own;
  if (!m) return null;
  const longest = Math.max(...lines.map((l) => l.length), chars || 0);
  const lenPx = m.longest * ppm;
  const thickPx = (m.thickness * ppm) / Math.max(1, lines.length * 0.95);
  let font = Math.max(8.5, Math.min(max, fitFont(lenPx, thickPx, longest, { max, fill }) * scale));
  if (fontCap) font = Math.max(8, Math.min(font, fontCap));
  return (
    <Tooltip permanent direction="center" className={`lm-fit ${className || ""}`} interactive={false}>
      <span data-testid={testId} style={{ fontSize: font, transform: rotate ? `rotate(${m.angle}deg)` : undefined }}>
        {lines.map((l, i) => <em key={i}>{l}</em>)}
      </span>
    </Tooltip>
  );
}

export default function InteractiveMap({
  data, filteredPlotIds, selectedZone, setSelectedZone, selectedPlot, setSelectedPlot,
  resetKey, showZones = false, showStatus = true, showPdfArtwork, mapStyle = "satellite", userPos, flyTarget,
  onWhatsApp, onEnquire, onShare, onManageMedia,
}) {
  const [zoom, setZoom] = useState(17);
  const [hoveredPlotId, setHoveredPlotId] = useState(null);
  const clearSelectionRef = useRef(null);
  const statuses = useMemo(() => Object.fromEntries((data?.statuses || []).map((s) => [s.id, s])), [data]);
  const zones = useMemo(() => Object.fromEntries((data?.zones || []).map((z) => [z.id, z])), [data]);
  const plotGeo = useMemo(() => Object.fromEntries((data?.plots || []).map((p) => {
    const geometry = p.geometry;
    const pos = geoJSONToLatLngs(geometry);
    const metricsPositions = geometry?.type === "Polygon" ? pos[0] : pos[0]?.[0];
    return [p.id, {
      pos,
      geometry,
      bounds: geoJSONBounds(geometry),
      selectable: isSelectablePlotGeometry(geometry),
      m: polyMetrics(metricsPositions || []),
    }];
  })), [data]);
  const existingSelectablePlots = useMemo(
    () => (data?.plots || []).filter((plot) => plotGeo[plot.id]?.selectable),
    [data?.plots, plotGeo],
  );
  const pdfOverlayPlots = useMemo(() => {
    return (data?.colony?.pdf_overlay?.plot_regions || []).flatMap((region, index) => {
      const geometry = transformOverlayGeometry(
        region.geometry,
        data?.colony?.pdf_overlay?.bounds,
        data?.colony?.pdf_overlay?.transform,
      );
      if (!isSelectablePlotGeometry(geometry)) return [];
      return [{
        id: region.id,
        number: region.number || `R-${String(index + 1).padStart(3, "0")}`,
        original_number: region.number || null,
        is_generated_candidate_id: !region.number,
        geometry,
        area_sqm: region.area_sqm,
        detection_confidence: region.detection_confidence,
        confidence_type: region.confidence_type,
        status_id: region.status_id || "available",
        is_pdf_detected: true,
      }];
    });
  }, [data?.colony?.pdf_overlay]);
  const pdfTextAnnotations = useMemo(() => {
    const overlay = data?.colony?.pdf_overlay;
    if (zoom < 19 || !overlay?.fit?.pdf_text_annotations?.length) return [];
    const savedPlotNumbers = new Set(existingSelectablePlots.map((plot) => normalizePlotLabel(plot.number)));
    const candidates = overlay.fit.pdf_text_annotations.flatMap((annotation, index) => {
      if (!["plot", "road", "place", "dimension", "text"].includes(annotation.type)) return [];
      const coordinates = transformOverlayPoint(
        annotation.geometry?.coordinates,
        overlay.bounds,
        overlay.transform,
      );
      if (!Array.isArray(coordinates) || coordinates.length < 2 ||
          !coordinates.slice(0, 2).every(Number.isFinite)) return [];
      const normalizedText = normalizePlotLabel(annotation.text);
      if (savedPlotNumbers.has(normalizedText)) return [];
      return [{
        id: `${index}-${annotation.type}`,
        text: annotation.text,
        type: annotation.type,
        angle: Number.isFinite(annotation.angle_deg) ? annotation.angle_deg : 0,
        position: [coordinates[1], coordinates[0]],
        projected: L.CRS.EPSG3857.project(L.latLng(coordinates[1], coordinates[0])),
      }];
    });
    const scale = L.CRS.EPSG3857.scale(zoom) / (2 * Math.PI * 6378137);
    const annotationPriority = ["plot", "dimension", "road", "place", "text"];
    const prioritized = candidates.sort((a, b) =>
      annotationPriority.indexOf(a.type) - annotationPriority.indexOf(b.type)
    );
    const accepted = [];
    const annotationGrid = new Map();
    for (const candidate of prioritized) {
      const cellSize = candidate.type === "road" ? 30
        : candidate.type === "dimension" ? 18
          : candidate.type === "text" ? 12 : 22;
      const pixelX = candidate.projected.x * scale;
      const pixelY = candidate.projected.y * scale;
      const gridX = Math.floor(pixelX / cellSize);
      const gridY = Math.floor(pixelY / cellSize);
      let collides = false;
      for (let x = gridX - 1; x <= gridX + 1 && !collides; x += 1) {
        for (let y = gridY - 1; y <= gridY + 1 && !collides; y += 1) {
          for (const other of annotationGrid.get(`${candidate.type}:${x}:${y}`) || []) {
            const dx = pixelX - other.x;
            const dy = pixelY - other.y;
            if (dx * dx + dy * dy < cellSize * cellSize) {
              collides = true;
              break;
            }
          }
        }
      }
      if (!collides) {
        accepted.push(candidate);
        const key = `${candidate.type}:${gridX}:${gridY}`;
        annotationGrid.set(key, [...(annotationGrid.get(key) || []), { x: pixelX, y: pixelY }]);
      }
    }
    return accepted.map(({ projected, ...annotation }) => annotation);
  }, [data?.colony?.pdf_overlay, existingSelectablePlots, zoom]);
  const virtualPlots = useMemo(
    () => getUnrepresentedPdfPlots(existingSelectablePlots, pdfOverlayPlots),
    [existingSelectablePlots, pdfOverlayPlots],
  );
  const virtualPlotGeo = useMemo(() => Object.fromEntries(virtualPlots.map((plot) => [
    plot.id,
    { geometry: plot.geometry, pos: geoJSONToLatLngs(plot.geometry), bounds: geoJSONBounds(plot.geometry) },
  ])), [virtualPlots]);
  const selectablePlots = [
    ...existingSelectablePlots.map((plot) => ({
      ...plot,
      selectionGeometry: plotGeo[plot.id]?.geometry,
    })),
    ...virtualPlots,
  ];

  // Uniform plot-number size: every plot uses the selected plot's number size (or the median size when nothing is selected)
  const uniformFont = useMemo(() => {
    if (!data?.plots?.length) return undefined;
    const lat = data.colony?.map_center?.lat || 0;
    const ppm0 = pxPerMeter(zoom, lat);
    const fontFor = (p, lines) => {
      const g = plotGeo[p.id];
      if (!g?.m) return 0;
      return fitFont(g.m.longest * ppm0, (g.m.thickness * ppm0) / Math.max(1, lines * 0.95), 3, { max: 64, fill: 0.55 });
    };
    if (selectedPlot) return fontFor(selectedPlot, 4); // others match the selected number; the selected one is scaled up ~12%
    const fonts = data.plots.map((p) => fontFor(p, 1)).filter(Boolean).sort((a, b) => a - b);
    return fonts[Math.floor(fonts.length / 2)];
  }, [data, plotGeo, zoom, selectedPlot?.id]); // eslint-disable-line

  if (!data?.colony) return <div className="lm-map-loading">Loading map…</div>;
  const colony = data.colony;
  const center = [colony.map_center.lat, colony.map_center.lng];
  const ppm = pxPerMeter(zoom, center[0]);
  const boundary = toLeaflet(colony.boundary);
  const hasPdfOverlay = Boolean(colony.pdf_overlay?.url && colony.pdf_overlay?.bounds);
  const pdfArtworkVisible = showPdfArtwork ?? (hasPdfOverlay && existingSelectablePlots.length === 0);
  const entryRoad = toLeaflet(colony.entry_road);
  const entrance = colony.entrance?.coordinates;
  const dims = selectedPlot ? edgeDims(toLeaflet(selectedPlot.geometry)) : [];
  const selectablePlotCount = selectablePlots.length;
  const selectedGeometry = selectedPlot
    ? plotGeo[selectedPlot.id]?.geometry || virtualPlotGeo[selectedPlot.id]?.geometry
    : null;
  const selectPlotAtPoint = (event) => {
    const point = [event.latlng.lat, event.latlng.lng];
    setSelectedPlot(findPlotAtPoint(selectablePlots, point, colony.boundary));
  };
  const roadLabel = (r) => {
    let raw = String(r.source_label || r.name || "").trim();
    const match = raw.match(/(\d+(?:[.'’]\d+)?\s*(?:'|FT|MT|M|FEET)?(?:-\d+")?)/i);
    if (match) {
      const dim = match[1].trim();
      return `${dim} WIDE ROAD`.replace(/\s+/g, " ");
    }
    const ft = r.width_m ? Math.round(mToFt(r.width_m)) : 25;
    return `${ft}' WIDE ROAD`;
  };

  // Declutter road labels: only label prominent road corridors (length >= 26m), avoiding clustered badges
  const roadLabels = useMemo(() => {
    if (!colony.roads?.length) return {};
    const labels = {};
    const centers = [];
    colony.roads.forEach((r, i) => {
      const pts = toLeaflet(r.geometry);
      const m = polyMetrics(pts);
      if (!m || m.longest < 26 || m.thickness < 2.0) return;
      if (colony.boundary && !geoJSONContainsPoint(colony.boundary, [m.center[1], m.center[0]])) return;
      const isFarEnough = centers.every((c) => {
        const dLat = (c[0] - m.center[0]) * 111320;
        const dLng = (c[1] - m.center[1]) * 111320 * Math.cos((m.center[0] * Math.PI) / 180);
        return Math.hypot(dLat, dLng) > 35;
      });
      if (isFarEnough) {
        labels[i] = { pts, m, text: roadLabel(r) };
        centers.push(m.center);
      }
    });
    return labels;
  }, [colony.roads, colony.boundary]);

  // Effective greenery / central park zones (uses real extracted colony.greens)
  const effectiveGreens = useMemo(() => {
    if (colony.greens && colony.greens.length > 0) return colony.greens;
    return [];
  }, [colony.greens]);

  // Declutter greenery labels: only label major garden areas, clean up fragmented OCR text
  const greenLabels = useMemo(() => {
    if (!effectiveGreens.length) return {};
    const labels = {};
    const centers = [];
    effectiveGreens.forEach((g, i) => {
      const pts = toLeaflet(g.geometry);
      const m = polyMetrics(pts);
      if (!m || m.area < 60) return;
      let name = (g.name || "").toUpperCase().trim();
      if (name.includes("GARDEN") || name.includes("PARK")) name = "CENTRAL PARK";
      else if (name.includes("FUTURE")) name = "FUTURE EXPANSION";
      else if (name.length < 3) name = "AMENITY PARK";
      labels[i] = { pts, m, text: name };
      centers.push(m.center);
    });
    return labels;
  }, [effectiveGreens]);

  // Calculate road centerlines
  const roadCenterlines = useMemo(() => {
    const centerlines = {};
    if (!colony.roads?.length) return centerlines;

    colony.roads.forEach((r, i) => {
      const pts = toLeaflet(r.geometry);
      const m = polyMetrics(pts);
      if (!m || m.longest < 16) return;
      if (colony.boundary && !geoJSONContainsPoint(colony.boundary, [m.center[1], m.center[0]])) return;

      const kx = 111320 * Math.cos((m.center[0] * Math.PI) / 180);
      const rad = (-m.angle * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);

      // Clean Centerline down the road corridor
      const halfLen = m.longest * 0.44;
      const p1 = [m.center[0] - (sin * halfLen) / 110574, m.center[1] - (cos * halfLen) / kx];
      const p2 = [m.center[0] + (sin * halfLen) / 110574, m.center[1] + (cos * halfLen) / kx];
      if (colony.boundary && (!geoJSONContainsPoint(colony.boundary, [p1[1], p1[0]]) || !geoJSONContainsPoint(colony.boundary, [p2[1], p2[0]]))) {
        return;
      }
      centerlines[i] = [p1, p2];
    });
    return centerlines;
  }, [colony.roads, colony.boundary]);



  // Entrance placed right at the mouth of the primary road entrance
  const entrancePosition = useMemo(() => {
    if (colony.roads?.length) {
      let lowestLat = Infinity;
      let lowestLng = null;
      colony.roads.forEach((r) => {
        const pts = toLeaflet(r.geometry);
        pts.forEach((pt) => {
          if (pt[0] < lowestLat) {
            lowestLat = pt[0];
            lowestLng = pt[1];
          }
        });
      });
      if (lowestLng !== null && Number.isFinite(lowestLat)) {
        return [lowestLat - 0.000032, lowestLng];
      }
    }
    if (colony.entrance?.coordinates) {
      return [colony.entrance.coordinates[1], colony.entrance.coordinates[0]];
    }
    return null;
  }, [colony.roads, colony.entrance]);

  // Masterplan Architectural Plot Palette matching Reference 1 (Plot 128) & Reference 2
  const getPlotColors = (plot, isSel, isHovered, status, zone) => {
    let fill = "#f6f3eb"; // Modern clean architectural limestone/sand
    let stroke = isSel ? "#059669" : isHovered ? "#10b981" : "#544c3e";
    let strokeWidth = isSel ? 2.6 : isHovered ? 2.2 : 1.1;

    if (isSel) {
      fill = "#4eb995"; // Luminous mint emerald from Reference 1 (Plot 128)
    } else if (isHovered) {
      fill = "#ffffff";
    } else if (showStatus && status) {
      const sid = String(status.id || status.code || "").toLowerCase();
      if (sid.includes("sold")) {
        fill = "#ffe4e6";
        stroke = "#e11d48";
        strokeWidth = 1.3;
      } else if (sid.includes("hold")) {
        fill = "#fef3c7";
        stroke = "#d97706";
        strokeWidth = 1.3;
      } else if (sid.includes("reserve")) {
        fill = "#e0f2fe";
        stroke = "#0284c7";
        strokeWidth = 1.3;
      } else if (sid.includes("block")) {
        fill = "#e2e8f0";
        stroke = "#64748b";
        strokeWidth = 1.3;
      } else {
        fill = "#f6f3eb";
        stroke = "#544c3e";
      }
    } else if (showZones && zone) {
      fill = zone.color ? `${zone.color}25` : "#f6f3eb";
      stroke = zone.color || "#544c3e";
    }
    return { fill, stroke, strokeWidth };
  };

  // Card details for selected plot matching Reference 1 (Plot 128 Card)
  const plotCardDetails = useMemo(() => {
    if (!selectedPlot) return null;
    const a = areaConversions(selectedPlot.area_sqm || 0);
    const sqft = Math.round((selectedPlot.area_sqm || 0) * 10.7639) || Math.round(a.sqyd * 9) || 1200;

    let dimStr = selectedPlot.dimensions || "";
    if (!dimStr && selectedPlot.geometry) {
      const d = edgeDims(toLeaflet(selectedPlot.geometry));
      if (d && d.length >= 2) {
        const wM = Math.round(d[0].len);
        const lM = Math.round(d[1].len);
        dimStr = `${wM}M × ${lM}M`;
      }
    }
    if (!dimStr) dimStr = "30' × 40'";

    const facing = selectedPlot.facing || zones[selectedPlot.zone_id]?.name || "East";
    const statusObj = statuses[selectedPlot.status_id] || { name: "Available", id: "available" };
    const sid = String(statusObj.id || statusObj.code || "").toLowerCase();
    const statusKey = sid.includes("sold") ? "sold" : sid.includes("hold") ? "hold" : sid.includes("reserve") ? "reserved" : "available";

    return {
      number: selectedPlot.number,
      areaSqft: sqft,
      dimensions: dimStr,
      facing,
      statusName: statusObj.name || "Available",
      statusKey,
    };
  }, [selectedPlot, statuses, zones]);

  const handleChat = (plot) => {
    if (onWhatsApp) {
      onWhatsApp(plot);
      return;
    }
    const phone = colony.whatsapp ? String(colony.whatsapp).replace(/\D/g, "") : "919000000000";
    const text = encodeURIComponent(`Hi, I am interested in Plot ${plot.number} at ${colony.name || "LiveMap"}.`);
    window.open(`https://wa.me/${phone}?text=${text}`, "_blank", "noopener,noreferrer");
  };

  const handleEnquire = (plot) => {
    if (onEnquire) {
      onEnquire(plot);
      return;
    }
    handleChat(plot);
  };

  const handleShare = (plot) => {
    if (onShare) {
      onShare(plot);
      return;
    }
    if (navigator.share) {
      navigator.share({
        title: `Plot ${plot.number} · ${colony.name}`,
        url: window.location.href,
      }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(window.location.href);
    }
  };

  const sortedPlots = useMemo(() => {
    return (data.plots || [])
      .slice()
      .filter((p) => (p.area_sqm || 0) < 2000)
      .sort((a, b) => (b.area_sqm || 0) - (a.area_sqm || 0));
  }, [data.plots]);

  return (
    <div className="lm-map-wrap" data-testid="interactive-map">
    <MapContainer center={center} zoom={18} scrollWheelZoom className={`lm-map lm-map-${mapStyle}`} zoomControl={false} maxZoom={22} zoomSnap={0} zoomDelta={0.25}>
      {mapStyle !== "plan" && (
        <TileLayer url={ESRI} attribution="Imagery &copy; Esri, Maxar, Earthstar Geographics" maxZoom={22} maxNativeZoom={19} />
      )}
      <FitBounds data={data} resetKey={resetKey} entrancePosition={entrancePosition} />
      <MapResizeObserver />
      <FocusPlot selected={selectedPlot} geometry={selectedGeometry} />
      <PlotSelectionManager
        selectedPlot={selectedPlot}
        setSelectedPlot={setSelectedPlot}
        colonyBoundary={colony.boundary}
        entrancePosition={entrancePosition}
        clearSelectionRef={clearSelectionRef}
      />
      <FlyTo target={flyTarget} />
      <MapWatcher onMapClick={selectPlotAtPoint} onZoom={setZoom} />

      {/* 0. BASE LAYER: Masterplan Landscaped Ground & Perimeter Wall */}
      {boundary.length > 0 && (
        <Polygon
          positions={boundary}
          interactive={false}
          pathOptions={{
            color: "#ffffff",
            weight: 3.2,
            opacity: 0.98,
            fillColor: mapStyle === "plan" ? "#f1f5f9" : "#1e4418",
            fillOpacity: mapStyle === "plan" ? 0.95 : (pdfArtworkVisible ? 0.0 : (existingSelectablePlots.length > 0 ? 0.35 : 0.0)),
            lineJoin: "round",
          }}
        />
      )}

      {/* 1. LAYER: Walkway Curbs & Asphalt Roads */}
      {(colony.roads || []).map((r, i) => {
        const pts = toLeaflet(r.geometry);
        if (colony.boundary && pts.length > 0) {
          const c = centroid(pts);
          if (c && !geoJSONContainsPoint(colony.boundary, [c[1], c[0]])) return null;
        }
        const lbl = roadLabels[i];
        return (
          <Fragment key={`road-group-${i}`}>
            {/* Concrete Walkway Curb Underlay (Clean Curb Margin) */}
            <Polygon
              positions={pts}
              interactive={false}
              pathOptions={{
                color: "#7d8795",
                opacity: 0.95,
                weight: 5,
                lineJoin: "round",
                lineCap: "round",
                fill: false,
              }}
            />
            {/* Smooth Asphalt Road Body */}
            <Polygon
              positions={pts}
              interactive={false}
              pathOptions={{
                color: "#181a1f",
                opacity: 1,
                weight: 1.2,
                lineJoin: "round",
                lineCap: "round",
                fillColor: "#22262e",
                fillOpacity: 0.98,
              }}
            >
              {lbl && (
                <FitLabel positions={pts} metrics={lbl.m} lines={[lbl.text]} ppm={ppm} className="lm-fit-road" max={18} />
              )}
            </Polygon>
          </Fragment>
        );
      })}

      {/* 2. LAYER: White Dashed Centerlines on Roads */}
      {Object.entries(roadCenterlines).map(([idx, pts]) => (
        <Polyline
          key={`r-centerline-${idx}`}
          positions={pts}
          interactive={false}
          pathOptions={{ color: "#ffffff", weight: 2, dashArray: "7 9", opacity: 0.88 }}
        />
      ))}

      {/* Entry road (if defined) */}
      {entryRoad.length > 0 && (
        <>
          <Polygon positions={entryRoad} interactive={false} pathOptions={{
            color: "#181a1e",
            weight: 1.5,
            fillColor: "#2d3139",
            fillOpacity: 1,
          }}>
            <FitLabel positions={entryRoad} lines={[`ENTRY GATE · ${colony.entry_width_m || 12} M / ${mToFt(colony.entry_width_m || 12).toFixed(0)} FT`]} ppm={ppm} className="lm-fit-gate" max={18} />
          </Polygon>
          {colony.entry_centerline && (
            <Polyline positions={colony.entry_centerline.coordinates.map(([lng, lat]) => [lat, lng])} interactive={false}
              pathOptions={{ color: "#ffffff", weight: 2, dashArray: "10 8", opacity: 0.9 }} />
          )}
        </>
      )}

      {/* 4. LAYER: Greenery / Landscaping / Jogging Track */}
      {effectiveGreens.map((g, i) => {
        const pts = toLeaflet(g.geometry);
        const lbl = greenLabels[i];
        const m = polyMetrics(pts);
        const perimeterTrees = getPolygonPerimeterPoints(pts, 8);
        return (
          <Fragment key={`green-group-${i}`}>
            {/* Terracotta Jogging Track Outer Border */}
            <Polygon
              positions={pts}
              interactive={false}
              pathOptions={{
                color: "#c2410c",
                weight: 5,
                opacity: 0.95,
                fill: false,
                lineJoin: "round",
              }}
            />
            {/* Jogging Track Center Walking Guideline */}
            <Polygon
              positions={pts}
              interactive={false}
              pathOptions={{
                color: "#fef08a",
                weight: 1.2,
                dashArray: "4 4",
                opacity: 0.85,
                fill: false,
              }}
            />
            {/* Rich Manicured Park Lawn Body */}
            <Polygon
              positions={pts}
              interactive={false}
              pathOptions={{
                color: "#183b12",
                opacity: 1,
                weight: 1.6,
                lineJoin: "round",
                fillColor: "#265b1d",
                fillOpacity: 0.98,
              }}
            >
              {lbl && (
                <FitLabel positions={pts} metrics={lbl.m} lines={[lbl.text, "JOGGING TRACK · AMENITY GARDEN"]} ppm={ppm} className="lm-fit-green" rotate={false} max={22} fill={0.45} />
              )}
            </Polygon>

            {/* Central Architectural Reflecting Water Pool */}
            {m?.center && (
              <Marker
                position={m.center}
                icon={createAerialWaterPoolIcon(44, 28)}
                interactive={false}
                keyboard={false}
              />
            )}

            {/* Photorealistic Aerial Drone Trees along Park Jogging Track */}
            {perimeterTrees.map((pos, treeIdx) => (
              <Marker
                key={`green-tree-${i}-${treeIdx}`}
                position={pos}
                icon={createAerialTreeIcon(28, `${i}-${treeIdx}`)}
                interactive={false}
                keyboard={false}
              />
            ))}
          </Fragment>
        );
      })}

      {showZones && (data.zones || []).map((zone) => (
        <Polygon key={`z-${zone.id}`} positions={toLeaflet(zone.geometry)} interactive={false} pathOptions={{ stroke: false, fill: true, fillOpacity: 0 }}>
          <Tooltip permanent direction="center" className={`lm-tip-zone ${selectedZone === zone.id ? "sel" : ""}`} interactive={false}>
            <span style={{ background: zone.color }}>{zone.name}</span>
          </Tooltip>
        </Polygon>
      ))}

      {/* 5. LAYER: Plots (Crisp Modern Architectural Masterplan Parcels) */}
      {sortedPlots.map((plot) => {
        const status = statuses[plot.status_id];
        const zone = zones[plot.zone_id];
        const inFilter = !filteredPlotIds || filteredPlotIds.has(plot.id);
        const isSel = selectedPlot?.id === plot.id;
        const plotGeometry = plotGeo[plot.id];
        const positions = plotGeometry?.pos || toLeaflet(plot.geometry);
        const isHovered = hoveredPlotId === plot.id;
        const { fill, stroke, strokeWidth } = getPlotColors(plot, isSel, isHovered, status, zone);

        const a = areaConversions(plot.area_sqm || 0);
        const lines = isSel
          ? [plot.number, `${fmt(a.sqyd)} yd²`, `${fmt(a.sqm)} m²`]
          : [plot.number];

        return (
          <Polygon
            key={`plot-poly-${plot.id}`}
            positions={positions}
            interactive={Boolean(plotGeometry?.selectable)}
            pathOptions={{
              color: stroke,
              opacity: 1,
              weight: strokeWidth,
              fillColor: fill,
              fillOpacity: isSel ? 0.98 : inFilter ? (isHovered ? 1 : 0.96) : 0.25,
              lineJoin: "round",
            }}
            eventHandlers={{
              mouseover: (event) => {
                event.target.getElement()?.style.setProperty("cursor", "pointer");
                setHoveredPlotId(plot.id);
              },
              mouseout: () => setHoveredPlotId(null),
              click: () => setSelectedPlot(plot),
            }}
          >
            <FitLabel
              positions={positions}
              metrics={plotGeo[plot.id]?.m}
              lines={lines}
              ppm={ppm}
              rotate={false}
              max={64}
              minFont={7}
              fill={0.6}
              scale={isSel ? SELECTED_SCALE : 1}
              fontCap={isSel ? undefined : uniformFont}
              className={`lm-fit-plot ${isSel ? "selected" : ""} ${inFilter ? "" : "dim"}`}
              chars={3}
              testId={`plot-label-${plot.number}`}
            />
          </Polygon>
        );
      })}

      {/* 5b. LAYER: Virtual / Detected Plots */}
      {existingSelectablePlots.length === 0 && virtualPlots.map((plot) => {
        const isSelected = selectedPlot?.id === plot.id;
        const isHovered = hoveredPlotId === plot.id;
        const status = statuses[plot.status_id];
        const inFilter = !filteredPlotIds || filteredPlotIds.has(plot.id);
        const positions = virtualPlotGeo[plot.id].pos;
        const { fill, stroke, strokeWidth } = getPlotColors(plot, isSelected, isHovered, status, null);
        const a = areaConversions(plot.area_sqm || 0);
        const lines = isSelected
          ? [plot.number, `${fmt(a.sqyd)} yd²`, `${fmt(a.sqm)} m²`]
          : [plot.number];

        return (
          <Polygon
            key={`v-poly-${plot.id}`}
            positions={positions}
            pathOptions={{
              color: stroke,
              opacity: 1,
              weight: strokeWidth,
              fillColor: fill,
              fillOpacity: isSelected ? 0.98 : inFilter ? 0.96 : 0.2,
              lineJoin: "round",
            }}
            eventHandlers={{
              click: () => setSelectedPlot(plot),
              mouseover: (event) => {
                event.target.getElement()?.style.setProperty("cursor", "pointer");
                setHoveredPlotId(plot.id);
              },
              mouseout: () => setHoveredPlotId(null),
            }}
          >
            <FitLabel
              positions={positions}
              metrics={polyMetrics(positions[0] || [])}
              lines={lines}
              ppm={ppm}
              rotate={false}
              max={48}
              minFont={7}
              fill={0.6}
              scale={isSelected ? SELECTED_SCALE : 1}
              className={`lm-fit-plot ${isSelected ? "selected" : ""}`}
              chars={3}
              testId={`candidate-label-${plot.number}`}
            />
          </Polygon>
        );
      })}



      <Pane name="pdfArtworkPane" style={{ zIndex: 350 }} />
      {pdfArtworkVisible && colony.pdf_overlay?.url && colony.pdf_overlay?.bounds && (
        <ImageOverlay
          url={`${BACKEND}${colony.pdf_overlay.url}`}
          bounds={colony.pdf_overlay.bounds}
          opacity={0.96}
          interactive={false}
          pane="pdfArtworkPane"
          zIndex={350}
        />
      )}

      {/* Colony Boundary outline: distinct architectural perimeter enclosing the land boundary */}
      {boundary.length > 0 && (
        <Polygon positions={boundary} pane="markerPane" interactive={false} pathOptions={{
          color: "#ffffff",
          weight: 2.8,
          opacity: 0.95,
          fillColor: "#0f1115",
          fillOpacity: 0.03,
        }} />
      )}

      {!selectedPlot?.is_pdf_detected && dims.map((d) => {
        const edgePx = d.len * ppm;
        if (edgePx < 50) return null;
        const font = Math.max(9, Math.min(14, edgePx * 0.07));
        return (
          <Marker key={`d-${selectedPlot.id}-${d.key}`} position={d.mid} interactive={false}
            icon={L.divIcon({ className: "lm-dim-marker", html: `<span style="font-size:${font}px;transform:translate(-50%,-50%) rotate(${d.angle}deg)">-- ${d.label} --</span>`, iconSize: [0, 0] })} />
        );
      })}

      {userPos && (
        <CircleMarker center={userPos} radius={8} pathOptions={{ color: "#fff", weight: 3, fillColor: "#258cfb", fillOpacity: 1 }}>
          <Tooltip permanent direction="top" offset={[0, -8]} className="lm-tip-user">You are here</Tooltip>
        </CircleMarker>
      )}
    </MapContainer>

    {/* Floating Selected Plot Card matching Reference 1 (Plot 128 Card) */}
    {selectedPlot && plotCardDetails && (
      <div className="lm-floating-plot-card" data-testid="floating-plot-card">
        <div className="lm-fpc-head">
          <div className="lm-fpc-title">Plot {plotCardDetails.number}</div>
          <div className="lm-fpc-actions">
            {onManageMedia && (
              <button
                type="button"
                className="lm-fpc-icon-btn"
                title="Plot Photos & Media"
                onClick={() => onManageMedia(selectedPlot)}
                data-testid="fpc-manage-media"
              >
                <ImageIcon size={15} />
              </button>
            )}
            <button
              type="button"
              className="lm-fpc-icon-btn"
              title="Share Plot"
              onClick={() => handleShare(selectedPlot)}
              data-testid="fpc-share-plot"
            >
              <Share2 size={15} />
            </button>
            <button
              type="button"
              className="lm-fpc-icon-btn lm-fpc-close"
              title="Close Plot Card"
              onClick={() => setSelectedPlot(null)}
              data-testid="fpc-close-card"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div className={`lm-fpc-badge lm-fpc-badge-${plotCardDetails.statusKey}`}>
          <span className="lm-fpc-dot" /> {plotCardDetails.statusName.toUpperCase()}
        </div>

        <div className="lm-fpc-specs">
          <div className="lm-fpc-spec">
            <span className="lm-fpc-spec-val">{plotCardDetails.areaSqft} sqft</span>
          </div>
          <div className="lm-fpc-spec">
            <span className="lm-fpc-spec-val">{plotCardDetails.dimensions}</span>
          </div>
          <div className="lm-fpc-spec">
            <span className="lm-fpc-spec-val">{plotCardDetails.facing}</span>
          </div>
        </div>

        <div className="lm-fpc-buttons">
          <button
            type="button"
            className="lm-fpc-btn-chat"
            onClick={() => handleChat(selectedPlot)}
            data-testid="fpc-chat-btn"
          >
            <MessageSquare size={14} /> Chat now
          </button>
          <button
            type="button"
            className="lm-fpc-btn-enquire"
            onClick={() => handleEnquire(selectedPlot)}
            data-testid="fpc-enquire-btn"
          >
            Enquire now
          </button>
        </div>
      </div>
    )}

    {/* Floating compass rose */}
    <div className="lm-compass-rose" title="North orientation">
      <div className="lm-compass-inner">
        <span className="lm-compass-n">N</span>
        <span className="lm-compass-s">S</span>
        <span className="lm-compass-w">W</span>
        <span className="lm-compass-e">E</span>
        <div className="lm-compass-needle" />
      </div>
    </div>

    {selectedPlot && (
      <button
        type="button"
        className="lm-plot-reset"
        onClick={() => clearSelectionRef.current?.()}
        data-testid="reset-plot-selection"
        title="Clear selected plot and return to the colony boundary"
      >
        <LocateFixed size={15} /> Colony view
      </button>
    )}
    </div>
  );
}

export const plotCenter = (plot) => centroid(toLeaflet(plot.geometry));
