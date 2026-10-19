import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  X,
  RotateCcw,
  Move,
  RotateCw,
  CheckCircle,
  Eye,
  EyeOff,
  Sliders,
  Maximize2,
  Lock,
  Unlock,
  Check,
  AlertTriangle,
  Layers,
  MapPin,
  PencilRuler,
  Compass,
  TreePine,
  Milestone,
  Square,
  Trash2,
  Save,
  ShieldCheck,
  Info,
  Plus,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { MapContainer, TileLayer, Polygon, Polyline, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";
import { api, errMsg } from "@/lib/api";
import CanvasImageOverlay from "@/components/CanvasImageOverlay";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

function toLeafletCoords(geo) {
  if (!geo || !geo.coordinates) return [];
  const coords = geo.type === "Polygon" ? geo.coordinates[0] : geo.coordinates[0] ? geo.coordinates[0][0] : [];
  if (!Array.isArray(coords)) return [];
  return coords.map(([lng, lat]) => [lat, lng]);
}

function latLngsToGeoJSON(latlngs) {
  const flat = Array.isArray(latlngs[0]) && Array.isArray(latlngs[0][0]) ? latlngs[0] : latlngs;
  const coords = flat.map((ll) => {
    const lat = typeof ll?.lat === "number" ? ll.lat : Array.isArray(ll) ? ll[0] : 0;
    const lng = typeof ll?.lng === "number" ? ll.lng : Array.isArray(ll) ? ll[1] : 0;
    return [Number(lng.toFixed(7)), Number(lat.toFixed(7))];
  });
  if (coords.length > 0) {
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      coords.push([first[0], first[1]]);
    }
  }
  return {
    type: "Polygon",
    coordinates: [coords],
  };
}

function computePolygonAreaSqyd(latlngs) {
  if (!latlngs || latlngs.length < 3) return 0;
  const flat = Array.isArray(latlngs[0]) && Array.isArray(latlngs[0][0]) ? latlngs[0] : latlngs;
  let area = 0;
  if (flat.length > 2) {
    for (let i = 0; i < flat.length; i++) {
      const p1 = flat[i];
      const p2 = flat[(i + 1) % flat.length];
      const lat1 = Number(p1.lat ?? p1[0]);
      const lng1 = Number(p1.lng ?? p1[1]);
      const lat2 = Number(p2.lat ?? p2[0]);
      const lng2 = Number(p2.lng ?? p2[1]);
      if (Number.isFinite(lat1) && Number.isFinite(lng1) && Number.isFinite(lat2) && Number.isFinite(lng2)) {
        area += ((lng2 - lng1) * (Math.PI / 180)) * (2 + Math.sin((lat1 * Math.PI) / 180) + Math.sin((lat2 * Math.PI) / 180));
      }
    }
    area = Math.abs((area * 6378137.0 * 6378137.0) / 4.0);
  }
  const result = Math.round(area * 1.19599 * 10) / 10;
  return Number.isFinite(result) ? result : 0;
}

function MapFit({ boundary }) {
  const map = useMap();
  useEffect(() => {
    const pts = toLeafletCoords(boundary);
    if (pts.length) {
      map.fitBounds(pts, { padding: [35, 35] });
    }
  }, [boundary, map]);
  return null;
}

