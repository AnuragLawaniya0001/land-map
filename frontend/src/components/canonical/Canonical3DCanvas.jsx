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
  createColonyGroundBaseMesh,
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
  zones = [],
  zonesById = {},
  selectedZone = null,
  onSelectZone = null,
  plotContainmentById = {},
  boundaryValidation = null,
  onImageryLoaded = null,
  onResetView = null,
  hideTopBadges = false,
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
  const compassNeedleRef = useRef(null);

  // 3D Visualization toggles & states
  const [webGLError, setWebGLError] = useState(null);
  const [extrusionHeight, setExtrusionHeight] = useState(1.4);
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const [buildingsEnabled, setBuildingsEnabled] = useState(false); // Default off to preserve surveyed truth
  const [labelsEnabled, setLabelsEnabled] = useState(true);
  const [hoveredEntity, setHoveredEntity] = useState(null);
  const [imageryStatus, setImageryStatus] = useState("loading"); // "loading" | "satellite" | "fallback" | "local"
  const [rejectedPlots, setRejectedPlots] = useState([]);

  const plots = dataset?.plots || [];
  const roads = dataset?.roads || [];
  const greens = dataset?.greens || [];
  const boundary = dataset?.colony_boundary || dataset?.boundary;
  const rawCrsMetadata = dataset?.crs_metadata || null;

  // Memoized sorted and strictly unique list of zones for legend dock
  const zonesList = useMemo(() => {
    let raw = [];
    if (Array.isArray(zones) && zones.length > 0) {
      raw = zones;
    } else if (dataset?.zones && Array.isArray(dataset.zones)) {
      raw = dataset.zones;
    } else if (zonesById && typeof zonesById === "object") {
      raw = Object.values(zonesById);
    }
    const seen = new Set();
    const unique = [];
    for (const z of raw) {
      if (!z) continue;
      const key = z.id || z.code || z.name;
      if (key && !seen.has(key)) {
        seen.add(key);
        unique.push(z);
      }
    }
    return unique.sort((a, b) => String(a.code || a.name || "").localeCompare(String(b.code || b.name || "")));
  }, [zones, dataset?.zones, zonesById]);

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

    // 1. Scene with natural daylight atmospheric horizon & distant haze
    const scene = new THREE.Scene();
    const skyColor = new THREE.Color(0xdce7ee);
    scene.background = skyColor;
    scene.fog = new THREE.Fog(0xdce7ee, span * 4.5, span * 18);
    sceneRef.current = scene;

    // 2. Camera with tuned near plane to eliminate depth buffer precision loss
    const camera = new THREE.PerspectiveCamera(42, width / height, 1.0, span * 15);
    camera.position.set(0, span * 0.95, span * 1.15);
    cameraRef.current = camera;

    // 3. Renderer with logarithmicDepthBuffer to 100% eliminate Z-fighting & flickering
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
        logarithmicDepthBuffer: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
      renderer.setSize(width, height);
      renderer.shadowMap.enabled = false;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
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
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.38; // ~75.6° - natural drone/bird's-eye architectural oblique angle, never dips below world horizon
    controls.minDistance = 5;
    controls.maxDistance = span * 4.5;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // 5. Architectural Lighting Setup (calibrated to match natural satellite aerial photography)
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x475569, 0.75);
    hemiLight.position.set(0, span * 2, 0);
    scene.add(hemiLight);

    // Directional sunlight casting soft daylight
    const sunLight = new THREE.DirectionalLight(0xfffbf2, 0.95);
    sunLight.position.set(span * 0.9, span * 1.8, span * 1.1);
    sunLight.castShadow = false;
    scene.add(sunLight);

    // Soft fill light
    const fillLight = new THREE.DirectionalLight(0xcfd8dc, 0.25);
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

    let lastPointerCheck = 0;
    const handlePointerMove = (e) => {
      const now = performance.now();
      if (now - lastPointerCheck < 35) return;
      lastPointerCheck = now;

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

      // Calculate camera azimuth relative to North and update compass needle directly via DOM (zero React re-renders)
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const heading = Math.atan2(dir.x, -dir.z) * (180 / Math.PI);
      if (compassNeedleRef.current) {
        compassNeedleRef.current.style.transform = `rotate(${-heading}deg)`;
      }

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
          bufferRatio: 1.45, // Exactly 2x the size/length of the original piece (3.9x span vs 1.9x span)
        })
        .then((result) => {
          if (isCancelled || !terrainGroupRef.current) return;
          if (result?.mesh) {
            const currentGroup = terrainGroupRef.current;
            // Retain the vast base terrain underneath; only replace old satellite plane if reloaded
            const prevSatellite = currentGroup.getObjectByName("real-earth-aerial-satellite-plane");
            if (prevSatellite) {
              currentGroup.remove(prevSatellite);
              disposeObjectResources(prevSatellite);
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

    // 1. Colony Boundary Base Ground & Perimeter Wall
    if (layerVisibility.boundary !== false && boundary) {
      try {
        const groundBase = createColonyGroundBaseMesh(boundary, centerX, centerY, crsMetadata);
        if (groundBase) group.add(groundBase);
      } catch (e) {
        console.warn("Colony ground base 3D warning:", e);
      }
      try {
        const wall = createColonyBoundaryWall(boundary, centerX, centerY, crsMetadata);
        if (wall) group.add(wall);
      } catch (e) {
        console.warn("Colony boundary wall 3D warning:", e);
      }
      try {
        const bLine = createBoundary3DLine(boundary, centerX, centerY, crsMetadata);
        if (bLine) group.add(bLine);
      } catch (e) {
        console.warn("Colony boundary 3D line warning:", e);
      }
    }

    // 2. Roads
    if (layerVisibility.roads !== false) {
      for (const road of roads) {
        try {
          const rMesh = createRoad3DMesh(road, centerX, centerY, crsMetadata);
          if (rMesh) group.add(rMesh);
        } catch (e) {
          console.warn("Road 3D mesh warning:", e);
        }
      }
    }

    // 3. Gardens & Open Spaces
    if (layerVisibility.gardens !== false) {
      for (const feature of greens) {
        try {
          const mesh = createLandUse3DMesh(
            feature,
            centerX,
            centerY,
            crsMetadata,
            selectedLandUse?.id === feature.id
          );
          if (mesh) group.add(mesh);
        } catch (e) {
          console.warn("Land use 3D mesh warning:", e);
        }
      }
    }

    // 4. Surveyed Landscaping Trees in verified open spaces
    if (layerVisibility.gardens !== false || layerVisibility.roads !== false) {
      try {
        const trees = createLandscapeTrees(plots, roads, greens, centerX, centerY, crsMetadata);
        if (trees) group.add(trees);
      } catch (e) {
        console.warn("Landscape trees 3D warning:", e);
      }
    }

    // 5. Plots with 3D Depth, Status/Zone Colors, Boundary Containment, and Fault Isolation
    if (layerVisibility.plots !== false) {
      for (let i = 0; i < plots.length; i++) {
        const plot = plots[i];
        try {
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
            const sprite = createPlotNumberSprite(plot, centerX, centerY, crsMetadata, isSelected, { extrusionHeight, showZones, zonesById });
            if (sprite) {
              group.add(sprite);
            }
          }

          // Conceptual architectural villa massing
          if (buildingsEnabled && (plot.has_building || (isSelected && plot.is_concept_building))) {
            const villa = createBuildingMassing(plot, centerX, centerY, crsMetadata, i);
            if (villa) group.add(villa);
          }
        } catch (plotErr) {
          console.warn(`Plot 3D creation error for plot ${plot?.id || i}:`, plotErr);
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
    <div className="relative w-full h-full select-none overflow-hidden bg-[#FAF8F5] font-sans">
      {/* Real-World Environment & Imagery Provenance Badges */}
      {!hideTopBadges && (
        <div className="absolute top-4 left-4 z-10 flex flex-wrap items-center gap-2 pointer-events-auto">
          <div className="flex items-center gap-2 bg-[#FAF8F5]/95 backdrop-blur-md text-[#172A25] border border-[#DCD2BE] text-xs px-3.5 py-2 rounded-xl shadow-md">
            <Sparkles size={14} className="text-[#047857] shrink-0" />
            <span className="font-semibold">
              3D Land-Development Viewer
            </span>
            <span className="text-[#DCD2BE]">·</span>
            <span className="text-[#5C6470] text-[11px]">
              {isGeographic ? "Geographic WGS84 Reference" : "Projected Metric Grid"}
            </span>
          </div>

          {/* Real Aerial Imagery Status Pill */}
          <div className="flex items-center gap-1.5 bg-[#FAF8F5]/95 backdrop-blur-md border border-[#DCD2BE] text-xs px-3 py-2 rounded-xl shadow-md">
            <Globe size={13} className={imageryStatus === "satellite" ? "text-[#0369A1]" : imageryStatus === "loading" ? "text-[#B45309] animate-spin" : "text-[#5C6470]"} />
            <span className="text-[11px] font-semibold text-[#172A25]">
              {imageryStatus === "satellite"
                ? "Real Aerial Imagery · Esri World Imagery"
                : imageryStatus === "loading"
                ? "Fetching Georeferenced Earth Imagery…"
                : imageryStatus === "fallback"
                ? "Neutral Base (Aerial Offline)"
                : "Projected Local Canvas"}
            </span>
          </div>

          {/* Boundary Containment Telemetry Pill */}
          {boundaryValidation && (
            <div
              className={`flex items-center gap-1.5 backdrop-blur-md border text-xs px-3 py-2 rounded-xl shadow-md font-semibold text-[11px] ${
                boundaryValidation.outOfBoundaryPlots > 0
                  ? "bg-[#FEF3C7] border-[#FDE68A] text-[#B45309]"
                  : "bg-[#FAF8F5]/95 border-[#DCD2BE] text-[#047857]"
              }`}
            >
              {boundaryValidation.outOfBoundaryPlots > 0 ? (
                <>
                  <ShieldAlert size={13} className="text-[#B45309] shrink-0" />
                  <span>Boundary Warning: {boundaryValidation.outOfBoundaryPlots} plot{boundaryValidation.outOfBoundaryPlots > 1 ? "s" : ""} exceed constraint</span>
                </>
              ) : (
                <>
                  <span className="w-2 h-2 rounded-full bg-[#047857] shrink-0" />
                  <span>Boundary Verified · 100% Contained</span>
                </>
              )}
            </div>
          )}
          {rejectedPlots.length > 0 && (
            <div
              className="flex items-center gap-1.5 bg-amber-50 backdrop-blur-md border border-amber-300 text-amber-900 text-xs px-3 py-2 rounded-xl shadow-md"
              title={`${rejectedPlots.length} plot(s) have malformed/zero-area source geometry and are isolated for repair: ${rejectedPlots.map((r) => r.plotNumber || r.entityId).join(", ")}`}
            >
              <AlertTriangle size={13} className="text-amber-600 shrink-0" />
              <span className="font-semibold text-amber-800">{rejectedPlots.length}</span>
              <span className="text-[11px] text-amber-700">Geometry Repair Flagged</span>
            </div>
          )}
        </div>
      )}

      {/* Hover Info Tooltip */}
      {hoveredEntity && (
        <div className="absolute bottom-20 left-6 z-20 bg-[#FAF8F5]/95 backdrop-blur-md text-[#172A25] text-xs px-4 py-2.5 rounded-xl border border-[#DCD2BE] shadow-xl pointer-events-none transition-all">
          <div className="font-semibold text-[#172A25] flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#047857]" />
            <span>{hoveredEntity.entityType}: {hoveredEntity.plotNumber || hoveredEntity.id}</span>
          </div>
          <div className="text-[#5C6470] text-[10px] mt-0.5">Click to inspect canonical properties</div>
        </div>
      )}

      {/* Bottom Left: Compass Rose Widget & Zoom Controls */}
      <div className="absolute bottom-6 left-6 z-10 flex flex-col items-center gap-2">
        {/* Compass Widget */}
        <button
          type="button"
          onClick={orientNorth}
          title="Click to Align North"
          className="relative w-12 h-12 rounded-full bg-[#FAF8F5]/95 backdrop-blur-md border border-[#DCD2BE] shadow-xl flex items-center justify-center text-[#172A25] hover:bg-[#EDE6D6] hover:border-[#173F35] transition group"
        >
          <div
            ref={compassNeedleRef}
            className="w-full h-full flex items-center justify-center transition-transform duration-100"
            style={{ transform: "rotate(0deg)" }}
          >
            <div className="w-0.5 h-6 bg-gradient-to-t from-transparent via-[#0369A1] to-[#EF4444] rounded-full" />
            <span className="absolute top-1 text-[8px] font-black tracking-tighter text-[#EF4444]">N</span>
          </div>
        </button>

        {/* Zoom Controls */}
        <div className="flex flex-col bg-[#FAF8F5]/95 backdrop-blur-md border border-[#DCD2BE] rounded-xl overflow-hidden shadow-xl">
          <button
            type="button"
            onClick={zoomIn}
            title="Zoom In"
            className="p-2 text-[#172A25] hover:bg-[#EDE6D6] hover:text-[#173F35] transition border-b border-[#DCD2BE]"
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            onClick={zoomOut}
            title="Zoom Out"
            className="p-2 text-[#172A25] hover:bg-[#EDE6D6] hover:text-[#173F35] transition"
          >
            <Minus size={15} />
          </button>
        </div>
      </div>

      {/* Bottom Center: Unified Floating GIS 3D HUD (Controls & Status Legend) */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2 max-w-[95%] pointer-events-none">
        {/* Status or Zone Legend Pill */}
        {showZones && zonesList.length > 0 ? (
          <div className="pointer-events-auto flex items-center flex-wrap justify-center gap-2 bg-[#FAF8F5]/95 backdrop-blur-xl border border-[#DCD2BE] px-3.5 py-1.5 rounded-full shadow-lg text-[11px] font-semibold text-[#172A25]">
            <span className="text-[10px] font-bold text-[#173F35] uppercase tracking-wider">Zones:</span>
            {zonesList.map((z) => {
              const count = plots.filter((p) => {
                const pz = p.zone_id || p.zone_code || p.zone;
                return pz === z.id || pz === z.code || pz === z.name;
              }).length;
              const isSel = selectedZone === z.id;
              return (
                <button
                  key={z.id}
                  type="button"
                  onClick={() => onSelectZone?.(isSel ? null : z.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full transition-all text-xs ${
                    isSel ? "bg-[#173F35] text-white shadow-sm" : "hover:bg-[#EDE6D6] text-[#172A25]"
                  }`}
                  data-testid={`3d-zone-filter-${z.code || z.id}`}
                >
                  <span className="w-2 h-2 rounded-full" style={{ background: z.color }} />
                  <span>{z.name || `Zone ${z.code}`}</span>
                  <span className={`text-[10px] ml-0.5 font-bold px-1.5 py-0.2 rounded-full ${
                    isSel ? "bg-white/20 text-white" : "bg-[#EDE6D6] text-[#172A25]"
                  }`}>{count}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="pointer-events-auto flex items-center flex-wrap justify-center gap-3 bg-[#FAF8F5]/95 backdrop-blur-xl border border-[#DCD2BE] px-4 py-1.5 rounded-full shadow-lg text-[11px] font-semibold text-[#172A25]">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#FFFFFF] border border-[#DCD2BE]" />
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
              <span className="w-2.5 h-2.5 rounded-full bg-[#38bdf8]" />
              <span>Road</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#10b981]" />
              <span>Garden</span>
            </div>
          </div>
        )}

        {/* Interactive Control Dock */}
        <div className="pointer-events-auto flex items-center flex-wrap justify-center gap-1 bg-[#FAF8F5]/95 backdrop-blur-xl border border-[#DCD2BE] p-1.5 rounded-2xl shadow-lg text-xs font-semibold text-[#172A25]">
          <button
            type="button"
            onClick={fitColonyView}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl hover:bg-[#EDE6D6] hover:text-[#173F35] text-[#172A25] transition"
            title="Orbit & Fit Boundary"
          >
            <Maximize2 size={13} className="text-[#0369A1]" />
            <span>Orbit</span>
          </button>

          <button
            type="button"
            onClick={topView}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl hover:bg-[#EDE6D6] hover:text-[#173F35] text-[#172A25] transition"
            title="Top Architectural View"
          >
            <Compass size={13} className="text-[#047857]" />
            <span>Top View</span>
          </button>

          <div className="w-px h-4 bg-[#DCD2BE] mx-0.5" />

          <button
            type="button"
            onClick={() => setTerrainEnabled((t) => !t)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition ${
              terrainEnabled
                ? "bg-[#173F35] text-white shadow-sm"
                : "hover:bg-[#EDE6D6] text-[#5C6470]"
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
                ? "bg-[#173F35] text-white shadow-sm"
                : "hover:bg-[#EDE6D6] text-[#5C6470]"
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
                ? "bg-[#173F35] text-white shadow-sm"
                : "hover:bg-[#EDE6D6] text-[#5C6470]"
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
                ? "bg-[#173F35] text-white shadow-sm"
                : "hover:bg-[#EDE6D6] text-[#5C6470]"
            }`}
            title="Toggle Plot Number Annotations"
          >
            {labelsEnabled ? <Eye size={13} /> : <EyeOff size={13} />}
            <span>Labels</span>
          </button>

          {(selectedPlot || selectedRoad || selectedLandUse) && (
            <>
              <div className="w-px h-4 bg-[#DCD2BE] mx-0.5" />
              <button
                type="button"
                onClick={focusSelectedPlot}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#0369A1] text-white hover:bg-[#0284c7] transition shadow-sm"
                title="Focus Selected Object"
              >
                <Focus size={13} />
                <span>Focus</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Three.js Canvas Mount */}
      <div ref={mountRef} className="w-full h-full" />
    </div>
  );
}
