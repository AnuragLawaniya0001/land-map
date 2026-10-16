import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  gisTo3DCoord,
  createPlot3DMesh,
  createPlotNumberSprite,
  createRoad3DMesh,
  createLandUse3DMesh,
  createBoundary3DLine,
  createColonyBoundaryWall,
  createBuildingMassing,
  createLandscapeTrees,
  createAerialTerrainMesh,
  createNeutralTerrainMesh,
} from "../../lib/canonical3D.js";
import { ImageryProvider } from "../../lib/imageryProvider.js";
import { computeGeometryBounds } from "../../lib/canonicalGeo.js";
import {
  Maximize2,
  Focus,
  Box,
  Info,
  AlertTriangle,
  Compass,
  Layers,
  Building,
  TreePine,
  Eye,
  EyeOff,
  Plus,
  Minus,
  RotateCcw,
  Sparkles,
  Globe,
  ShieldAlert,
} from "lucide-react";

function disposeObjectResources(root) {
  if (!root) return;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();

  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    if (Array.isArray(object.material)) {
      object.material.forEach((material) => {
        materials.add(material);
        if (material.map) textures.add(material.map);
      });
    } else if (object.material) {
      materials.add(object.material);
      if (object.material.map) textures.add(object.material.map);
    }
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

export default function Canonical3DCanvas({
  dataset,
  selectedPlot,
  selectedRoad,
  selectedLandUse,
  onSelectPlot,
  onSelectRoad,
  onSelectLandUse,
  layerVisibility = {},
  showStatusColors = true,
  showZones = false,
  zonesById = {},
  plotContainmentById = {},
  boundaryValidation = null,
  onImageryLoaded = null,
  onResetView = null,
}) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);
  const meshesGroupRef = useRef(null);
  const terrainGroupRef = useRef(null);
  const entitiesGroupRef = useRef(null);
  const animFrameIdRef = useRef(null);
  const imageryProviderRef = useRef(new ImageryProvider());

  // 3D Visualization toggles & states
  const [webGLError, setWebGLError] = useState(null);
  const [extrusionHeight, setExtrusionHeight] = useState(1.4);
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const [buildingsEnabled, setBuildingsEnabled] = useState(false); // Default off to preserve surveyed truth
  const [labelsEnabled, setLabelsEnabled] = useState(true);
  const [compassHeading, setCompassHeading] = useState(0);
  const [hoveredEntity, setHoveredEntity] = useState(null);
  const [imageryStatus, setImageryStatus] = useState("loading"); // "loading" | "satellite" | "fallback" | "local"
  const [rejectedPlots, setRejectedPlots] = useState([]);

  const plots = dataset?.plots || [];
  const roads = dataset?.roads || [];
  const greens = dataset?.greens || [];
  const boundary = dataset?.colony_boundary || dataset?.boundary;
  const rawCrsMetadata = dataset?.crs_metadata || null;

  // Compute colony center and metric bounds
  const bounds = computeGeometryBounds([
    ...(boundary ? [{ geometry: boundary }] : []),
    ...plots,
    ...roads,
    ...greens,
  ]);
  const [minX, minY, maxX, maxY] = bounds;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  // Dynamically verify if coordinates represent real-world geographic (WGS84) space
  const hasGeographicCoords =
    Number.isFinite(minX) &&
    Number.isFinite(maxX) &&
    Number.isFinite(minY) &&
    Number.isFinite(maxY) &&
    minX >= -180 &&
    maxX <= 180 &&
    minY >= -90 &&
    maxY <= 90 &&
    (Math.abs(centerX) > 0.1 || Math.abs(centerY) > 0.1);

  const isGeographic = Boolean(
    rawCrsMetadata?.crs_type === "geographic_wgs84" ||
    rawCrsMetadata?.units === "deg" ||
    rawCrsMetadata?.is_geographic === true ||
    rawCrsMetadata?.epsg === 4326 ||
    hasGeographicCoords
  );

  const crsMetadata = useMemo(() => {
    if (isGeographic) {
      return {
        ...(rawCrsMetadata || {}),
        crs_type: "geographic_wgs84",
        units: "deg",
        epsg: 4326,
        is_geographic: true,
        georeferencing_status: rawCrsMetadata?.georeferencing_status || "authoritative_kml",
        geographic_verified: true,
      };
    }
    return rawCrsMetadata;
  }, [isGeographic, rawCrsMetadata]);

  const projectedScale = Number(crsMetadata?.scale_ratio);
  const coordinateScale = Number.isFinite(projectedScale) && projectedScale > 0
    ? projectedScale
    : 1;

  const longitudeSpan = isGeographic
    ? (maxX - minX) * 111320 * Math.cos((centerY * Math.PI) / 180)
    : (maxX - minX) * coordinateScale;
  const latitudeSpan = isGeographic ? (maxY - minY) * 110574 : maxY - minY;
  const span = Math.max(
    longitudeSpan,
    isGeographic ? latitudeSpan : latitudeSpan * coordinateScale,
    50
  );

  // Smooth camera transitions helper
  const animateCameraTo = useCallback((targetPos, targetLookAt, duration = 800) => {
    if (!cameraRef.current || !controlsRef.current) return;
    const cam = cameraRef.current;
    const ctrl = controlsRef.current;
    const startPos = cam.position.clone();
    const startTarget = ctrl.target.clone();
    const startTime = performance.now();

    function step(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const ease = 1 - Math.pow(1 - progress, 3);

      cam.position.lerpVectors(startPos, targetPos, ease);
      ctrl.target.lerpVectors(startTarget, targetLookAt, ease);
      ctrl.update();

      if (progress < 1) {
        requestAnimationFrame(step);
      }
    }
    requestAnimationFrame(step);
  }, []);

  // Fit whole colony in camera view (angled architectural 3D view)
  const fitColonyView = useCallback(() => {
    const targetPos = new THREE.Vector3(0, span * 0.95, span * 1.15);
    const targetLookAt = new THREE.Vector3(0, 0, 0);
    animateCameraTo(targetPos, targetLookAt, 700);
  }, [span, animateCameraTo]);

  // Top-down 90° architectural view
  const topView = useCallback(() => {
    const targetPos = new THREE.Vector3(0, span * 1.5, 0.01);
    const targetLookAt = new THREE.Vector3(0, 0, 0);
    animateCameraTo(targetPos, targetLookAt, 700);
  }, [span, animateCameraTo]);

  // Focus selected plot in 3D camera
  const focusSelectedPlot = useCallback(() => {
    const selectedFeature = selectedPlot || selectedRoad || selectedLandUse;
    if (!selectedFeature || !controlsRef.current || !cameraRef.current) return;
    const pBounds = computeGeometryBounds([selectedFeature]);
    const px = (pBounds[0] + pBounds[2]) / 2;
    const py = (pBounds[1] + pBounds[3]) / 2;
    const [targetX, targetZ] = gisTo3DCoord(px, py, centerX, centerY, crsMetadata);
    const [leftX, minZ] = gisTo3DCoord(pBounds[0], pBounds[1], centerX, centerY, crsMetadata);
    const [rightX, maxZ] = gisTo3DCoord(pBounds[2], pBounds[3], centerX, centerY, crsMetadata);
    const featureSpan = Math.max(
      Math.abs(rightX - leftX),
      Math.abs(maxZ - minZ),
      12
    );

    const targetPos = new THREE.Vector3(
      targetX,
      featureSpan * 2.2 + 8,
      targetZ + featureSpan * 2.4 + 10
    );
    const targetLookAt = new THREE.Vector3(targetX, 0, targetZ);
    animateCameraTo(targetPos, targetLookAt, 600);
  }, [selectedPlot, selectedRoad, selectedLandUse, centerX, centerY, crsMetadata, animateCameraTo]);

  // Orient North
  const orientNorth = useCallback(() => {
    if (!cameraRef.current || !controlsRef.current) return;
    const cam = cameraRef.current;
    const ctrl = controlsRef.current;
    const dist = cam.position.distanceTo(ctrl.target);
    const elevationY = cam.position.y - ctrl.target.y;
    const targetPos = new THREE.Vector3(
      ctrl.target.x,
      ctrl.target.y + elevationY,
      ctrl.target.z + Math.sqrt(Math.max(dist * dist - elevationY * elevationY, 1))
    );
    animateCameraTo(targetPos, ctrl.target.clone(), 500);
  }, [animateCameraTo]);

  // Zoom In / Out
  const zoomIn = () => {
    if (!cameraRef.current || !controlsRef.current) return;
    const cam = cameraRef.current;
    const ctrl = controlsRef.current;
    const dir = new THREE.Vector3().subVectors(ctrl.target, cam.position).multiplyScalar(0.25);
    cam.position.add(dir);
    ctrl.update();
  };

  const zoomOut = () => {
    if (!cameraRef.current || !controlsRef.current) return;
    const cam = cameraRef.current;
    const ctrl = controlsRef.current;
    const dir = new THREE.Vector3().subVectors(cam.position, ctrl.target).multiplyScalar(0.25);
    cam.position.add(dir);
    ctrl.update();
  };

  // Initialize Three.js Scene
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    // Check WebGL availability
    try {
      const testCanvas = document.createElement("canvas");
      const gl = testCanvas.getContext("webgl") || testCanvas.getContext("experimental-webgl");
      if (!gl) {
        setWebGLError("WebGL is not supported or disabled in this browser.");
        return;
      }
    } catch (e) {
      setWebGLError("WebGL check failed: " + e.message);
      return;
    }

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    // 1. Scene with atmospheric horizon
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111d);
    scene.fog = new THREE.FogExp2(0x0c111d, 0.0012);
    sceneRef.current = scene;

    // 2. Camera
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.5, span * 15);
    camera.position.set(0, span * 0.95, span * 1.15);
    cameraRef.current = camera;

    // 3. Renderer with realistic soft shadows & tone mapping
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
      container.innerHTML = "";
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;
    } catch (err) {
      setWebGLError("Failed to create WebGL context: " + err.message);
      return;
    }

    // 4. OrbitControls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.maxPolarAngle = Math.PI / 2 - 0.03; // Never dip below ground
    controls.minDistance = 5;
    controls.maxDistance = span * 8;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // 5. Sophisticated Architectural Lighting Setup
    // Warm hemisphere ambient light for natural sky/ground bounce
    const hemiLight = new THREE.HemisphereLight(0xe0f2fe, 0x334155, 0.85);
    hemiLight.position.set(0, span * 2, 0);
    scene.add(hemiLight);

    // Warm directional sunlight casting soft contact shadows
    const sunLight = new THREE.DirectionalLight(0xfffaed, 1.3);
    sunLight.position.set(span * 0.9, span * 1.8, span * 1.1);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = span * 6;
    const shadowD = span * 1.3;
    sunLight.shadow.camera.left = -shadowD;
    sunLight.shadow.camera.right = shadowD;
    sunLight.shadow.camera.top = shadowD;
    sunLight.shadow.camera.bottom = -shadowD;
    sunLight.shadow.bias = -0.0003;
    scene.add(sunLight);

    // Subtle soft fill light from opposite quadrant
    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.35);
    fillLight.position.set(-span * 0.8, span * 1.2, -span * 0.8);
    scene.add(fillLight);

    // Container groups: terrainGroup for aerial/ground, entitiesGroup for interactive elements
    const terrainGroup = new THREE.Group();
    terrainGroup.name = "terrain-container";
    scene.add(terrainGroup);
    terrainGroupRef.current = terrainGroup;

    const entitiesGroup = new THREE.Group();
    entitiesGroup.name = "entities-container";
    scene.add(entitiesGroup);
    entitiesGroupRef.current = entitiesGroup;
    meshesGroupRef.current = entitiesGroup;

    // Raycaster for hit testing
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handlePointerMove = (e) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(entitiesGroup.children, true);
      const hit = intersects.find((i) =>
        ["Plot", "Road", "LandUse"].includes(i.object?.userData?.entityType)
      );

      if (hit) {
        container.style.cursor = "pointer";
        setHoveredEntity(hit.object.userData);
      } else {
        container.style.cursor = "default";
        setHoveredEntity(null);
      }
    };

    const handleClick = (e) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(entitiesGroup.children, true);
      const hit = intersects.find((i) =>
        ["Plot", "Road", "LandUse"].includes(i.object?.userData?.entityType)
      );

      if (hit) {
        if (hit.object.userData.entityType === "Plot" && onSelectPlot) {
          onSelectPlot(hit.object.userData.canonicalPlot);
        } else if (hit.object.userData.entityType === "Road" && onSelectRoad) {
          onSelectRoad(hit.object.userData.canonicalRoad);
        } else if (hit.object.userData.entityType === "LandUse" && onSelectLandUse) {
          onSelectLandUse(hit.object.userData.canonicalLandUse);
        }
      }
    };

    const handleResize = () => {
      if (!container || !renderer || !camera) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    const dom = renderer.domElement;
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(handleResize)
      : null;
    resizeObserver?.observe(container);
    dom.addEventListener("pointermove", handlePointerMove);
    dom.addEventListener("click", handleClick);
    window.addEventListener("resize", handleResize);

    // Animation loop & compass azimuth tracking
    const animate = () => {
      animFrameIdRef.current = requestAnimationFrame(animate);
      controls.update();

      // Calculate camera azimuth relative to North
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const heading = Math.atan2(dir.x, -dir.z) * (180 / Math.PI);
      setCompassHeading(Math.round(heading));

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      if (animFrameIdRef.current) cancelAnimationFrame(animFrameIdRef.current);
      dom.removeEventListener("pointermove", handlePointerMove);
      dom.removeEventListener("click", handleClick);
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
      controls.dispose();
      disposeObjectResources(scene);
      terrainGroupRef.current = null;
      entitiesGroupRef.current = null;
      meshesGroupRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
      renderer.dispose();
      if (container.contains(dom)) container.removeChild(dom);
    };
  }, [span]);

  // Focus selected plot when selection changes
  useEffect(() => {
    if (selectedPlot || selectedRoad || selectedLandUse) {
      focusSelectedPlot();
    }
  }, [selectedPlot?.id, selectedRoad?.id, selectedLandUse?.id, focusSelectedPlot]);

  // 1. Dedicated Aerial Satellite Imagery / Neutral Terrain Plane
  // Only re-runs when geographic extent or terrain settings change, NOT on plot clicks or style changes
  useEffect(() => {
    const tGroup = terrainGroupRef.current;
    if (!tGroup) return;

    disposeObjectResources(tGroup);
    tGroup.clear();

    if (layerVisibility.terrain === false) {
      setImageryStatus("fallback");
      return;
    }

    let isCancelled = false;

    if (isGeographic && Number.isFinite(minX) && Number.isFinite(maxX)) {
      const initialNeutralBase = createNeutralTerrainMesh({
        cx: centerX,
        cy: centerY,
        span,
        terrainEnabled,
      });
      if (initialNeutralBase) tGroup.add(initialNeutralBase);

      setImageryStatus("loading");
      imageryProviderRef.current
        .loadGeoreferencedAerialMesh({
          minLng: minX,
          minLat: minY,
          maxLng: maxX,
          maxLat: maxY,
          cx: centerX,
          cy: centerY,
          crsMetadata,
          bufferRatio: 0.45,
        })
        .then((result) => {
          if (isCancelled || !terrainGroupRef.current) return;
          if (result?.mesh) {
            const currentGroup = terrainGroupRef.current;
            const prev =
              currentGroup.getObjectByName("real-earth-aerial-satellite-plane") ||
              currentGroup.getObjectByName("aerial-terrain-base");
            if (prev) {
              currentGroup.remove(prev);
              disposeObjectResources(prev);
            }
            currentGroup.add(result.mesh);
            setImageryStatus("satellite");
            if (onImageryLoaded) {
              onImageryLoaded({
                provider: result.provider,
                attribution: result.attribution,
                zoom: result.zoom,
                tilesCount: result.tilesCount,
              });
            }
          }
        })
        .catch((err) => {
          if (isCancelled) return;
          console.warn("Real aerial satellite imagery fetch failed, displaying neutral ground base:", err);
          setImageryStatus("fallback");
        });
    } else {
      setImageryStatus("local");
      const terrainMesh = createNeutralTerrainMesh({
        cx: centerX,
        cy: centerY,
        span,
        terrainEnabled,
      });
      if (terrainMesh) tGroup.add(terrainMesh);
    }

    return () => {
      isCancelled = true;
      imageryProviderRef.current?.cancel();
    };
  }, [
    layerVisibility.terrain,
    terrainEnabled,
    isGeographic,
    minX,
    maxX,
    minY,
    maxY,
    centerX,
    centerY,
    span,
    crsMetadata,
    onImageryLoaded,
  ]);

  // 2. Rebuild 3D Meshes when plots, selection, or layer visibility changes
  useEffect(() => {
    const group = entitiesGroupRef.current;
    if (!group) return;

    // Clear existing meshes
    disposeObjectResources(group);
    group.clear();
    setRejectedPlots([]);

    // 1. Colony Boundary Wall
    if (layerVisibility.boundary !== false && boundary) {
      const wall = createColonyBoundaryWall(boundary, centerX, centerY, crsMetadata);
      if (wall) group.add(wall);
      const bLine = createBoundary3DLine(boundary, centerX, centerY, crsMetadata);
      if (bLine) group.add(bLine);
    }

    // 2. Roads
    if (layerVisibility.roads !== false) {
      for (const road of roads) {
        const rMesh = createRoad3DMesh(road, centerX, centerY, crsMetadata);
        if (rMesh) group.add(rMesh);
      }
    }

    // 3. Gardens & Open Spaces
    if (layerVisibility.gardens !== false) {
      for (const feature of greens) {
        const mesh = createLandUse3DMesh(
          feature,
          centerX,
          centerY,
          crsMetadata,
          selectedLandUse?.id === feature.id
        );
        if (mesh) group.add(mesh);
      }
    }

    // 4. Surveyed Landscaping Trees in verified open spaces
    if (layerVisibility.gardens !== false || layerVisibility.roads !== false) {
      const trees = createLandscapeTrees(plots, roads, greens, centerX, centerY, crsMetadata);
      if (trees) group.add(trees);
    }

    // 5. Plots with 3D Depth, Status/Zone Colors, Boundary Containment, and Fault Isolation
    if (layerVisibility.plots !== false) {
      for (let i = 0; i < plots.length; i++) {
        const plot = plots[i];
        const isSelected = selectedPlot?.id === plot.id;
        const containment = plotContainmentById[plot.id]?.status || "contained";

        const plotOptions = {
          showStatusColors,
          showZones,
          zonesById,
          containmentStatus: containment,
          onGeometryRejected: (details) => {
            setRejectedPlots((prev) => [...prev, details]);
          },
        };

        const pMesh = createPlot3DMesh(
          plot,
          centerX,
          centerY,
          extrusionHeight,
          isSelected,
          crsMetadata,
          plotOptions
        );
        if (pMesh) group.add(pMesh);

        // Plot number sprite labels
        if (labelsEnabled && layerVisibility.plotLabels !== false) {
          const sprite = createPlotNumberSprite(plot, centerX, centerY, crsMetadata, isSelected, { extrusionHeight });
          if (sprite) {
            group.add(sprite);
          }
        }

        // Conceptual architectural villa massing
        if (buildingsEnabled && (plot.has_building || (isSelected && plot.is_concept_building))) {
          const villa = createBuildingMassing(plot, centerX, centerY, crsMetadata, i);
          if (villa) group.add(villa);
        }
      }
    }
  }, [
    plots,
    roads,
    greens,
    boundary,
    plotContainmentById,
    selectedPlot?.id,
    selectedRoad?.id,
    selectedLandUse?.id,
    extrusionHeight,
    buildingsEnabled,
    labelsEnabled,
    showStatusColors,
    showZones,
    zonesById,
    layerVisibility.plots,
    layerVisibility.roads,
    layerVisibility.gardens,
    layerVisibility.boundary,
    layerVisibility.plotLabels,
    centerX,
    centerY,
    crsMetadata,
  ]);

  if (webGLError) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-slate-900 text-slate-200 p-8 text-center select-none">
        <AlertTriangle className="text-amber-400 mb-3" size={44} />
        <h3 className="text-lg font-semibold text-white mb-2">3D Viewport Hardware Acceleration Unavailable</h3>
        <p className="text-sm max-w-md text-slate-400 mb-5">{webGLError}</p>
        <span className="text-xs text-slate-500 bg-slate-800/80 px-4 py-2 rounded-lg border border-slate-700">
          The 2D vector map view remains active and fully functional.
        </span>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full select-none overflow-hidden bg-slate-950 font-sans">
      {/* Real-World Environment & Imagery Provenance Badges */}
      <div className="absolute top-4 left-4 z-10 flex flex-wrap items-center gap-2 pointer-events-auto">
        <div className="flex items-center gap-2 bg-slate-900/90 backdrop-blur-md text-slate-300 border border-slate-700/80 text-xs px-3.5 py-2 rounded-xl shadow-xl">
          <Sparkles size={14} className="text-emerald-400 shrink-0" />
          <span className="font-medium">
            3D Land-Development Viewer
          </span>
          <span className="text-slate-500">·</span>
          <span className="text-slate-400 text-[11px]">
            {isGeographic ? "Geographic WGS84 Reference" : "Projected Metric Grid"}
          </span>
        </div>

        {/* Real Aerial Imagery Status Pill */}
        <div className="flex items-center gap-1.5 bg-slate-900/90 backdrop-blur-md border border-slate-700/80 text-xs px-3 py-2 rounded-xl shadow-xl">
          <Globe size={13} className={imageryStatus === "satellite" ? "text-cyan-400" : imageryStatus === "loading" ? "text-amber-400 animate-spin" : "text-slate-400"} />
          <span className="text-[11px] font-medium text-slate-300">
            {imageryStatus === "satellite"
              ? "Real Aerial Imagery · Esri World Imagery"
              : imageryStatus === "loading"
              ? "Fetching Georeferenced Earth Imagery…"
              : imageryStatus === "fallback"
              ? "Neutral Slate Base (Aerial Offline)"
              : "Projected Local Canvas"}
          </span>
        </div>

        {/* Boundary Containment Telemetry Pill */}
        {boundaryValidation && (
          <div
            className={`flex items-center gap-1.5 backdrop-blur-md border text-xs px-3 py-2 rounded-xl shadow-xl font-medium text-[11px] ${
              boundaryValidation.outOfBoundaryPlots > 0
                ? "bg-amber-950/70 border-amber-600/60 text-amber-300"
                : "bg-slate-900/90 border-slate-700/80 text-emerald-400"
            }`}
          >
            {boundaryValidation.outOfBoundaryPlots > 0 ? (
              <>
                <ShieldAlert size={13} className="text-amber-400 shrink-0" />
                <span>Boundary Warning: {boundaryValidation.outOfBoundaryPlots} plot{boundaryValidation.outOfBoundaryPlots > 1 ? "s" : ""} exceed constraint</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                <span>Boundary Verified · 100% Contained</span>
              </>
            )}
          </div>
        )}
        {rejectedPlots.length > 0 && (
          <div
            className="flex items-center gap-1.5 bg-amber-950/80 backdrop-blur-md border border-amber-600/60 text-amber-200 text-xs px-3 py-2 rounded-xl shadow-xl"
            title={`${rejectedPlots.length} plot(s) have malformed/zero-area source geometry and are isolated for repair: ${rejectedPlots.map((r) => r.plotNumber || r.entityId).join(", ")}`}
          >
            <AlertTriangle size={13} className="text-amber-400 shrink-0" />
            <span className="font-semibold text-amber-300">{rejectedPlots.length}</span>
            <span className="text-[11px] text-amber-200">Geometry Repair Flagged</span>
          </div>
        )}
      </div>

      {/* Hover Info Tooltip */}
      {hoveredEntity && (
        <div className="absolute bottom-20 left-6 z-20 bg-slate-900/95 backdrop-blur-md text-white text-xs px-4 py-2.5 rounded-xl border border-slate-700 shadow-2xl pointer-events-none transition-all">
          <div className="font-semibold text-slate-200 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>{hoveredEntity.entityType}: {hoveredEntity.plotNumber || hoveredEntity.id}</span>
          </div>
          <div className="text-slate-400 text-[10px] mt-0.5">Click to inspect canonical properties</div>
        </div>
      )}

      {/* Bottom Left: Compass Rose Widget & Zoom Controls */}
      <div className="absolute bottom-6 left-6 z-10 flex flex-col items-center gap-2">
        {/* Compass Widget */}
        <button
          type="button"
          onClick={orientNorth}
          title={`Heading: ${compassHeading}° — Click to Align North`}
          className="relative w-12 h-12 rounded-full bg-slate-900/90 backdrop-blur-md border border-slate-700/80 shadow-2xl flex items-center justify-center text-slate-300 hover:text-white hover:border-slate-500 transition group"
        >
          <div
            className="w-full h-full flex items-center justify-center transition-transform duration-150"
            style={{ transform: `rotate(${-compassHeading}deg)` }}
          >
            <div className="w-0.5 h-6 bg-gradient-to-t from-transparent via-blue-400 to-rose-500 rounded-full" />
            <span className="absolute top-1 text-[8px] font-black tracking-tighter text-rose-400">N</span>
          </div>
        </button>

        {/* Zoom Controls */}
        <div className="flex flex-col bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-xl overflow-hidden shadow-xl">
          <button
            type="button"
            onClick={zoomIn}
            title="Zoom In"
            className="p-2 text-slate-300 hover:text-white hover:bg-slate-800 transition border-b border-slate-800"
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            onClick={zoomOut}
            title="Zoom Out"
            className="p-2 text-slate-300 hover:text-white hover:bg-slate-800 transition"
          >
            <Minus size={15} />
          </button>
        </div>
      </div>

      {/* Bottom Center: Floating Interactive Control Dock */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 bg-slate-900/90 backdrop-blur-xl border border-slate-700/80 p-1.5 rounded-2xl shadow-2xl text-xs font-medium text-slate-300">
        <button
          type="button"
          onClick={fitColonyView}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl hover:bg-slate-800 hover:text-white transition"
          title="Orbit & Fit Boundary"
        >
          <Maximize2 size={13} className="text-blue-400" />
          <span>Orbit</span>
        </button>

        <button
          type="button"
          onClick={topView}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl hover:bg-slate-800 hover:text-white transition"
          title="Top Architectural View"
        >
          <Compass size={13} className="text-cyan-400" />
          <span>Top View</span>
        </button>

        <div className="w-px h-4 bg-slate-800 mx-0.5" />

        <button
          type="button"
          onClick={() => setTerrainEnabled((t) => !t)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition ${
            terrainEnabled
              ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
              : "hover:bg-slate-800 text-slate-400"
          }`}
          title="Toggle Terrain & Aerial Environment"
        >
          <Layers size={13} />
          <span>Terrain</span>
        </button>

        <button
          type="button"
          onClick={() => setExtrusionHeight((h) => (h > 0.4 ? 0.08 : 1.4))}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition ${
            extrusionHeight > 0.4
              ? "bg-blue-500/15 text-blue-300 border border-blue-500/30"
              : "hover:bg-slate-800 text-slate-400"
          }`}
          title={extrusionHeight > 0.4 ? "Switch to Flat Land Parcels" : "Switch to 3D Extruded Parcels"}
        >
          <Box size={13} />
          <span>Plot Extrusions</span>
        </button>

        <button
          type="button"
          onClick={() => setBuildingsEnabled((b) => !b)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition ${
            buildingsEnabled
              ? "bg-indigo-500/15 text-indigo-300 border border-indigo-500/30"
              : "hover:bg-slate-800 text-slate-400"
          }`}
          title="Toggle 3D Architectural Villa Massing"
        >
          <Building size={13} />
          <span>Buildings</span>
        </button>

        <button
          type="button"
          onClick={() => setLabelsEnabled((l) => !l)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition ${
            labelsEnabled
              ? "bg-amber-500/15 text-amber-300 border border-amber-500/30"
              : "hover:bg-slate-800 text-slate-400"
          }`}
          title="Toggle Plot Number Annotations"
        >
          {labelsEnabled ? <Eye size={13} /> : <EyeOff size={13} />}
          <span>Labels</span>
        </button>

        {(selectedPlot || selectedRoad || selectedLandUse) && (
          <>
            <div className="w-px h-4 bg-slate-800 mx-0.5" />
            <button
              type="button"
              onClick={focusSelectedPlot}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-500/30 transition"
              title="Focus Selected Object"
            >
              <Focus size={13} />
              <span>Focus</span>
            </button>
          </>
        )}
      </div>

      {/* Bottom Right: Status Legend Pill */}
      <div className="absolute bottom-6 right-6 z-10 flex items-center gap-3.5 bg-slate-900/90 backdrop-blur-xl border border-slate-700/80 px-4 py-2 rounded-2xl shadow-2xl text-[11px] font-medium text-slate-300">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#f5f3ea] border border-slate-400" />
          <span>Available</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#f59e0b]" />
          <span>Hold</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#8b5cf6]" />
          <span>Reserved</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#ef4444]" />
          <span>Sold</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#f59e0b] border border-red-500" />
          <span>Boundary Alert</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#242832] border border-slate-600" />
          <span>Road</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#487532]" />
          <span>Garden</span>
        </div>
      </div>

      {/* Three.js Canvas Mount */}
      <div ref={mountRef} className="w-full h-full" />
    </div>
  );
}