function isPointInPolygon(point, polygon) {
  const [y, x] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// =========================================================================
// GEOMAN CONTROLLER COMPONENT (Inside MapContainer)
// =========================================================================
function StudioGeomanController({
  studioTab,
  geoTool,
  boundaryGeo,
  onBoundaryChange,
  plots,
  roads,
  greens,
  onPlotDrawn,
  onRoadDrawn,
  onGreenDrawn,
  selectedFeature,
  setSelectedFeature,
  reshapingFeature,
  setReshapingFeature,
  setDeleteConfirmModal,
}) {
  const map = useMap();
  const boundaryLayerRef = useRef(null);
  const plotsGroupRef = useRef(null);
  const roadsGroupRef = useRef(null);
  const greensGroupRef = useRef(null);

  const activeReshapeLayerRef = useRef(null);

  // Safe helpers to ensure LayerGroups are attached to the map
  const getPlotsGroup = useCallback(() => {
    if (!plotsGroupRef.current || !map.hasLayer(plotsGroupRef.current)) {
      plotsGroupRef.current = L.layerGroup().addTo(map);
    }
    return plotsGroupRef.current;
  }, [map]);

  const getRoadsGroup = useCallback(() => {
    if (!roadsGroupRef.current || !map.hasLayer(roadsGroupRef.current)) {
      roadsGroupRef.current = L.layerGroup().addTo(map);
    }
    return roadsGroupRef.current;
  }, [map]);

  const getGreensGroup = useCallback(() => {
    if (!greensGroupRef.current || !map.hasLayer(greensGroupRef.current)) {
      greensGroupRef.current = L.layerGroup().addTo(map);
    }
    return greensGroupRef.current;
  }, [map]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (plotsGroupRef.current) {
        try { map.removeLayer(plotsGroupRef.current); } catch (_) {}
        plotsGroupRef.current = null;
      }
      if (roadsGroupRef.current) {
        try { map.removeLayer(roadsGroupRef.current); } catch (_) {}
        roadsGroupRef.current = null;
      }
      if (greensGroupRef.current) {
        try { map.removeLayer(greensGroupRef.current); } catch (_) {}
        greensGroupRef.current = null;
      }
      if (boundaryLayerRef.current) {
        try { map.removeLayer(boundaryLayerRef.current); } catch (_) {}
        boundaryLayerRef.current = null;
      }
      if (activeReshapeLayerRef.current) {
        try { activeReshapeLayerRef.current.pm.disable(); } catch (_) {}
        activeReshapeLayerRef.current = null;
      }
    };
  }, [map]);

  // When switching away from geometry tab
  useEffect(() => {
    if (!map.pm) return;

    if (studioTab !== "geometry") {
      // Disable drawing & editing safely
      try {
        if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) {
          map.pm.disableDraw();
        }
        map.doubleClickZoom.enable();
      } catch (_) {}

      if (boundaryLayerRef.current && boundaryLayerRef.current.pm?.enabled?.()) {
        try { boundaryLayerRef.current.pm.disable(); } catch (_) {}
      }
      if (activeReshapeLayerRef.current?.pm?.enabled?.()) {
        try { activeReshapeLayerRef.current.pm.disable(); } catch (_) {}
        activeReshapeLayerRef.current = null;
      }
      plotsGroupRef.current?.clearLayers();
      roadsGroupRef.current?.clearLayers();
      greensGroupRef.current?.clearLayers();
      if (boundaryLayerRef.current) {
        try { map.removeLayer(boundaryLayerRef.current); } catch (_) {}
        boundaryLayerRef.current = null;
      }
      return;
    }

    // Configure Geoman global options
    try {
      map.pm.setLang("en");
      map.pm.setGlobalOptions({
        snappable: true,
        snapDistance: 15,
        allowSelfIntersection: false,
        templineStyle: { color: "#38bdf8", weight: 2.5, dashArray: "4, 6" },
        hintlineStyle: { color: "#38bdf8", weight: 1.5, dashArray: "3, 5" },
        pathOptions: { color: "#38bdf8", fillColor: "#38bdf8", fillOpacity: 0.25 },
      });
    } catch (_) {}

    const handleCreated = (e) => {
      const { layer, shape } = e;
      const geo = layer.toGeoJSON();

      // Disable draw mode right after creation so user can inspect or complete draft
      try {
        map.pm.disableDraw();
        map.doubleClickZoom.enable();
      } catch (_) {}

      if (shape === "Polygon" || geo?.geometry?.type === "Polygon") {
        if (geoTool === "draw_plot") {
          const raw = layer.getLatLngs();
          const latlngs = Array.isArray(raw[0]) ? raw[0] : raw;
          onPlotDrawn({
            latlngs,
            geojson: geo.geometry,
            area_sqyd: computePolygonAreaSqyd(latlngs),
            tempLayer: layer,
          });
        } else if (geoTool === "draw_green") {
          const raw = layer.getLatLngs();
          const latlngs = Array.isArray(raw[0]) ? raw[0] : raw;
          onGreenDrawn({
            latlngs,
            geojson: geo.geometry,
            tempLayer: layer,
          });
        }
      } else if (shape === "Line" || geo?.geometry?.type === "LineString") {
        if (geoTool === "draw_road") {
          onRoadDrawn({
            latlngs: layer.getLatLngs(),
            geojson: geo.geometry,
            tempLayer: layer,
          });
        }
      }
    };

    map.on("pm:create", handleCreated);
    return () => {
      map.off("pm:create", handleCreated);
    };
  }, [studioTab, geoTool, map, onPlotDrawn, onRoadDrawn, onGreenDrawn]);

  // Handle active tool changes (Draw modes & Reshape cleanups)
  useEffect(() => {
    if (studioTab !== "geometry" || !map.pm) return;

    // Reset previous reshape if tool changed
    if (geoTool !== "reshape" && activeReshapeLayerRef.current) {
      try {
        activeReshapeLayerRef.current.pm.disable();
      } catch (_) {}
      activeReshapeLayerRef.current = null;
      setReshapingFeature(null);
    }

    try {
      if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) {
        map.pm.disableDraw();
      }
    } catch (_) {}

    const isDrawing = geoTool === "draw_plot" || geoTool === "draw_green" || geoTool === "draw_road";
    if (isDrawing) {
      try { map.doubleClickZoom.disable(); } catch (_) {}
    } else {
      try { map.doubleClickZoom.enable(); } catch (_) {}
    }

    if (geoTool === "draw_plot" || geoTool === "draw_green") {
      try {
        map.pm.enableDraw("Polygon", {
          snappable: true,
          snapDistance: 20,
          allowSelfIntersection: false,
          finishOn: "dblclick",
        });
      } catch (_) {}
    } else if (geoTool === "draw_road") {
      try {
        map.pm.enableDraw("Line", {
          snappable: true,
          snapDistance: 20,
          finishOn: "dblclick",
        });
      } catch (_) {}
    }
  }, [studioTab, geoTool, map, setReshapingFeature]);

  // Render Boundary Layer in Geometry mode
  useEffect(() => {
    if (studioTab !== "geometry") return;

    if (boundaryLayerRef.current) {
      try { map.removeLayer(boundaryLayerRef.current); } catch (_) {}
      boundaryLayerRef.current = null;
    }

    if (!boundaryGeo) return;
    const pts = toLeafletCoords(boundaryGeo);
    if (!pts.length) return;

    const isEditingBoundary = geoTool === "boundary";

    const layer = L.polygon(pts, {
      color: isEditingBoundary ? "#38bdf8" : "#10b981",
      weight: isEditingBoundary ? 3.5 : 2.5,
      dashArray: isEditingBoundary ? null : "6, 6",
      fillColor: isEditingBoundary ? "#0284c7" : "#10b981",
      fillOpacity: isEditingBoundary ? 0.22 : 0.05,
      interactive: true,
    }).addTo(map);

    boundaryLayerRef.current = layer;

    if (isEditingBoundary) {
      try {
        layer.pm.enable({
          allowSelfIntersection: false,
          preventMarkerRemoval: false,
        });

        const onEdit = () => {
          const updatedLatLngs = layer.getLatLngs()[0];
          const newGeo = latLngsToGeoJSON(updatedLatLngs);
          onBoundaryChange(newGeo, computePolygonAreaSqyd(updatedLatLngs));
        };

        layer.on("pm:edit", onEdit);
        layer.on("pm:vertexadded", onEdit);
        layer.on("pm:vertexremoved", onEdit);
        layer.on("pm:markerdragend", onEdit);
      } catch (_) {}
    } else {
      try {
        if (layer.pm?.enabled?.()) layer.pm.disable();
      } catch (_) {}
      layer.on("click", (e) => {
        if (geoTool && geoTool.startsWith("draw_")) {
          // Allow clicks to pass straight to Leaflet map for Geoman point placement
          return;
        }
        L.DomEvent.stopPropagation(e);
        if (geoTool === "inspect") {
          setSelectedFeature({
            type: "boundary",
            data: { vertices: pts.length },
            layer,
          });
        }
      });
    }
  }, [studioTab, geoTool, boundaryGeo, map, onBoundaryChange, setSelectedFeature]);

  // Render Interactive Plots in Geometry mode
  useEffect(() => {
    if (studioTab !== "geometry") return;
    const group = getPlotsGroup();
    group.clearLayers();

    if (!plots || plots.length === 0) return;

    plots.forEach((p) => {
      const geo = p.geometry || p.original_geometry;
      if (!geo) return;
      const pts = toLeafletCoords(geo);
      if (!pts.length) return;

      const isSold = p.status_id === "sold";
      const isBooked = p.status_id === "booked";
      const color = isSold ? "#ef4444" : isBooked ? "#f59e0b" : "#10b981";

      const poly = L.polygon(pts, {
        color: color,
        weight: 1.8,
        fillColor: color,
        fillOpacity: isSold ? 0.45 : isBooked ? 0.35 : 0.25,
        interactive: true,
      });

      const plotNum = p.number ? String(p.number) : "Plot";
      poly.bindTooltip(
        `<div style="font-weight:700;font-size:11px;padding:2px 5px;color:#fff;background:rgba(15,23,42,0.92);border-radius:4px;border:1px solid #475569;box-shadow:0 2px 6px rgba(0,0,0,0.4);pointer-events:none;">${plotNum}</div>`,
        { permanent: true, direction: "center", className: "!bg-transparent !border-0 !p-0 !shadow-none pointer-events-none" }
      );

      poly.on("click", (e) => {
        if (geoTool && geoTool.startsWith("draw_")) {
          // Allow clicks to pass through to map so Geoman can place points/snap!
          return;
        }
        L.DomEvent.stopPropagation(e);
        if (geoTool === "inspect") {
          setSelectedFeature({ type: "plot", data: p, layer: poly });
        } else if (geoTool === "reshape") {
          try {
            if (activeReshapeLayerRef.current && activeReshapeLayerRef.current !== poly) {
              try { activeReshapeLayerRef.current.pm.disable(); } catch (_) {}
            }
            poly.pm.enable({
              allowSelfIntersection: false,
              snappable: true,
              snapDistance: 15,
            });
            activeReshapeLayerRef.current = poly;
            setReshapingFeature({ layer: poly, data: p, type: "plot" });
            setSelectedFeature({ type: "plot", data: p, layer: poly });
          } catch (err) {
            console.error("Reshape plot error:", err);
          }
        } else if (geoTool === "delete") {
          setDeleteConfirmModal({ type: "plot", id: p.id || p._id, name: `Plot ${p.number || ""}` });
        }
      });

      group.addLayer(poly);
    });
  }, [studioTab, geoTool, plots, getPlotsGroup, setSelectedFeature, setReshapingFeature, setDeleteConfirmModal]);

  // Render Interactive Roads in Geometry mode
  useEffect(() => {
    if (studioTab !== "geometry") return;
    const group = getRoadsGroup();
    group.clearLayers();

    if (!roads || roads.length === 0) return;

    roads.forEach((r, idx) => {
      const geo = r.geometry || r.original_geometry;
      if (!geo) return;

      if (geo.type === "Polygon") {
        const pts = toLeafletCoords(geo);
        if (!pts.length) return;
        const poly = L.polygon(pts, {
          color: "#94a3b8",
          weight: 1.5,
          fillColor: "#334155",
          fillOpacity: 0.65,
          interactive: true,
        });

        poly.bindTooltip(r.name || `Road ${idx + 1}`, { permanent: false, direction: "center" });

        poly.on("click", (e) => {
          if (geoTool && geoTool.startsWith("draw_")) return;
          L.DomEvent.stopPropagation(e);
          if (geoTool === "inspect") {
            setSelectedFeature({ type: "road", data: r, layer: poly });
          } else if (geoTool === "reshape") {
            try {
              if (activeReshapeLayerRef.current && activeReshapeLayerRef.current !== poly) {
                try { activeReshapeLayerRef.current.pm.disable(); } catch (_) {}
              }
              poly.pm.enable({
                allowSelfIntersection: false,
                snappable: true,
                snapDistance: 15,
              });
              activeReshapeLayerRef.current = poly;
              setReshapingFeature({ layer: poly, data: r, type: "road" });
              setSelectedFeature({ type: "road", data: r, layer: poly });
            } catch (err) {
              console.error("Reshape road error:", err);
            }
          } else if (geoTool === "delete") {
            setDeleteConfirmModal({ type: "road", id: r.id || `road-${idx}`, name: r.name || `Road ${idx + 1}` });
          }
        });
        group.addLayer(poly);
      } else if (geo.type === "LineString") {
        const pts = geo.coordinates.map(([lng, lat]) => [lat, lng]);
        const line = L.polyline(pts, {
          color: "#cbd5e1",
          weight: 4,
          dashArray: "6, 6",
          interactive: true,
        });
        line.bindTooltip(r.name || `Road ${idx + 1}`, { permanent: false });
        line.on("click", (e) => {
          if (geoTool && geoTool.startsWith("draw_")) return;
          L.DomEvent.stopPropagation(e);
          if (geoTool === "inspect") {
            setSelectedFeature({ type: "road", data: r, layer: line });
          } else if (geoTool === "reshape") {
            try {
              if (activeReshapeLayerRef.current && activeReshapeLayerRef.current !== line) {
                try { activeReshapeLayerRef.current.pm.disable(); } catch (_) {}
              }
              line.pm.enable({
                allowSelfIntersection: false,
                snappable: true,
                snapDistance: 15,
              });
              activeReshapeLayerRef.current = line;
              setReshapingFeature({ layer: line, data: r, type: "road" });
              setSelectedFeature({ type: "road", data: r, layer: line });
            } catch (err) {
              console.error("Reshape road line error:", err);
            }
          } else if (geoTool === "delete") {
            setDeleteConfirmModal({ type: "road", id: r.id || `road-${idx}`, name: r.name || `Road ${idx + 1}` });
          }
        });
        group.addLayer(line);
      }
    });
  }, [studioTab, geoTool, roads, getRoadsGroup, setSelectedFeature, setReshapingFeature, setDeleteConfirmModal]);

  // Render Interactive Greens in Geometry mode
  useEffect(() => {
    if (studioTab !== "geometry") return;
    const group = getGreensGroup();
    group.clearLayers();

    if (!greens || greens.length === 0) return;

    greens.forEach((g, idx) => {
      const geo = g.geometry || g.original_geometry;
      if (!geo) return;
      const pts = toLeafletCoords(geo);
      if (!pts.length) return;

      const poly = L.polygon(pts, {
        color: "#22c55e",
        weight: 2,
        fillColor: "#15803d",
        fillOpacity: 0.5,
        interactive: true,
      });

      poly.bindTooltip(
        `<div style="display:flex;align-items:center;gap:4px;font-weight:700;font-size:11px;padding:2px 5px;color:#86efac;background:rgba(15,23,42,0.92);border-radius:4px;border:1px solid #166534;pointer-events:none;">🌿 ${g.name || "Park"}</div>`,
        { permanent: true, direction: "center", className: "!bg-transparent !border-0 !p-0 !shadow-none pointer-events-none" }
      );

      poly.on("click", (e) => {
        if (geoTool && geoTool.startsWith("draw_")) return;
        L.DomEvent.stopPropagation(e);
        if (geoTool === "inspect") {
          setSelectedFeature({ type: "green", data: g, layer: poly });
        } else if (geoTool === "reshape") {
          try {
            if (activeReshapeLayerRef.current && activeReshapeLayerRef.current !== poly) {
              try { activeReshapeLayerRef.current.pm.disable(); } catch (_) {}
            }
            poly.pm.enable({
              allowSelfIntersection: false,
              snappable: true,
              snapDistance: 15,
            });
            activeReshapeLayerRef.current = poly;
            setReshapingFeature({ layer: poly, data: g, type: "green" });
            setSelectedFeature({ type: "green", data: g, layer: poly });
          } catch (err) {
            console.error("Reshape green error:", err);
          }
        } else if (geoTool === "delete") {
          setDeleteConfirmModal({ type: "green", id: g.id || `green-${idx}`, name: g.name || `Park ${idx + 1}` });
        }
      });

      group.addLayer(poly);
    });
  }, [studioTab, geoTool, greens, getGreensGroup, setSelectedFeature, setReshapingFeature, setDeleteConfirmModal]);

  return null;
}

// =========================================================================
// MAIN MODAL COMPONENT
// =========================================================================
export default function PlacementCalibrationModal({
  colony,
  plots: initialPlots = [],
  roads: initialRoads = [],
  greens: initialGreens = [],
  onClose,
  onConfirmed,
}) {
  const colonyId = colony?.id || colony?._id;
  const pdfOverlay = colony?.pdf_overlay;
  const hasOverlayImage = Boolean(pdfOverlay?.base_url && pdfOverlay?.bounds);

  // STUDIO TABS: 'calibrate' (Transform/Alignment) | 'geometry' (Masterplan & Boundary Editor)
  const [studioTab, setStudioTab] = useState("calibrate");

  // GEOMETRY TOOLS: 'inspect' | 'boundary' | 'draw_plot' | 'draw_road' | 'draw_green' | 'reshape' | 'delete'
  const [geoTool, setGeoTool] = useState("inspect");

  // Calibration state
  const initialTransform = colony?.placement?.transform || pdfOverlay?.transform || {};
  const [rotation, setRotation] = useState(
    Number(initialTransform.rotation_deg ?? initialTransform.rotation ?? 0)
  );
  const [tx, setTx] = useState(
    Number(initialTransform.translation_x_m ?? initialTransform.translation_x ?? 0)
  );
  const [ty, setTy] = useState(
    Number(initialTransform.translation_y_m ?? initialTransform.translation_y ?? 0)
  );
  const [scaleX, setScaleX] = useState(Number(initialTransform.scale_x ?? 1));
  const [scaleY, setScaleY] = useState(Number(initialTransform.scale_y ?? 1));
  const [stepSize, setStepSize] = useState(2);
  const [showOverlay, setShowOverlay] = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(0.5);
  const [showPlots, setShowPlots] = useState(true);
  const [showPlotNumbers, setShowPlotNumbers] = useState(true);
  const [showRoads, setShowRoads] = useState(true);
  const [showMasterplanLawn, setShowMasterplanLawn] = useState(true);

  // Spatial data state
  const [plots, setPlots] = useState(initialPlots || []);
  const [roads, setRoads] = useState((initialRoads && initialRoads.length > 0) ? initialRoads : (colony?.roads || []));
  const [greens, setGreens] = useState((initialGreens && initialGreens.length > 0) ? initialGreens : (colony?.greens || []));
  const [boundaryGeo, setBoundaryGeo] = useState(colony?.boundary || null);
  const [boundaryAreaSqyd, setBoundaryAreaSqyd] = useState(0);
  const [boundaryChanged, setBoundaryChanged] = useState(false);

  // Sync state when props arrive or update
  useEffect(() => {
    if (initialPlots && initialPlots.length > 0) {
      setPlots(initialPlots);
    }
  }, [initialPlots]);

  useEffect(() => {
    const r = (initialRoads && initialRoads.length > 0) ? initialRoads : colony?.roads;
    if (r && r.length > 0) setRoads(r);
  }, [initialRoads, colony?.roads]);

  useEffect(() => {
    const g = (initialGreens && initialGreens.length > 0) ? initialGreens : colony?.greens;
    if (g && g.length > 0) setGreens(g);
  }, [initialGreens, colony?.greens]);

  useEffect(() => {
    if (colony?.boundary) {
      setBoundaryGeo(colony.boundary);
      try {
        const pts = toLeafletCoords(colony.boundary);
        if (pts.length > 2) {
          setBoundaryAreaSqyd(computePolygonAreaSqyd(pts));
        }
      } catch (_) {}
    }
  }, [colony?.boundary]);

  // Selection & Draft Modals
  const [selectedFeature, setSelectedFeature] = useState(null);
  const [reshapingFeature, setReshapingFeature] = useState(null);

  const [plotDraftModal, setPlotDraftModal] = useState(null);
  const [newPlotNumber, setNewPlotNumber] = useState("");
  const [newPlotType, setNewPlotType] = useState("residential");
  const [newPlotStatus, setNewPlotStatus] = useState("available");

  const [roadDraftModal, setRoadDraftModal] = useState(null);
  const [newRoadName, setNewRoadName] = useState("");
  const [newRoadWidthFt, setNewRoadWidthFt] = useState(30);

  const [greenDraftModal, setGreenDraftModal] = useState(null);
  const [newGreenName, setNewGreenName] = useState("");
  const [newGreenType, setNewGreenType] = useState("park");

  const [deleteConfirmModal, setDeleteConfirmModal] = useState(null);

  // Status & Messages
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  // Auto-dismiss success notification
  useEffect(() => {
    if (successMsg) {
      const timer = setTimeout(() => setSuccessMsg(""), 4500);
      return () => clearTimeout(timer);
    }
  }, [successMsg]);

  // Load existing colony spatial data
  useEffect(() => {
    if (colonyId) {
      api
        .get(`/admin/colonies/${colonyId}`)
        .then((res) => {
          if (res.data?.plots?.length) setPlots(res.data.plots);
          if (res.data?.colony?.boundary) {
            setBoundaryGeo(res.data.colony.boundary);
            setBoundaryAreaSqyd(computePolygonAreaSqyd(toLeafletCoords(res.data.colony.boundary)));
          }
          if (res.data?.colony?.roads) setRoads(res.data.colony.roads);
          if (res.data?.colony?.greens) setGreens(res.data.colony.greens);
        })
        .catch(() => {});
    }
  }, [colonyId]);

  // Auto-suggest next plot number when draft opens
  useEffect(() => {
    if (plotDraftModal) {
      const numbers = plots
        .map((p) => {
          const num = parseInt(String(p.number || "").replace(/\D/g, ""), 10);
          return isNaN(num) ? 0 : num;
        })
        .filter((n) => n > 0);
      const nextNum = numbers.length > 0 ? Math.max(...numbers) + 1 : plots.length + 1;
      setNewPlotNumber(`P-${nextNum}`);
    }
  }, [plotDraftModal, plots]);

  const boundaryPts = useMemo(() => toLeafletCoords(boundaryGeo || colony?.boundary), [boundaryGeo, colony?.boundary]);

  // Unified center
  const center = useMemo(() => {
    if (pdfOverlay?.bounds && Array.isArray(pdfOverlay.bounds) && pdfOverlay.bounds.length === 2) {
      const [[minLat, minLng], [maxLat, maxLng]] = pdfOverlay.bounds;
      return [(minLat + maxLat) / 2, (minLng + maxLng) / 2];
    }
    if (boundaryPts.length > 0) {
      let minLat = Infinity,
        maxLat = -Infinity,
        minLng = Infinity,
        maxLng = -Infinity;
      for (const [lat, lng] of boundaryPts) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
      return [(minLat + maxLat) / 2, (minLng + maxLng) / 2];
    }
    if (colony?.map_center?.lat && colony?.map_center?.lng) {
      return [colony.map_center.lat, colony.map_center.lng];
    }
    return [27.237, 78.244];
  }, [pdfOverlay?.bounds, boundaryPts, colony?.map_center]);

  // Transformed preview positions for Calibration tab
  const previewPlotPositions = useMemo(() => {
    if (!plots || plots.length === 0) return [];
    const rad = (rotation * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    const [cy, cx] = center;

    const latRad = (cy * Math.PI) / 180;
    const dxDeg = Math.abs(cy) <= 89 ? tx / (111320 * Math.cos(latRad)) : 0;
    const dyDeg = ty / 110574;

    return plots.map((plot) => {
      const origGeo = plot.original_geometry || plot.geometry;
      const rawCoords = toLeafletCoords(origGeo);
      let sumLat = 0;
      let sumLng = 0;

      const transformed = rawCoords.map(([lat, lng]) => {
        let dlng = (lng - cx) * scaleX;
        let dlat = (lat - cy) * scaleY;

        const rLng = dlng * cosA - dlat * sinA;
        const rLat = dlng * sinA + dlat * cosA;

        const pLat = cy + rLat + dyDeg;
        const pLng = cx + rLng + dxDeg;

        sumLat += pLat;
        sumLng += pLng;
        return [pLat, pLng];
      });

      const count = transformed.length || 1;
      const plotCenter = [sumLat / count, sumLng / count];
      const isInside = boundaryPts.length > 2 ? isPointInPolygon(plotCenter, boundaryPts) : true;

      return {
        ...plot,
        positions: transformed,
        isInside,
      };
    });
  }, [plots, rotation, tx, ty, scaleX, scaleY, center, boundaryPts]);

  // Transformed preview roads for Calibration tab
  const previewRoads = useMemo(() => {
    if (!roads || roads.length === 0) return [];
    const rad = (rotation * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    const [cy, cx] = center;

    const latRad = (cy * Math.PI) / 180;
    const dxDeg = Math.abs(cy) <= 89 ? tx / (111320 * Math.cos(latRad)) : 0;
    const dyDeg = ty / 110574;

    return roads.map((road) => {
      const origGeo = road.original_geometry || road.geometry;
      const rawCoords = toLeafletCoords(origGeo);
      const transformed = rawCoords.map(([lat, lng]) => {
        let dlng = (lng - cx) * scaleX;
        let dlat = (lat - cy) * scaleY;
        const rLng = dlng * cosA - dlat * sinA;
        const rLat = dlng * sinA + dlat * cosA;
        return [cy + rLat + dyDeg, cx + rLng + dxDeg];
      });
      return { ...road, positions: transformed };
    });
  }, [roads, rotation, tx, ty, scaleX, scaleY, center]);

  // Transformed preview greens for Calibration tab
  const previewGreens = useMemo(() => {
    if (!greens || greens.length === 0) return [];
    const rad = (rotation * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    const [cy, cx] = center;

    const latRad = (cy * Math.PI) / 180;
    const dxDeg = Math.abs(cy) <= 89 ? tx / (111320 * Math.cos(latRad)) : 0;
    const dyDeg = ty / 110574;

    return greens.map((green) => {
      const origGeo = green.original_geometry || green.geometry;
      const rawCoords = toLeafletCoords(origGeo);
      const transformed = rawCoords.map(([lat, lng]) => {
        let dlng = (lng - cx) * scaleX;
        let dlat = (lat - cy) * scaleY;
        const rLng = dlng * cosA - dlat * sinA;
        const rLat = dlng * sinA + dlat * cosA;
        return [cy + rLat + dyDeg, cx + rLng + dxDeg];
      });
      return { ...green, positions: transformed };
    });
  }, [greens, rotation, tx, ty, scaleX, scaleY, center]);

  // Calibration telemetry stats
  const stats = useMemo(() => {
    const total = previewPlotPositions.length;
    const inside = previewPlotPositions.filter((p) => p.isInside).length;
    const pct = total > 0 ? Math.round((inside / total) * 100) : 100;
    return { total, inside, pct };
  }, [previewPlotPositions]);

  const handleNudge = (dx, dy) => {
    setTx((prev) => Math.round((prev + dx) * 10) / 10);
    setTy((prev) => Math.round((prev + dy) * 10) / 10);
  };

  const handleRotate = (dDeg) => {
    setRotation((prev) => {
      let next = (prev + dDeg) % 360;
      if (next < 0) next += 360;
      return Math.round(next * 10) / 10;
    });
  };

  // Calibration save
  const handleSaveCalibration = async () => {
    setSaving(true);
    setError("");
    setSuccessMsg("");
    try {
      const payload = {
        rotation_deg: rotation,
        scale_x: scaleX,
        scale_y: scaleY,
        translation_x_m: tx,
        translation_y_m: ty,
      };

      await api.post(`/admin/colonies/${colonyId}/calibration/commit`, payload);
      setSuccessMsg("Calibration saved successfully! Synchronized across 2D & 3D.");
      setTimeout(() => {
        onConfirmed?.();
        onClose();
      }, 700);
    } catch (err) {
      setError(`Save failed: ${errMsg(err)}`);
      setSaving(false);
    }
  };

  // Calibration reset
  const handleResetCalibration = async () => {
    if (!window.confirm("Reset all plot and road geometries back to their original uncalibrated coordinates?")) {
      return;
    }
    setResetting(true);
    setError("");
    setSuccessMsg("");
    try {
      await api.post(`/admin/colonies/${colonyId}/calibration/reset`);
      setRotation(0);
      setTx(0);
      setTy(0);
      setScaleX(1);
      setScaleY(1);
      setSuccessMsg("Layout reset to original source geometry.");
      onConfirmed?.();
    } catch (err) {
      setError(`Reset failed: ${errMsg(err)}`);
    } finally {
      setResetting(false);
    }
  };

  // =========================================================================
  // GEOMETRY STUDIO ACTIONS (Boundary, Plots, Roads, Greens)
  // =========================================================================
  const handleBoundaryEdited = useCallback((newGeo, areaSqyd) => {
    setBoundaryGeo(newGeo);
    setBoundaryAreaSqyd(areaSqyd);
    setBoundaryChanged(true);
  }, []);

  const handleSaveBoundary = async () => {
    if (!boundaryGeo || !colonyId) return;
    setSaving(true);
    setError("");
    try {
      await api.put(`/admin/colonies/${colonyId}/boundary`, {
        boundary: boundaryGeo,
      });
      setBoundaryChanged(false);
      setSuccessMsg("Colony Land Boundary updated and synchronized in database!");
      onConfirmed?.();
    } catch (err) {
      console.error("Boundary save error:", err);
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmCreatePlot = async () => {
    if (!plotDraftModal || !newPlotNumber.trim()) return;
    setSaving(true);
    setError("");
    try {
      const res = await api.post(`/admin/colonies/${colonyId}/plots`, {
        number: newPlotNumber.trim(),
        plot_type: newPlotType,
        status_id: newPlotStatus,
        geometry: plotDraftModal.geojson,
      });

      if (plotDraftModal.tempLayer) {
        try { plotDraftModal.tempLayer.remove(); } catch (_) {}
      }

      const createdPlot = res.data?.plot || res.data;
      if (createdPlot) {
        setPlots((prev) => [...prev, createdPlot]);
      }
      setPlotDraftModal(null);
      const displayArea = createdPlot?.area_sqyd || plotDraftModal.area_sqyd || "";
      setSuccessMsg(`Plot ${newPlotNumber} created successfully${displayArea ? ` (${displayArea} sq.yd)` : ""}!`);
      setGeoTool("inspect");
      onConfirmed?.();
    } catch (err) {
      console.error("Plot create error:", err);
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmCreateRoad = async () => {
    if (!roadDraftModal || !newRoadName.trim()) return;
    setSaving(true);
    setError("");
    try {
      const res = await api.post(`/admin/colonies/${colonyId}/roads`, {
        name: newRoadName.trim(),
        width_ft: Number(newRoadWidthFt) || 30,
        geometry: roadDraftModal.geojson,
        centerline: roadDraftModal.geojson,
      });

      if (roadDraftModal.tempLayer) {
        try { roadDraftModal.tempLayer.remove(); } catch (_) {}
      }

      const createdRoad = res.data?.road || res.data;
      if (createdRoad) {
        setRoads((prev) => [...prev, createdRoad]);
      }
      setRoadDraftModal(null);
      setSuccessMsg(`Road "${newRoadName}" (${newRoadWidthFt}ft corridor) created successfully!`);
      setGeoTool("inspect");
      onConfirmed?.();
    } catch (err) {
      console.error("Road create error:", err);
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmCreateGreen = async () => {
    if (!greenDraftModal || !newGreenName.trim()) return;
    setSaving(true);
    setError("");
    try {
      const res = await api.post(`/admin/colonies/${colonyId}/greens`, {
        name: newGreenName.trim(),
        amenity_type: newGreenType,
        geometry: greenDraftModal.geojson,
      });

      if (greenDraftModal.tempLayer) {
        try { greenDraftModal.tempLayer.remove(); } catch (_) {}
      }

      const createdGreen = res.data?.green || res.data;
      if (createdGreen) {
        setGreens((prev) => [...prev, createdGreen]);
      }
      setGreenDraftModal(null);
      setSuccessMsg(`Green space "${newGreenName}" created successfully!`);
      setGeoTool("inspect");
      onConfirmed?.();
    } catch (err) {
      console.error("Green create error:", err);
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const commitReshaping = async () => {
    if (!reshapingFeature) return;
    const { layer, data, type } = reshapingFeature;
    const raw = layer.getLatLngs();
    const updatedLatLngs = Array.isArray(raw[0]) ? raw[0] : raw;
    const newGeo = latLngsToGeoJSON(updatedLatLngs);

    setSaving(true);
    setError("");
    try {
      if (type === "plot") {
        const plotId = data.id || data._id;
        const res = await api.patch(`/admin/plots/${plotId}/geometry`, {
          geometry: newGeo,
        });
        const updatedPlot = res.data?.plot || res.data;
        setPlots((prev) =>
          prev.map((p) => ((p.id || p._id) === plotId ? { ...p, ...updatedPlot, geometry: newGeo } : p))
        );
        setSuccessMsg(`Plot ${data.number || ""} geometry successfully updated!`);
      } else if (type === "road") {
        const roadId = data.id;
        await api.put(`/admin/colonies/${colonyId}/roads/${roadId}`, {
          name: data.name,
          width_ft: data.width_ft || 30,
          geometry: newGeo,
        });
        setRoads((prev) =>
          prev.map((r) => (r.id === roadId ? { ...r, geometry: newGeo } : r))
        );
        setSuccessMsg(`Road "${data.name}" geometry successfully updated!`);
      } else if (type === "green") {
        const greenId = data.id;
        await api.put(`/admin/colonies/${colonyId}/greens/${greenId}`, {
          name: data.name,
          amenity_type: data.amenity_type || "park",
          geometry: newGeo,
        });
        setGreens((prev) =>
          prev.map((g) => (g.id === greenId ? { ...g, geometry: newGeo } : g))
        );
        setSuccessMsg(`Green space "${data.name}" geometry updated!`);
      }
      try {
        layer.pm.disable();
      } catch (_) {}
      setReshapingFeature(null);
      onConfirmed?.();
    } catch (err) {
      console.error("Reshape commit error:", err);
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteConfirmModal) return;
    const { type, id, name } = deleteConfirmModal;
    setSaving(true);
    setError("");
    try {
      if (type === "plot") {
        await api.delete(`/admin/plots/${id}`);
        setPlots((prev) => prev.filter((p) => (p.id || p._id) !== id));
        setSuccessMsg(`${name} successfully deleted.`);
      } else if (type === "road") {
        await api.delete(`/admin/colonies/${colonyId}/roads/${id}`);
        setRoads((prev) => prev.filter((r) => r.id !== id));
        setSuccessMsg(`${name} successfully deleted.`);
      } else if (type === "green") {
        await api.delete(`/admin/colonies/${colonyId}/greens/${id}`);
        setGreens((prev) => prev.filter((g) => g.id !== id));
        setSuccessMsg(`${name} successfully deleted.`);
      }
      setDeleteConfirmModal(null);
      setSelectedFeature(null);
      onConfirmed?.();
    } catch (err) {
      console.error("Deletion error:", err);
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  // Plot styles for calibration view
  const getPlotStyle = (plot) => {
    const isSold = plot.status_id === "sold";
    const isBooked = plot.status_id === "booked";
    if (isSold) {
      return { stroke: "#dc2626", fill: "#ef4444", fillOpacity: 0.55, weight: 1.5 };
    }
    if (isBooked) {
      return { stroke: "#d97706", fill: "#f59e0b", fillOpacity: 0.45, weight: 1.5 };
    }
    return { stroke: "#10b981", fill: "#10b981", fillOpacity: 0.25, weight: 1.2 };
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-md p-3 sm:p-5 overflow-hidden select-none font-sans">
      <div className="bg-[#FAF8F5] border border-[#DCD2BE] rounded-3xl w-full max-w-7xl h-[94vh] flex flex-col shadow-2xl overflow-hidden text-[#172A25]">
        {/* ===================================================================
            HEADER: TITLE + SEGMENTED TAB SWITCHER + CLOSE
           =================================================================== */}
        <div className="px-6 py-3.5 border-b border-[#DCD2BE] flex items-center justify-between bg-white">
          <div className="flex items-center gap-3.5">
            <div className="p-2.5 rounded-xl border bg-[#F3EFE6] border-[#DCD2BE] text-[#173F35] shadow-sm">
              {studioTab === "geometry" ? <PencilRuler size={19} /> : <Move size={19} />}
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-base font-bold tracking-tight text-[#172A25]">
                  {studioTab === "geometry" ? "Colony Masterplan & Boundary Editor" : "Colony Placement & Geometric Calibration"}
                </h2>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-[#F3EFE6] border border-[#DCD2BE] text-[#173F35]">
                  {colony?.name || "Colony Layout"}
                </span>
              </div>
              <p className="text-xs text-[#5C6470] mt-0.5">
                {studioTab === "geometry"
                  ? "Directly edit KML boundary corners, draw new plots/roads/parks, or reshape elements in DB."
                  : "Nudge, rotate, and scale masterplan layout to fit perfectly within the satellite boundary."}
              </p>
            </div>
          </div>

          {/* Segmented Mode Control */}
          <div className="flex items-center gap-1.5 p-1 bg-[#F3EFE6] border border-[#DCD2BE] rounded-2xl shadow-inner">
            <button
              type="button"
              onClick={() => {
                setStudioTab("calibrate");
                setReshapingFeature(null);
                setSelectedFeature(null);
              }}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-bold transition-all ${
                studioTab === "calibrate"
                  ? "bg-[#173F35] text-white shadow-sm"
                  : "text-[#5C6470] hover:text-[#172A25] hover:bg-[#EDE6D6]"
              }`}
            >
              <Move size={13} /> Alignment & Calibration
            </button>
            <button
              type="button"
              onClick={() => {
                setStudioTab("geometry");
                setGeoTool("inspect");
              }}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-bold transition-all ${
                studioTab === "geometry"
                  ? "bg-[#173F35] text-white shadow-sm"
                  : "text-[#5C6470] hover:text-[#172A25] hover:bg-[#EDE6D6]"
              }`}
            >
              <PencilRuler size={13} /> Edit Boundary & Layout
            </button>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-[#F3EFE6] text-[#5C6470] hover:text-[#172A25] transition"
            title="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* ===================================================================
            CONTENT AREA: MAP PREVIEW + CONTROLS SIDEBAR
           =================================================================== */}
        <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">
          {/* Map Preview */}
          <div className="flex-1 relative bg-slate-950 min-h-[300px]">
            <MapContainer
              center={center}
              zoom={18}
              scrollWheelZoom
              className="w-full h-full cursor-crosshair"
              zoomControl={false}
            >
              <TileLayer
                url={ESRI}
                attribution="Imagery &copy; Esri"
                maxZoom={22}
                maxNativeZoom={19}
              />
              <MapFit boundary={boundaryGeo || colony?.boundary} />

              {/* -------------------------------------------------------------
                  CALIBRATION TAB RENDERING (Passive Transformed Geometry)
                 ------------------------------------------------------------- */}
              {studioTab === "calibrate" && (
                <>
                  {/* Masterplan Base */}
                  {boundaryPts.length > 0 && (
                    <Polygon
                      positions={boundaryPts}
                      interactive={false}
                      pathOptions={{
                        color: "#10b981",
                        weight: 3.2,
                        opacity: 1,
                        fill: true,
                        fillColor: "#22262e",
                        fillOpacity: 1.0,
                        lineJoin: "round",
                      }}
                    />
                  )}

                  {/* Scanned PDF Blueprint Overlay */}
                  {showOverlay && hasOverlayImage && (
                    <CanvasImageOverlay
                      overlay={pdfOverlay}
                      boundary={colony?.boundary}
                      opacity={overlayOpacity}
                      transform={{
                        rotation_deg: rotation,
                        scale_x: scaleX,
                        scale_y: scaleY,
                        translation_x_m: tx,
                        translation_y_m: ty,
                      }}
                    />
                  )}

                  {/* Roads */}
                  {showRoads &&
                    previewRoads.map((r, i) => (
                      <Polygon
                        key={`road-${i}`}
                        positions={r.positions}
                        interactive={false}
                        pathOptions={{
                          color: "#181a1f",
                          weight: 1.2,
                          fillColor: "#22262e",
                          fillOpacity: 0.96,
                          lineJoin: "round",
                        }}
                      />
                    ))}

                  {/* Greens */}
                  {previewGreens.map((g, i) => (
                    <Polygon
                      key={`green-${i}`}
                      positions={g.positions}
                      interactive={false}
                      pathOptions={{
                        color: "#183b12",
                        weight: 1.6,
                        fillColor: "#265b1d",
                        fillOpacity: 0.95,
                        lineJoin: "round",
                      }}
                    />
                  ))}

                  {/* Plots */}
                  {showPlots &&
                    previewPlotPositions.map((p) => {
                      const style = getPlotStyle(p);
                      return (
                        <Polygon
                          key={p.id || p._id}
                          positions={p.positions}
                          interactive={false}
                          pathOptions={{
                            color: style.stroke,
                            weight: style.weight,
                            fillColor: style.fill,
                            fillOpacity: style.fillOpacity,
                          }}
                        >
                          {showPlotNumbers && p.number && (
                            <Tooltip
                              permanent
                              direction="center"
                              className="!bg-slate-900/90 !text-slate-100 !border-slate-700 !rounded !px-1.5 !py-0.5 !text-[10px] !font-mono !font-bold !shadow-md pointer-events-none"
                            >
                              {p.number}
                            </Tooltip>
                          )}
                        </Polygon>
                      );
                    })}

                  {/* Boundary Outline */}
                  {boundaryPts.length > 0 && (
                    <Polygon
                      positions={boundaryPts}
                      interactive={false}
                      pathOptions={{
                        color: "#10b981",
                        weight: 3.2,
                        fill: false,
                        dashArray: "6 6",
                      }}
                    />
                  )}
                </>
              )}

              {/* -------------------------------------------------------------
                  GEOMETRY STUDIO CONTROLLER (Leaflet + Geoman Integration)
                 ------------------------------------------------------------- */}
              <StudioGeomanController
                studioTab={studioTab}
                geoTool={geoTool}
                boundaryGeo={boundaryGeo}
                onBoundaryChange={handleBoundaryEdited}
                plots={plots}
                roads={roads}
                greens={greens}
                onPlotDrawn={(draft) => setPlotDraftModal(draft)}
                onRoadDrawn={(draft) => setRoadDraftModal(draft)}
                onGreenDrawn={(draft) => setGreenDraftModal(draft)}
                selectedFeature={selectedFeature}
                setSelectedFeature={setSelectedFeature}
                reshapingFeature={reshapingFeature}
                setReshapingFeature={setReshapingFeature}
                setDeleteConfirmModal={setDeleteConfirmModal}
              />
            </MapContainer>

            {/* -------------------------------------------------------------
                MAP OVERLAY WIDGETS
               ------------------------------------------------------------- */}
            {/* Calibration HUD Stats */}
            {studioTab === "calibrate" && (
              <div className="absolute top-4 right-4 z-[1000] bg-white/95 backdrop-blur-md border border-[#DCD2BE] rounded-2xl p-2.5 px-3.5 shadow-lg flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      stats.pct === 100
                        ? "bg-[#173F35] animate-pulse"
                        : stats.pct >= 90
                        ? "bg-amber-500"
                        : "bg-rose-500"
                    }`}
                  />
                  <span className="text-xs font-bold text-[#172A25]">
                    {stats.pct}% Boundary Fit
                  </span>
                </div>
                <div className="h-4 w-px bg-[#DCD2BE]" />
                <span className="text-xs text-[#5C6470]">
                  <b className="text-[#173F35] font-bold">{stats.inside}</b> / {stats.total} Plots Inside
                </span>
              </div>
            )}

            {/* Geometry Studio Top Tool Bar */}
            {studioTab === "geometry" && (
              <div className="absolute top-4 left-4 z-[1000] flex items-center gap-1 p-1.5 rounded-2xl bg-white/95 border border-[#DCD2BE] shadow-xl backdrop-blur-md text-xs">
                <button
                  type="button"
                  onClick={() => setGeoTool("inspect")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition-all ${
                    geoTool === "inspect"
                      ? "bg-[#173F35] text-white shadow-sm"
                      : "text-[#5C6470] hover:text-[#172A25] hover:bg-[#F3EFE6]"
                  }`}
                  title="Inspect elements"
                >
                  <Compass className={`w-3.5 h-3.5 ${geoTool === "inspect" ? "text-white" : "text-blue-600"}`} /> Inspect
                </button>

                <button
                  type="button"
                  onClick={() => setGeoTool("boundary")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition-all ${
                    geoTool === "boundary"
                      ? "bg-[#173F35] text-white shadow-sm"
                      : "text-[#5C6470] hover:text-[#172A25] hover:bg-[#F3EFE6]"
                  }`}
                  title="Edit KML Land Boundary corners and edges"
                >
                  <ShieldCheck className={`w-3.5 h-3.5 ${geoTool === "boundary" ? "text-white" : "text-amber-600"}`} /> Edit Boundary
                </button>

                <button
                  type="button"
                  onClick={() => setGeoTool("draw_plot")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition-all ${
                    geoTool === "draw_plot"
                      ? "bg-[#173F35] text-white shadow-sm"
                      : "text-[#5C6470] hover:text-[#172A25] hover:bg-[#F3EFE6]"
                  }`}
                  title="Draw new plot on map (Double click to finish)"
                >
                  <Square className={`w-3.5 h-3.5 ${geoTool === "draw_plot" ? "text-white" : "text-emerald-600"}`} /> + Draw Plot
                </button>

                <button
                  type="button"
                  onClick={() => setGeoTool("draw_road")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition-all ${
                    geoTool === "draw_road"
                      ? "bg-[#173F35] text-white shadow-sm"
                      : "text-[#5C6470] hover:text-[#172A25] hover:bg-[#F3EFE6]"
                  }`}
                  title="Draw road centerline corridor"
                >
                  <Milestone className={`w-3.5 h-3.5 ${geoTool === "draw_road" ? "text-white" : "text-indigo-600"}`} /> + Draw Road
                </button>

                <button
                  type="button"
                  onClick={() => setGeoTool("draw_green")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition-all ${
                    geoTool === "draw_green"
                      ? "bg-[#173F35] text-white shadow-sm"
                      : "text-[#5C6470] hover:text-[#172A25] hover:bg-[#F3EFE6]"
                  }`}
                  title="Draw garden or park polygon"
                >
                  <TreePine className={`w-3.5 h-3.5 ${geoTool === "draw_green" ? "text-white" : "text-teal-600"}`} /> + Draw Park
                </button>

                <button
                  type="button"
                  onClick={() => setGeoTool("reshape")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition-all ${
                    geoTool === "reshape"
                      ? "bg-[#173F35] text-white shadow-sm"
                      : "text-[#5C6470] hover:text-[#172A25] hover:bg-[#F3EFE6]"
                  }`}
                  title="Click any plot or road to drag vertices"
                >
                  <Move className={`w-3.5 h-3.5 ${geoTool === "reshape" ? "text-white" : "text-emerald-600"}`} /> Reshape
                </button>

                <button
                  type="button"
                  onClick={() => setGeoTool("delete")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition-all ${
                    geoTool === "delete"
                      ? "bg-rose-600 text-white shadow-sm"
                      : "text-[#5C6470] hover:text-rose-600 hover:bg-rose-50"
                  }`}
                  title="Click any plot or road to delete"
                >
                  <Trash2 className={`w-3.5 h-3.5 ${geoTool === "delete" ? "text-white" : "text-rose-500"}`} /> Delete
                </button>
              </div>
            )}

            {/* Reshape Commit Floating Pill */}
            {reshapingFeature && (
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-3 px-5 py-2.5 rounded-2xl bg-white/95 border border-[#DCD2BE] shadow-2xl backdrop-blur-md text-xs text-[#172A25]">
                <span className="font-semibold text-[#172A25]">
                  Editing: <b className="text-[#173F35]">{reshapingFeature.data.number || reshapingFeature.data.name || reshapingFeature.type}</b>
                </span>
                <button
                  type="button"
                  onClick={commitReshaping}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 font-bold rounded-xl bg-[#173F35] hover:bg-[#0F2922] text-white shadow transition-all disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  {saving ? "Saving..." : "Commit Reshape"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      reshapingFeature.layer.pm.disable();
                    } catch (_) {}
                    setReshapingFeature(null);
                  }}
                  className="px-3 py-1.5 rounded-xl bg-[#F3EFE6] hover:bg-[#EDE6D6] text-[#172A25] font-semibold border border-[#DCD2BE]"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Map Legend */}
            <div className="absolute bottom-4 left-4 z-[1000] bg-white/95 backdrop-blur border border-[#DCD2BE] rounded-2xl px-3.5 py-2.5 text-[11px] space-y-1.5 shadow-md max-w-sm text-[#172A25]">
              <div className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded-sm border-2 border-emerald-600 bg-emerald-600/20" />
                <span className="font-bold text-[#173F35]">
                  KML Land Boundary ({boundaryAreaSqyd ? `${boundaryAreaSqyd.toLocaleString()} sq.yd` : "Ground Truth"})
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded-sm border border-emerald-500 bg-emerald-500/20" />
                <span className="font-semibold text-[#172A25]">
                  Masterplan Plots ({plots.length})
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded-sm border border-[#5C6470] bg-[#5C6470]/30" />
                <span className="font-semibold text-[#5C6470]">
                  Roads ({roads.length})
                </span>
              </div>
            </div>
          </div>

          {/* =================================================================
              SIDEBAR: CALIBRATION TAB OR GEOMETRY STUDIO TAB
             ================================================================= */}
          <div className="w-full lg:w-[380px] bg-[#FAF8F5] border-l border-[#DCD2BE] p-4 flex flex-col gap-3 overflow-y-auto calib-sidebar-scroll shrink-0">
            {/* ---------------------------------------------------------------
                1. GEOMETRY STUDIO SIDEBAR
               --------------------------------------------------------------- */}
            {studioTab === "geometry" && (
              <div className="space-y-3 flex flex-col flex-1">
                {/* Land Boundary Telemetry Card */}
                <div className="p-3.5 rounded-xl bg-white border border-[#DCD2BE] shadow-xs space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] uppercase font-bold tracking-wider text-[#173F35] flex items-center gap-1.5">
                      <ShieldCheck size={13} className="text-[#173F35]" /> Land Boundary Metrics
                    </span>
                    {boundaryChanged && (
                      <span className="text-[9px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded border border-amber-300 animate-pulse">
                        Unsaved Edges
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="p-2.5 rounded-lg bg-[#F3EFE6] border border-[#DCD2BE]">
                      <span className="text-[#5C6470] block text-[10px] font-bold uppercase tracking-wider">Total Area</span>
                      <span className="text-[#173F35] font-black text-sm font-mono block mt-0.5">
                        {boundaryAreaSqyd ? boundaryAreaSqyd.toLocaleString() : "0"} <span className="text-[11px] font-semibold font-sans">sq.yd</span>
                      </span>
                    </div>
                    <div className="p-2.5 rounded-lg bg-[#F3EFE6] border border-[#DCD2BE]">
                      <span className="text-[#5C6470] block text-[10px] font-bold uppercase tracking-wider">In Acres</span>
                      <span className="text-[#172A25] font-black text-sm font-mono block mt-0.5">
                        {boundaryAreaSqyd ? (boundaryAreaSqyd / 4840).toFixed(3) : "0.000"} <span className="text-[11px] font-semibold font-sans">Ac</span>
                      </span>
                    </div>
                  </div>

                  <p className="text-[11px] text-[#5C6470] leading-normal">
                    Select <b>"Edit Boundary"</b> tool to drag any corner vertex or midpoint on the outer perimeter to extend or shrink land boundaries.
                  </p>

                  {boundaryChanged && (
                    <button
                      type="button"
                      onClick={handleSaveBoundary}
                      disabled={saving}
                      className="w-full py-2 px-3 rounded-lg bg-[#173F35] hover:bg-[#0F2922] text-white font-bold text-xs shadow-sm transition-all flex items-center justify-center gap-1.5"
                    >
                      <Save size={13} />
                      {saving ? "Saving Boundary..." : "Save Boundary Changes"}
                    </button>
                  )}
                </div>

                {/* Selected Item Telemetry Card */}
                {selectedFeature ? (
                  <div className="p-3.5 rounded-xl bg-white border border-[#DCD2BE] shadow-xs space-y-2.5 text-xs">
                    <div className="flex items-center justify-between pb-1.5 border-b border-[#DCD2BE]">
                      <span className="font-bold text-[#172A25] uppercase text-[11px] flex items-center gap-1.5">
                        {selectedFeature.type === "plot" && <Square className="w-3.5 h-3.5 text-emerald-600" />}
                        {selectedFeature.type === "road" && <Milestone className="w-3.5 h-3.5 text-indigo-600" />}
                        {selectedFeature.type === "green" && <TreePine className="w-3.5 h-3.5 text-teal-600" />}
                        {selectedFeature.type} Details
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedFeature(null)}
                        className="text-[#5C6470] hover:text-[#172A25]"
                      >
                        <X size={14} />
                      </button>
                    </div>

                    {selectedFeature.type === "plot" && (
                      <div className="space-y-1.5 text-[#172A25]">
                        <div className="flex justify-between items-center">
                          <span className="text-[#5C6470]">Plot Number</span>
                          <span className="font-bold text-[#173F35] bg-[#F3EFE6] px-2 py-0.5 rounded-lg border border-[#DCD2BE]">
                            {selectedFeature.data.number}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[#5C6470]">Status</span>
                          <span className="font-bold capitalize text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                            {selectedFeature.data.status_id || "Available"}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[#5C6470]">Area</span>
                          <span className="font-mono font-bold text-[#173F35]">
                            {selectedFeature.data.area_sqyd || Math.round((selectedFeature.data.area_sqm || 0) * 1.196)} sq.yd
                          </span>
                        </div>
                        {selectedFeature.data.dimensions && (
                          <div className="flex justify-between items-center">
                            <span className="text-[#5C6470]">Dimensions</span>
                            <span className="font-mono text-[#172A25]">{selectedFeature.data.dimensions}</span>
                          </div>
                        )}
                        <div className="flex gap-2 pt-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              try {
                                selectedFeature.layer.pm.enable({ allowSelfIntersection: false });
                                setReshapingFeature({ layer: selectedFeature.layer, data: selectedFeature.data, type: "plot" });
                              } catch (_) {}
                            }}
                            className="flex-1 py-1.5 px-3 rounded-lg bg-[#173F35] hover:bg-[#0F2922] text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition"
                          >
                            <Move size={12} /> Reshape Corners
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteConfirmModal({ type: "plot", id: selectedFeature.data.id || selectedFeature.data._id, name: `Plot ${selectedFeature.data.number}` })}
                            className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-600 hover:text-white text-rose-600 border border-rose-200 transition"
                            title="Delete plot"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    )}

                    {selectedFeature.type === "road" && (
                      <div className="space-y-1.5 text-[#172A25]">
                        <div className="flex justify-between items-center">
                          <span className="text-[#5C6470]">Road Name</span>
                          <span className="font-bold text-[#172A25]">{selectedFeature.data.name}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[#5C6470]">Corridor Width</span>
                          <span className="text-indigo-700 font-bold bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-200">{selectedFeature.data.width_ft || 30} ft</span>
                        </div>
                        <div className="flex gap-2 pt-1.5">
                          <button
                            type="button"
                            onClick={() => setDeleteConfirmModal({ type: "road", id: selectedFeature.data.id, name: selectedFeature.data.name })}
                            className="w-full py-1.5 rounded-lg bg-rose-50 hover:bg-rose-600 hover:text-white text-rose-600 border border-rose-200 font-bold flex items-center justify-center gap-1 transition"
                          >
                            <Trash2 size={13} /> Delete Road
                          </button>
                        </div>
                      </div>
                    )}

                    {selectedFeature.type === "green" && (
                      <div className="space-y-1.5 text-[#172A25]">
                        <div className="flex justify-between items-center">
                          <span className="text-[#5C6470]">Park Name</span>
                          <span className="font-bold text-teal-800">{selectedFeature.data.name}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[#5C6470]">Amenity Type</span>
                          <span className="capitalize font-semibold">{selectedFeature.data.amenity_type || "Park"}</span>
                        </div>
                        <div className="flex gap-2 pt-1.5">
                          <button
                            type="button"
                            onClick={() => setDeleteConfirmModal({ type: "green", id: selectedFeature.data.id, name: selectedFeature.data.name })}
                            className="w-full py-1.5 rounded-lg bg-rose-50 hover:bg-rose-600 hover:text-white text-rose-600 border border-rose-200 font-bold flex items-center justify-center gap-1 transition"
                          >
                            <Trash2 size={13} /> Delete Park
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-3.5 rounded-xl bg-white border border-[#DCD2BE] shadow-xs text-xs space-y-2">
                    <span className="font-bold text-[#172A25] block text-xs tracking-tight">Editor Quick Guide</span>
                    <div className="space-y-1.5 text-[11px] text-[#5C6470]">
                      <div className="flex items-start gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#173F35] mt-1.5 shrink-0" />
                        <span><b className="text-[#172A25]">Edit Boundary:</b> Drag outer perimeter nodes or edge midpoints.</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 mt-1.5 shrink-0" />
                        <span><b className="text-[#172A25]">+ Draw Plot:</b> Click on map to place corners; double click to save.</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 mt-1.5 shrink-0" />
                        <span><b className="text-[#172A25]">+ Draw Road:</b> Trace centerline corridor with chosen width.</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-teal-600 mt-1.5 shrink-0" />
                        <span><b className="text-[#172A25]">Reshape:</b> Click any plot/road/park to drag vertex handles.</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-600 mt-1.5 shrink-0" />
                        <span><b className="text-[#172A25]">Delete:</b> Click any element to remove from database.</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ---------------------------------------------------------------
                2. CALIBRATION TAB SIDEBAR (Original Controls Preserved)
               --------------------------------------------------------------- */}
            {studioTab === "calibrate" && (
              <>
                {/* ROTATION SECTION */}
                <div className="space-y-2 bg-white p-3.5 rounded-xl border border-[#DCD2BE] shadow-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] uppercase font-bold tracking-wider text-[#173F35] flex items-center gap-1.5">
                      <RotateCw size={13} className="text-[#173F35]" /> Rotation Angle
                    </span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        step="0.1"
                        value={rotation}
                        onChange={(e) => setRotation(parseFloat(e.target.value) || 0)}
                        className="w-14 h-6 bg-[#F3EFE6] text-[#172A25] font-mono text-xs font-bold text-center px-1 rounded-md border border-[#DCD2BE] focus:outline-none focus:border-[#173F35] focus:bg-white"
                      />
                      <span className="text-xs text-[#173F35] font-bold">°</span>
                    </div>
                  </div>

                  <input
                    type="range"
                    min="-180"
                    max="180"
                    step="0.2"
                    value={rotation > 180 ? rotation - 360 : rotation}
                    onChange={(e) => {
                      let val = parseFloat(e.target.value);
                      if (val < 0) val += 360;
                      setRotation(Math.round(val * 10) / 10);
                    }}
                    className="calib-range-slider"
                  />

                  <div className="grid grid-cols-4 gap-1.5">
                    {[-15, -1, 1, 15].map((deg) => (
                      <button
                        key={deg}
                        onClick={() => handleRotate(deg)}
                        className="py-1 px-1 bg-[#F3EFE6] hover:bg-[#EDE6D6] active:scale-95 text-[11px] font-bold rounded-lg text-[#172A25] border border-[#DCD2BE] transition text-center"
                      >
                        {deg > 0 ? `+${deg}°` : `${deg}°`}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-4 gap-1.5 pt-0.5">
                    {[
                      { val: 0, label: "0° (N)" },
                      { val: 90, label: "90° (E)" },
                      { val: 180, label: "180° (S)" },
                      { val: 270, label: "270° (W)" },
                    ].map((cardinal) => (
                      <button
                        key={cardinal.val}
                        onClick={() => setRotation(cardinal.val)}
                        className={`py-1 px-1 text-[10px] font-bold rounded-lg border transition-all text-center ${
                          rotation === cardinal.val
                            ? "bg-[#173F35] text-white border-[#173F35] shadow-xs"
                            : "bg-[#F3EFE6] text-[#5C6470] border-[#DCD2BE] hover:bg-[#EDE6D6] hover:text-[#172A25]"
                        }`}
                      >
                        {cardinal.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* SCALE SECTION */}
                <div className="space-y-2 bg-white p-3.5 rounded-xl border border-[#DCD2BE] shadow-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] uppercase font-bold tracking-wider text-[#173F35] flex items-center gap-1.5">
                      <Maximize2 size={13} className="text-[#173F35]" /> Scale Factor
                    </span>
                    <span className="font-mono text-xs text-[#173F35] font-bold bg-[#F3EFE6] px-2 py-0.5 rounded-md border border-[#DCD2BE]">
                      {scaleX === scaleY
                        ? `${Math.round(scaleX * 100)}%`
                        : `X:${Math.round(scaleX * 100)}% Y:${Math.round(scaleY * 100)}%`}
                    </span>
                  </div>

                  <input
                    type="range"
                    min="0.5"
                    max="1.5"
                    step="0.005"
                    value={scaleX}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setScaleX(v);
                      setScaleY(v);
                    }}
                    className="calib-range-slider"
                  />

                  <div className="grid grid-cols-4 gap-1.5">
                    <button
                      onClick={() => {
                        setScaleX((prev) => Math.max(0.1, Math.round((prev - 0.05) * 100) / 100));
                        setScaleY((prev) => Math.max(0.1, Math.round((prev - 0.05) * 100) / 100));
                      }}
                      className="py-1 px-1 bg-[#F3EFE6] hover:bg-[#EDE6D6] active:scale-95 text-[11px] font-bold rounded-lg text-[#172A25] border border-[#DCD2BE] transition text-center"
                    >
                      -5%
                    </button>
                    <button
                      onClick={() => {
                        setScaleX((prev) => Math.max(0.1, Math.round((prev - 0.01) * 100) / 100));
                        setScaleY((prev) => Math.max(0.1, Math.round((prev - 0.01) * 100) / 100));
                      }}
                      className="py-1 px-1 bg-[#F3EFE6] hover:bg-[#EDE6D6] active:scale-95 text-[11px] font-bold rounded-lg text-[#172A25] border border-[#DCD2BE] transition text-center"
                    >
                      -1%
                    </button>
                    <button
                      onClick={() => {
                        setScaleX((prev) => Math.round((prev + 0.01) * 100) / 100);
                        setScaleY((prev) => Math.round((prev + 0.01) * 100) / 100);
                      }}
                      className="py-1 px-1 bg-[#F3EFE6] hover:bg-[#EDE6D6] active:scale-95 text-[11px] font-bold rounded-lg text-[#172A25] border border-[#DCD2BE] transition text-center"
                    >
                      +1%
                    </button>
                    <button
                      onClick={() => {
                        setScaleX((prev) => Math.round((prev + 0.05) * 100) / 100);
                        setScaleY((prev) => Math.round((prev + 0.05) * 100) / 100);
                      }}
                      className="py-1 px-1 bg-[#F3EFE6] hover:bg-[#EDE6D6] active:scale-95 text-[11px] font-bold rounded-lg text-[#172A25] border border-[#DCD2BE] transition text-center"
                    >
                      +5%
                    </button>
                  </div>
                </div>

                {/* TRANSLATION (NUDGE) SECTION */}
                <div className="space-y-2 bg-white p-3.5 rounded-xl border border-[#DCD2BE] shadow-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] uppercase font-bold tracking-wider text-[#173F35] flex items-center gap-1.5">
                      <Move size={13} className="text-[#173F35]" /> Position Offset
                    </span>
                    <span className="font-mono text-xs text-[#173F35] font-bold bg-[#F3EFE6] px-2 py-0.5 rounded-md border border-[#DCD2BE]">
                      X: {tx}m, Y: {ty}m
                    </span>
                  </div>

                  {/* Tactile Nudge Direction Pad with Clean Vector Icons */}
                  <div className="grid grid-cols-3 gap-1.5 w-[142px] mx-auto py-0.5">
                    <div />
                    <button
                      onClick={() => handleNudge(0, stepSize)}
                      className="calib-nudge-btn"
                      title="Nudge North"
                    >
                      <ChevronUp size={18} />
                    </button>
                    <div />
                    <button
                      onClick={() => handleNudge(-stepSize, 0)}
                      className="calib-nudge-btn"
                      title="Nudge West"
                    >
                      <ChevronLeft size={18} />
                    </button>
                    <button
                      onClick={() => {
                        setTx(0);
                        setTy(0);
                      }}
                      className="calib-nudge-btn flex-col gap-0.5 text-[#5C6470]"
                      title="Reset Position"
                    >
                      <RotateCcw size={11} />
                      <span className="text-[9px] font-bold uppercase tracking-wider">Reset</span>
                    </button>
                    <button
                      onClick={() => handleNudge(stepSize, 0)}
                      className="calib-nudge-btn"
                      title="Nudge East"
                    >
                      <ChevronRight size={18} />
                    </button>
                    <div />
                    <button
                      onClick={() => handleNudge(0, -stepSize)}
                      className="calib-nudge-btn"
                      title="Nudge South"
                    >
                      <ChevronDown size={18} />
                    </button>
                    <div />
                  </div>

                  {/* Step size */}
                  <div className="flex items-center justify-between pt-0.5">
                    <span className="text-[11px] text-[#5C6470] font-semibold">Step Size:</span>
                    <div className="flex gap-1">
                      {[0.5, 2, 10].map((s) => (
                        <button
                          key={s}
                          onClick={() => setStepSize(s)}
                          className={`px-2.5 py-0.5 rounded-lg text-[10px] font-bold border transition-all ${
                            stepSize === s
                              ? "bg-[#173F35] text-white border-[#173F35] shadow-xs"
                              : "bg-[#F3EFE6] text-[#5C6470] border-[#DCD2BE] hover:text-[#172A25] hover:bg-[#EDE6D6]"
                          }`}
                        >
                          {s}m
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* LAYER VISIBILITY CONTROLS */}
                <div className="space-y-2 bg-white p-3.5 rounded-xl border border-[#DCD2BE] shadow-xs">
                  <span className="text-[11px] uppercase font-bold tracking-wider text-[#173F35] flex items-center gap-1.5">
                    <Sliders size={13} className="text-[#173F35]" /> Masterplan Display Layers
                  </span>

                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <label className="flex items-center gap-2 cursor-pointer text-[#172A25] font-medium hover:text-[#173F35] transition">
                      <input
                        type="checkbox"
                        checked={showPlots}
                        onChange={(e) => setShowPlots(e.target.checked)}
                        className="rounded accent-[#173F35]"
                      />
                      Show Plots
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-[#172A25] font-medium hover:text-[#173F35] transition">
                      <input
                        type="checkbox"
                        checked={showPlotNumbers}
                        disabled={!showPlots}
                        onChange={(e) => setShowPlotNumbers(e.target.checked)}
                        className="rounded accent-[#173F35] disabled:opacity-40"
                      />
                      Plot Numbers
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-[#172A25] font-medium hover:text-[#173F35] transition">
                      <input
                        type="checkbox"
                        checked={showRoads}
                        onChange={(e) => setShowRoads(e.target.checked)}
                        className="rounded accent-[#173F35]"
                      />
                      Roads & Curbs
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-[#172A25] font-medium hover:text-[#173F35] transition">
                      <input
                        type="checkbox"
                        checked={showMasterplanLawn}
                        onChange={(e) => setShowMasterplanLawn(e.target.checked)}
                        className="rounded accent-[#173F35]"
                      />
                      Masterplan Lawn
                    </label>
                  </div>

                  {/* Scanned PDF Blueprint Overlay */}
                  {hasOverlayImage && (
                    <div className="pt-2 border-t border-[#DCD2BE] space-y-1.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <label className="flex items-center gap-2 cursor-pointer text-[#172A25] font-medium hover:text-[#173F35]">
                          <input
                            type="checkbox"
                            checked={showOverlay}
                            onChange={(e) => setShowOverlay(e.target.checked)}
                            className="rounded accent-[#173F35]"
                          />
                          Compare with Scanned PDF
                        </label>
                        {showOverlay && (
                          <span className="font-mono text-[#173F35] font-bold">
                            {Math.round(overlayOpacity * 100)}%
                          </span>
                        )}
                      </div>
                      {showOverlay && (
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={overlayOpacity}
                          onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
                          className="calib-range-slider"
                        />
                      )}
                    </div>
                  )}
                </div>

                {/* CALIBRATION ACTION BUTTONS (Sticky Footer) */}
                <div className="sticky bottom-0 -mx-4 -mb-4 p-3.5 bg-[#FAF8F5]/95 backdrop-blur-md space-y-2 border-t border-[#DCD2BE] shadow-[0_-4px_12px_rgba(0,0,0,0.04)] z-20">
                  <button
                    onClick={handleResetCalibration}
                    disabled={resetting || saving}
                    className="w-full py-2 px-3 bg-white hover:bg-[#F3EFE6] active:scale-[0.98] text-[#172A25] font-bold text-xs rounded-xl flex items-center justify-center gap-2 border border-[#DCD2BE] transition disabled:opacity-50"
                  >
                    <RotateCcw size={13} />
                    {resetting ? "Resetting Geometries…" : "Reset to Original Geometry"}
                  </button>

                  <button
                    onClick={handleSaveCalibration}
                    disabled={saving || resetting}
                    className="w-full py-2.5 px-3 bg-[#173F35] hover:bg-[#0F2922] active:scale-[0.98] text-white font-extrabold text-xs rounded-xl flex items-center justify-center gap-2 transition shadow-md disabled:opacity-50"
                  >
                    <CheckCircle size={15} />
                    {saving ? "Applying to 2D & 3D Maps…" : "Save & Apply Calibration"}
                  </button>
                  <p className="text-[10px] text-center text-[#5C6470]">
                    Saves calibration permanently to DB. Plots and 3D satellite view update immediately.
                  </p>
                </div>
              </>
            )}

            {/* Error & Success Messages */}
            {error && (
              <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-start gap-2">
                <AlertTriangle size={15} className="shrink-0 mt-0.5 text-rose-600" />
                <span>{error}</span>
              </div>
            )}
            {successMsg && (
              <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-[#173F35] flex items-center gap-2">
                <Check size={15} className="shrink-0 text-[#173F35]" />
                <span>{successMsg}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* =====================================================================
          DIALOG: CREATE PLOT DETAILS
         ===================================================================== */}
      {plotDraftModal && (
        <div className="fixed inset-0 z-[10010] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#FAF8F5] border border-[#DCD2BE] shadow-2xl p-5 text-[#172A25] flex flex-col gap-4">
            <div className="flex items-center justify-between pb-2 border-b border-[#DCD2BE]">
              <h3 className="font-bold text-base text-[#173F35] flex items-center gap-2">
                <Square className="w-4 h-4 text-emerald-600" /> Save New Plot
              </h3>
              <button
                type="button"
                onClick={() => {
                  plotDraftModal.tempLayer?.remove();
                  setPlotDraftModal(null);
                  setGeoTool("inspect");
                }}
                className="text-[#5C6470] hover:text-[#172A25]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {error && (
              <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[#5C6470] mb-1 font-semibold">Plot Number / Label</label>
                <input
                  type="text"
                  value={newPlotNumber}
                  onChange={(e) => setNewPlotNumber(e.target.value)}
                  placeholder="e.g. 101, A-12, Villa-4"
                  className="w-full px-3 py-2 rounded-xl bg-white border border-[#DCD2BE] focus:border-[#173F35] text-[#172A25] font-bold outline-none"
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#5C6470] mb-1 font-semibold">Plot Category</label>
                  <select
                    value={newPlotType}
                    onChange={(e) => setNewPlotType(e.target.value)}
                    className="w-full px-2.5 py-2 rounded-xl bg-white border border-[#DCD2BE] text-[#172A25] outline-none font-medium"
                  >
                    <option value="residential">Residential</option>
                    <option value="commercial">Commercial</option>
                    <option value="corner">Corner Plot</option>
                    <option value="villa">Villa / Duplex</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[#5C6470] mb-1 font-semibold">Status</label>
                  <select
                    value={newPlotStatus}
                    onChange={(e) => setNewPlotStatus(e.target.value)}
                    className="w-full px-2.5 py-2 rounded-xl bg-white border border-[#DCD2BE] text-[#172A25] outline-none font-medium"
                  >
                    <option value="available">Available (Green)</option>
                    <option value="booked">Booked (Amber)</option>
                    <option value="sold">Sold (Red)</option>
                  </select>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-[#F3EFE6] border border-[#DCD2BE] flex items-center justify-between">
                <span className="text-[#5C6470] font-semibold">Calculated Area</span>
                <span className="text-[#173F35] font-black text-sm">
                  {plotDraftModal.area_sqyd} sq.yd
                </span>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  plotDraftModal.tempLayer?.remove();
                  setPlotDraftModal(null);
                  setGeoTool("inspect");
                }}
                className="flex-1 py-2 rounded-xl bg-[#F3EFE6] hover:bg-[#EDE6D6] text-[#172A25] font-semibold text-xs border border-[#DCD2BE] transition-all"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmCreatePlot}
                disabled={saving || !newPlotNumber.trim()}
                className="flex-1 py-2 rounded-xl bg-[#173F35] hover:bg-[#0F2922] text-white font-bold text-xs shadow-md transition-all disabled:opacity-50"
              >
                {saving ? "Creating Plot..." : "Save Plot to Masterplan"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          DIALOG: CREATE ROAD DETAILS
         ===================================================================== */}
      {roadDraftModal && (
        <div className="fixed inset-0 z-[10010] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#FAF8F5] border border-[#DCD2BE] shadow-2xl p-5 text-[#172A25] flex flex-col gap-4">
            <div className="flex items-center justify-between pb-2 border-b border-[#DCD2BE]">
              <h3 className="font-bold text-base text-indigo-700 flex items-center gap-2">
                <Milestone className="w-4 h-4 text-indigo-600" /> Save New Road Corridor
              </h3>
              <button
                type="button"
                onClick={() => {
                  roadDraftModal.tempLayer?.remove();
                  setRoadDraftModal(null);
                  setGeoTool("inspect");
                }}
                className="text-[#5C6470] hover:text-[#172A25]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {error && (
              <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[#5C6470] mb-1 font-semibold">Road Name</label>
                <input
                  type="text"
                  value={newRoadName}
                  onChange={(e) => setNewRoadName(e.target.value)}
                  placeholder="e.g. 30ft Main Road, Sector Lane"
                  className="w-full px-3 py-2 rounded-xl bg-white border border-[#DCD2BE] focus:border-[#173F35] text-[#172A25] font-bold outline-none"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-[#5C6470] mb-1 font-semibold">Corridor Width</label>
                <select
                  value={newRoadWidthFt}
                  onChange={(e) => setNewRoadWidthFt(Number(e.target.value))}
                  className="w-full px-2.5 py-2 rounded-xl bg-white border border-[#DCD2BE] text-[#172A25] outline-none font-medium"
                >
                  <option value={20}>20 Feet (6.0m) - Sector Lane</option>
                  <option value={30}>30 Feet (9.1m) - Standard Colony Road</option>
                  <option value={40}>40 Feet (12.2m) - Main Avenue</option>
                  <option value={60}>60 Feet (18.3m) - Master Boulevard</option>
                </select>
              </div>

              <div className="p-3 rounded-xl bg-[#F3EFE6] border border-[#DCD2BE] text-[#5C6470] leading-relaxed text-[11px]">
                Backend will automatically buffer this centerline into an exact <b className="text-[#172A25]">{newRoadWidthFt}ft</b> wide asphalt corridor synchronized with 3D canonical view.
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  roadDraftModal.tempLayer?.remove();
                  setRoadDraftModal(null);
                  setGeoTool("inspect");
                }}
                className="flex-1 py-2 rounded-xl bg-[#F3EFE6] hover:bg-[#EDE6D6] text-[#172A25] font-semibold text-xs border border-[#DCD2BE] transition-all"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmCreateRoad}
                disabled={saving || !newRoadName.trim()}
                className="flex-1 py-2 rounded-xl bg-[#173F35] hover:bg-[#0F2922] text-white font-bold text-xs shadow-md transition-all disabled:opacity-50"
              >
                {saving ? "Generating Road..." : "Save Road Corridor"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          DIALOG: CREATE GREEN SPACE DETAILS
         ===================================================================== */}
      {greenDraftModal && (
        <div className="fixed inset-0 z-[10010] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#FAF8F5] border border-[#DCD2BE] shadow-2xl p-5 text-[#172A25] flex flex-col gap-4">
            <div className="flex items-center justify-between pb-2 border-b border-[#DCD2BE]">
              <h3 className="font-bold text-base text-teal-800 flex items-center gap-2">
                <TreePine className="w-4 h-4 text-teal-600" /> Save Green Space / Park
              </h3>
              <button
                type="button"
                onClick={() => {
                  greenDraftModal.tempLayer?.remove();
                  setGreenDraftModal(null);
                  setGeoTool("inspect");
                }}
                className="text-[#5C6470] hover:text-[#172A25]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {error && (
              <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[#5C6470] mb-1 font-semibold">Park / Amenity Name</label>
                <input
                  type="text"
                  value={newGreenName}
                  onChange={(e) => setNewGreenName(e.target.value)}
                  placeholder="e.g. Central Park, Club Garden"
                  className="w-full px-3 py-2 rounded-xl bg-white border border-[#DCD2BE] focus:border-[#173F35] text-[#172A25] font-bold outline-none"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-[#5C6470] mb-1 font-semibold">Amenity Type</label>
                <select
                  value={newGreenType}
                  onChange={(e) => setNewGreenType(e.target.value)}
                  className="w-full px-2.5 py-2 rounded-xl bg-white border border-[#DCD2BE] text-[#172A25] outline-none font-medium"
                >
                  <option value="park">Community Park</option>
                  <option value="garden">Lawn / Flower Garden</option>
                  <option value="playground">Children Playground</option>
                  <option value="clubhouse">Clubhouse Amenity Green</option>
                </select>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  greenDraftModal.tempLayer?.remove();
                  setGreenDraftModal(null);
                  setGeoTool("inspect");
                }}
                className="flex-1 py-2 rounded-xl bg-[#F3EFE6] hover:bg-[#EDE6D6] text-[#172A25] font-semibold text-xs border border-[#DCD2BE] transition-all"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmCreateGreen}
                disabled={saving || !newGreenName.trim()}
                className="flex-1 py-2 rounded-xl bg-[#173F35] hover:bg-[#0F2922] text-white font-bold text-xs shadow-md transition-all disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Park"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          DIALOG: DELETE CONFIRMATION
         ===================================================================== */}
      {deleteConfirmModal && (
        <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#FAF8F5] border border-rose-300 shadow-2xl p-5 text-[#172A25] flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-rose-100 text-rose-600">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-[#172A25]">Confirm Permanent Deletion</h3>
                <p className="text-xs text-[#5C6470] mt-0.5">This action cannot be undone.</p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-white border border-[#DCD2BE] text-xs text-[#172A25]">
              Are you sure you want to delete <b className="text-rose-600">{deleteConfirmModal.name}</b> from the colony masterplan and database?
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmModal(null)}
                className="flex-1 py-2 rounded-xl bg-[#F3EFE6] hover:bg-[#EDE6D6] text-[#172A25] font-semibold text-xs border border-[#DCD2BE] transition-all"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={saving}
                className="flex-1 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-md transition-all disabled:opacity-50"
              >
                {saving ? "Deleting..." : "Yes, Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
