/**
 * Production-Ready Interactive 2D Colony Vector Map Canvas.
 *
 * Renders pure SVG vector geometry directly from canonical colony datasets.
 * Features:
 * - Architectural Masterplan Styling matching "Bungalow & Amenity Plot Layout Plan"
 * - Realistic asphalt roads with concrete walkway curbs & white dashed centerlines
 * - Parked car silhouettes & tree canopy symbols along corridors
 * - Luxury warm ivory bungalow plots with always-visible plot numbers
 * - Rich green landscaped amenity gardens with gazebo, fountain, and tree clusters
 * - High-contrast plot selection and boundary rendering
 * - Fluid pan and pointer-anchored zoom
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  computeGeometryBounds,
  geoJsonToSvgPath,
  getGeometryLabelPoint,
  CANONICAL_THEME,
} from "@/lib/canonicalGeo";

export default function CanonicalMapCanvas({
  boundary,
  plots = [],
  roads = [],
  greens = [],
  dimensions = [],
  qaFindings = [],
  selectedPlot = null,
  selectedRoad = null,
  selectedLandUse = null,
  onSelectPlot = () => {},
  onSelectRoad = () => {},
  onSelectLandUse = () => {},
  visibleLayers = {
    boundary: true,
    plots: true,
    roads: true,
    gardens: true,
    plotLabels: true,
    roadLabels: true,
    landUseLabels: true,
    dimensions: false,
    qaOverlay: true,
    sourceArtwork: false,
  },
  crsMetadata = null,
  sourceArtwork = null,
  fitTrigger = 0,
  fitPlotTrigger = null,
  zoomTrigger = 0,
  zoomDirection = "in",
}) {
  const containerRef = useRef(null);
  const pointerStateRef = useRef({ pointerId: null, x: 0, y: 0, moved: false });
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, width: 1000, height: 1000 });
  const [isPanning, setIsPanning] = useState(false);
  const [mouseCoords, setMouseCoords] = useState(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [hoveredPlotId, setHoveredPlotId] = useState(null);

  // Compute canonical dataset bounding box across all features
  const datasetBounds = useMemo(() => {
    const plotGeoms = plots.map((p) => p.geometry).filter(Boolean);
    const plotBounds = plotGeoms.length ? computeGeometryBounds(plotGeoms) : null;
    const boundaryBounds = boundary ? computeGeometryBounds(boundary) : null;

    if (boundaryBounds && plotBounds) {
      const minX = Math.min(boundaryBounds[0], plotBounds[0]);
      const minY = Math.min(boundaryBounds[1], plotBounds[1]);
      const maxX = Math.max(boundaryBounds[2], plotBounds[2]);
      const maxY = Math.max(boundaryBounds[3], plotBounds[3]);
      const padX = (maxX - minX) * 0.06;
      const padY = (maxY - minY) * 0.06;
      return [minX - padX, minY - padY, maxX + padX, maxY + padY];
    }
    if (plotBounds) {
      const padX = (plotBounds[2] - plotBounds[0]) * 0.06;
      const padY = (plotBounds[3] - plotBounds[1]) * 0.06;
      return [plotBounds[0] - padX, plotBounds[1] - padY, plotBounds[2] + padX, plotBounds[3] + padY];
    }
    if (boundaryBounds) return boundaryBounds;
    return [0, 0, 1000, 1000];
  }, [plots, boundary]);

  // Coordinate helpers to properly map GIS coordinates (Y-up) to SVG space (Y-down)
  const toSvgPath = (geom) => geoJsonToSvgPath(geom, true, datasetBounds);
  const toPoint = (pt) => {
    if (!pt || !datasetBounds) return pt || [0, 0];
    return [pt[0], datasetBounds[1] + (datasetBounds[3] - pt[1])];
  };
  const toLabelPoint = (geom) => toPoint(getGeometryLabelPoint(geom));

  // Render plots with smaller plots ON TOP so outer blocks don't hide plots
  const renderPlots = useMemo(() => {
    return plots.slice().sort((a, b) => (b.area_sqm || 0) - (a.area_sqm || 0));
  }, [plots]);

  const minZoomDimension = useMemo(() => {
    const w = datasetBounds[2] - datasetBounds[0];
    const h = datasetBounds[3] - datasetBounds[1];
    return Math.max(Math.min(w, h) * 0.05, 1);
  }, [datasetBounds]);

  // Fit all features to viewport
  useEffect(() => {
    const width = datasetBounds[2] - datasetBounds[0];
    const height = datasetBounds[3] - datasetBounds[1];
    setViewBox({
      x: datasetBounds[0],
      y: datasetBounds[1],
      width: width > 0 ? width : 1000,
      height: height > 0 ? height : 1000,
    });
    setZoomLevel(1);
  }, [datasetBounds, fitTrigger]);

  // Focus view on selected plot when prompted
  useEffect(() => {
    if (!selectedPlot?.geometry) return;
    const bounds = computeGeometryBounds(selectedPlot.geometry);
    if (!bounds) return;
    const [minX, minY, maxX, maxY] = bounds;
    const pad = Math.max((maxX - minX) * 0.6, (maxY - minY) * 0.6, 20);
    setViewBox({
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    });
    setZoomLevel(3);
  }, [selectedPlot?.id, fitPlotTrigger]); // eslint-disable-line

  // Mouse wheel zoom with pointer anchor
  const handleWheel = (e) => {
    e.preventDefault();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height || !Number.isFinite(e.deltaY)) return;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const svgX = viewBox.x + (mouseX / rect.width) * viewBox.width;
    const svgY = viewBox.y + (mouseY / rect.height) * viewBox.height;

    const zoomFactor = e.deltaY < 0 ? 0.85 : 1.18;
    const newWidth = Math.max(viewBox.width * zoomFactor, minZoomDimension);
    const newHeight = Math.max(viewBox.height * zoomFactor, minZoomDimension);

    const newX = svgX - (mouseX / rect.width) * newWidth;
    const newY = svgY - (mouseY / rect.height) * newHeight;

    setViewBox({ x: newX, y: newY, width: newWidth, height: newHeight });
    setZoomLevel((prev) => (e.deltaY < 0 ? prev * 1.15 : prev / 1.15));
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const listener = (event) => handleWheel(event);
    container.addEventListener("wheel", listener, { passive: false });
    return () => container.removeEventListener("wheel", listener);
  }, [viewBox]);

  const handlePointerMove = (e) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const svgX = viewBox.x + ((e.clientX - rect.left) / rect.width) * viewBox.width;
    const svgY = viewBox.y + ((e.clientY - rect.top) / rect.height) * viewBox.height;
    setMouseCoords({ x: Number(svgX.toFixed(2)), y: Number(svgY.toFixed(2)) });

    const pointerState = pointerStateRef.current;
    if (!isPanning || pointerState.pointerId !== e.pointerId) return;
    const dx = e.clientX - pointerState.x;
    const dy = e.clientY - pointerState.y;
    if (Math.hypot(dx, dy) > 3) pointerState.moved = true;
    const scaleX = viewBox.width / rect.width;
    const scaleY = viewBox.height / rect.height;

    setViewBox((prev) => ({
      ...prev,
      x: prev.x - dx * scaleX,
      y: prev.y - dy * scaleY,
    }));
    pointerState.x = e.clientX;
    pointerState.y = e.clientY;
  };

  const handlePointerUp = (e) => {
    const pointerState = pointerStateRef.current;
    if (pointerState.pointerId !== e.pointerId) return;
    setIsPanning(false);
    pointerState.pointerId = null;
    if (containerRef.current?.hasPointerCapture(e.pointerId)) {
      containerRef.current.releasePointerCapture(e.pointerId);
    }
  };

  // Pre-calculate QA issue plot mapping
  const qaPlotIssueCount = useMemo(() => {
    const counts = {};
    if (!qaFindings?.length) return counts;
    for (const f of qaFindings) {
      for (const eid of f.entity_ids || []) {
        counts[eid] = (counts[eid] || 0) + 1;
      }
    }
    return counts;
  }, [qaFindings]);

  // Scale labels with map zoom
  const baseFontSize = useMemo(() => {
    return Math.max(viewBox.width * 0.015, 6);
  }, [viewBox.width]);

  // Compute decorative tree locations along plot frontages & walkways
  const decorativeTrees = useMemo(() => {
    const trees = [];
    const step = Math.max(viewBox.width * 0.05, 12);
    renderPlots.slice(0, 36).forEach((plot, i) => {
      const pt = toLabelPoint(plot.geometry);
      // Place tree near plot outer frontage
      if (i % 2 === 0) {
        trees.push({ id: `tree-${plot.id}-1`, x: pt[0] + 12, y: pt[1] - 12 });
      } else {
        trees.push({ id: `tree-${plot.id}-2`, x: pt[0] - 12, y: pt[1] + 12 });
      }
    });
    return trees;
  }, [renderPlots, viewBox.width]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full overflow-hidden select-none border border-slate-700/60 rounded-xl shadow-2xl ${
        isPanning ? "cursor-grabbing" : "cursor-grab"
      }`}
      style={{ touchAction: "none", background: "#1b1e24" }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        pointerStateRef.current = {
          pointerId: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          moved: false,
        };
        setIsPanning(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={() => setMouseCoords(null)}
    >
      <svg
        className="w-full h-full"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ background: "#1c2026" }}
        onClick={(e) => {
          if (e.target.tagName === "svg" && !pointerStateRef.current.moved) {
            onSelectPlot(null);
            onSelectRoad(null);
          }
        }}
      >
        <defs>
          {/* Subtle architectural plan grid */}
          <pattern id="planGrid" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 60 0 L 0 0 0 60" fill="none" stroke="rgba(255, 255, 255, 0.03)" strokeWidth="0.8" />
          </pattern>

          {/* Grass Lawn Pattern for gardens and amenity spaces */}
          <pattern id="lawnGrass" width="20" height="20" patternUnits="userSpaceOnUse">
            <rect width="20" height="20" fill="#588937" />
            <circle cx="5" cy="5" r="1.5" fill="#699e42" opacity="0.7" />
            <circle cx="15" cy="15" r="1.8" fill="#4d782f" opacity="0.6" />
            <circle cx="15" cy="5" r="1.2" fill="#72a849" opacity="0.5" />
          </pattern>

          {/* Luxury Paved Walkway Texture */}
          <pattern id="walkwayPaving" width="16" height="16" patternUnits="userSpaceOnUse">
            <rect width="16" height="16" fill="#ded7ca" />
            <path d="M 0 8 L 16 8 M 8 0 L 8 16" stroke="#c8bfb0" strokeWidth="0.8" />
          </pattern>

          {/* Tree Canopy Symbol */}
          <g id="treeSymbol">
            <circle cx="0" cy="0" r="10" fill="#2d4a1e" opacity="0.3" transform="translate(1.2, 1.2)" />
            <circle cx="0" cy="0" r="9" fill="#4c7a31" stroke="#2c471c" strokeWidth="1.2" />
            <circle cx="0" cy="0" r="6" fill="#5e943c" />
            <circle cx="-2" cy="-2" r="2.5" fill="#75b34d" opacity="0.85" />
          </g>

          {/* Palm Tree Symbol */}
          <g id="palmSymbol">
            <circle cx="0" cy="0" r="8" fill="#2d4a1e" opacity="0.25" transform="translate(1, 1)" />
            <circle cx="0" cy="0" r="3" fill="#634526" />
            <path
              d="M 0 0 L -8 -4 M 0 0 L -6 -8 M 0 0 L 0 -10 M 0 0 L 6 -8 M 0 0 L 8 -4 M 0 0 L 8 4 M 0 0 L 6 8 M 0 0 L 0 10 M 0 0 L -6 8 M 0 0 L -8 4"
              stroke="#43702a"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </g>

          {/* Top-Down Architectural Car Silhouettes */}
          <g id="carRed">
            <rect x="-4.5" y="-9" width="9" height="18" rx="2.5" fill="#dc2626" stroke="#991b1b" strokeWidth="0.8" />
            <rect x="-3" y="-5" width="6" height="7" rx="1" fill="#fca5a5" opacity="0.8" />
            <rect x="-3.5" y="-3.5" width="7" height="4.5" rx="0.8" fill="#b91c1c" />
          </g>
          <g id="carBlue">
            <rect x="-4.5" y="-9" width="9" height="18" rx="2.5" fill="#2563eb" stroke="#1e3a8a" strokeWidth="0.8" />
            <rect x="-3" y="-5" width="6" height="7" rx="1" fill="#93c5fd" opacity="0.8" />
            <rect x="-3.5" y="-3.5" width="7" height="4.5" rx="0.8" fill="#1d4ed8" />
          </g>

          {/* Water Fountain Symbol */}
          <g id="fountainSymbol">
            <circle cx="0" cy="0" r="14" fill="#cbd5e1" stroke="#475569" strokeWidth="2" />
            <circle cx="0" cy="0" r="11" fill="#0284c7" stroke="#38bdf8" strokeWidth="1.5" />
            <circle cx="0" cy="0" r="6.5" fill="#38bdf8" stroke="#ffffff" strokeWidth="1" />
            <circle cx="0" cy="0" r="2.5" fill="#ffffff" />
          </g>

          {/* Main Entrance Symbol */}
          <g id="mainEntranceSymbol">
            <path d="M 0 14 L -6 4 L -2 4 L -2 -8 L 2 -8 L 2 4 L 6 4 Z" fill="#dc2626" stroke="#991b1b" strokeWidth="1" />
            <rect x="-42" y="-28" width="84" height="18" rx="4" fill="#dc2626" stroke="#ffffff" strokeWidth="1" />
            <text x="0" y="-18" fill="#ffffff" fontSize="9" fontWeight="800" textAnchor="middle" dominantBaseline="central" letterSpacing="0.08em" fontFamily="Inter, sans-serif">MAIN ENTRANCE</text>
          </g>
        </defs>

        {/* Plan Base Background */}
        <rect
          x={viewBox.x}
          y={viewBox.y}
          width={viewBox.width}
          height={viewBox.height}
          fill="#1c2026"
          pointerEvents="none"
        />
        <rect
          x={viewBox.x}
          y={viewBox.y}
          width={viewBox.width}
          height={viewBox.height}
          fill="url(#planGrid)"
          pointerEvents="none"
        />

        {/* 1. LAYER: Colony Land Boundary */}
        {visibleLayers.boundary !== false &&
          boundary &&
          (() => {
            const pathD = toSvgPath(boundary);
            if (!pathD) return null;
            return (
              <path
                d={pathD}
                fill="none"
                stroke="#ffffff"
                strokeWidth={3 * (viewBox.width / 1000)}
                strokeDasharray="none"
                opacity={0.95}
              />
            );
          })()}

        {/* 2. LAYER: Roads with Asphalt, Walkway Curbs & Centerlines */}
        {visibleLayers.roads &&
          roads.map((road, idx) => {
            const isSelected = selectedRoad?.id === road.id;
            const pathD = toSvgPath(road.geometry);
            if (!pathD) return null;
            const roadLblPt = toLabelPoint(road.geometry);
            const cleanRoadMatch = (road.source_label || road.name || "25' WIDE ROAD")
              .match(/(\d+(?:[.'’]\d+)?\s*(?:'|FT|MT|M|FEET)?(?:-\d+")?)/i);
            const labelText = cleanRoadMatch ? `${cleanRoadMatch[1].trim()} WIDE ROAD` : "25' WIDE ROAD";

            return (
              <g key={road.id || `road-${idx}`}>
                {/* 3' Walkway Outer Buffer / Curb */}
                <path
                  d={pathD}
                  fill="none"
                  stroke="#ded7cb"
                  strokeWidth={6 * (viewBox.width / 1000)}
                  strokeLinejoin="round"
                />

                {/* Asphalt Road Body */}
                <path
                  d={pathD}
                  fill={isSelected ? "#4b5160" : "#323640"}
                  stroke="#1c1e24"
                  strokeWidth={1.5 * (viewBox.width / 1000)}
                  fillRule="evenodd"
                  className="cursor-pointer transition-colors hover:fill-slate-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (pointerStateRef.current.moved) return;
                    onSelectRoad(road);
                  }}
                />

                {/* Road White Dashed Centerline */}
                <path
                  d={pathD}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth={1.4 * (viewBox.width / 1000)}
                  strokeDasharray="10 8"
                  opacity={0.8}
                  pointerEvents="none"
                />

                {/* Clean Road Label */}
                {visibleLayers.roadLabels !== false && (
                  <g pointerEvents="none">
                    <rect
                      x={roadLblPt[0] - (labelText.length * baseFontSize * 0.35 + 8)}
                      y={roadLblPt[1] - baseFontSize * 0.8}
                      width={labelText.length * baseFontSize * 0.7 + 16}
                      height={baseFontSize * 1.6}
                      rx="4"
                      fill="rgba(24, 27, 34, 0.88)"
                      stroke="rgba(255, 255, 255, 0.2)"
                      strokeWidth="0.8"
                    />
                    <text
                      x={roadLblPt[0]}
                      y={roadLblPt[1]}
                      fontSize={baseFontSize * 0.95}
                      fill="#f8fafc"
                      fontWeight="700"
                      textAnchor="middle"
                      dominantBaseline="central"
                      letterSpacing="0.08em"
                      className="uppercase select-none font-sans"
                    >
                      {labelText}
                    </text>
                  </g>
                )}

                {/* Parked Car Silhouettes along road corridors */}
                {idx === 0 && (
                  <>
                    <use
                      href="#carRed"
                      x={roadLblPt[0] - 35}
                      y={roadLblPt[1] + 15}
                      transform={`scale(${viewBox.width / 1000})`}
                    />
                    <use
                      href="#carBlue"
                      x={roadLblPt[0] + 35}
                      y={roadLblPt[1] - 15}
                      transform={`scale(${viewBox.width / 1000})`}
                    />
                  </>
                )}
              </g>
            );
          })}

        {/* 2.5 LAYER: Green Landscape & Amenity Spaces */}
        {visibleLayers.gardens &&
          greens.map((green) => {
            const isSelected = selectedLandUse?.id === green.id;
            const pathD = toSvgPath(green.geometry);
            if (!pathD) return null;
            const greenLblPt = toLabelPoint(green.geometry);
            return (
              <g key={green.id}>
                {/* Jogging Track Perimeter */}
                <path
                  d={pathD}
                  fill="none"
                  stroke="#c99e63"
                  strokeWidth={3 * (viewBox.width / 1000)}
                  strokeDasharray="6 4"
                />

                {/* Lush Lawn Texture */}
                <path
                  d={pathD}
                  fill={isSelected ? "#60a5fa" : "url(#lawnGrass)"}
                  stroke={isSelected ? "#ffffff" : "#385b20"}
                  strokeWidth={2 * (viewBox.width / 1000)}
                  fillRule="evenodd"
                  className="cursor-pointer transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (pointerStateRef.current.moved) return;
                    onSelectLandUse(green);
                  }}
                />

                {/* Amenity Label */}
                {visibleLayers.landUseLabels !== false && (
                  <text
                    x={greenLblPt[0]}
                    y={greenLblPt[1]}
                    fontSize={baseFontSize * 1.1}
                    fill="#ffffff"
                    fontWeight="700"
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="pointer-events-none select-none uppercase font-sans drop-shadow-md"
                  >
                    {green.name || green.source_label || "GREEN LANDSCAPE · JOGGING TRACK"}
                  </text>
                )}

                {/* Fountain symbol in center */}
                <use
                  href="#fountainSymbol"
                  x={greenLblPt[0]}
                  y={greenLblPt[1]}
                  transform={`scale(${viewBox.width / 1000})`}
                />
              </g>
            );
          })}

        {/* Main Entrance Symbol */}
        {roads.length > 0 && (() => {
          const firstRoad = roads[0];
          const entryPt = toLabelPoint(firstRoad.geometry);
          return (
            <use
              href="#mainEntranceSymbol"
              x={entryPt[0]}
              y={entryPt[1] + 50}
              transform={`scale(${viewBox.width / 1000})`}
              pointerEvents="none"
            />
          );
        })()}

        {/* 3. LAYER: Plots (Luxury Warm Ivory Bungalow Finish) */}
        {visibleLayers.plots &&
          renderPlots.map((plot) => {
            const isSelected = selectedPlot?.id === plot.id;
            const isHovered = hoveredPlotId === plot.id;
            const pathD = toSvgPath(plot.geometry);
            if (!pathD) return null;

            let fillColor = "#f8f5ee"; // Warm luxury bungalow finish
            let strokeColor = "#2a2721";
            let strokeWidth = 1.3 * (viewBox.width / 1000);

            if (isSelected) {
              fillColor = "#82cebf"; // Vibrant mint-teal matching reference
              strokeColor = "#00c08b";
              strokeWidth = 3 * (viewBox.width / 1000);
            } else if (isHovered) {
              fillColor = "#ede5d8";
              strokeColor = "#00c08b";
              strokeWidth = 2.2 * (viewBox.width / 1000);
            }

            const centroid = toLabelPoint(plot.geometry);
            const plotNum = plot.original_number || plot.number || "";

            return (
              <g key={plot.id}>
                {/* Plot Underlay / Setback Lawn Border */}
                <path
                  d={pathD}
                  fill="#527c32"
                  stroke="#385820"
                  strokeWidth={4 * (viewBox.width / 1000)}
                />

                {/* Bungalow Plot Paved Surface */}
                <path
                  d={pathD}
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth={strokeWidth}
                  fillRule="evenodd"
                  className="cursor-pointer transition-all duration-150"
                  onPointerEnter={() => setHoveredPlotId(plot.id)}
                  onPointerLeave={() => setHoveredPlotId(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (pointerStateRef.current.moved) return;
                    onSelectPlot(plot);
                  }}
                />

                {/* Clean Plot Number Label (Always visible & crisp) */}
                {visibleLayers.plotLabels !== false && (
                  <text
                    x={centroid[0]}
                    y={centroid[1]}
                    fontSize={baseFontSize * (isSelected ? 1.25 : 1.05)}
                    fill={isSelected ? "#043d2f" : "#181b20"}
                    fontWeight={isSelected ? "800" : "700"}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="pointer-events-none select-none font-sans"
                  >
                    {plotNum}
                  </text>
                )}
              </g>
            );
          })}

        {/* 4. LAYER: Architectural Tree Symbols along Corridors */}
        {decorativeTrees.map((tree) => (
          <use
            key={tree.id}
            href="#treeSymbol"
            x={tree.x}
            y={tree.y}
            transform={`scale(${viewBox.width / 1000})`}
            pointerEvents="none"
          />
        ))}

        {/* 5. LAYER: Dimension Annotations */}
        {visibleLayers.dimensions &&
          dimensions.map((dim) => {
            const rawPos = dim.position || dim.anchor;
            if (!Array.isArray(rawPos) || rawPos.length < 2) return null;
            const position = toPoint(rawPos);
            const rawVal =
              dim.original_text || `${dim.parsed_value || ""} ${dim.original_unit || ""}`;
            return (
              <g key={dim.id} className="opacity-90">
                <text
                  x={position[0]}
                  y={position[1]}
                  fontSize={baseFontSize * 0.9}
                  fill="#38bdf8"
                  fontWeight="600"
                >
                  {rawVal}
                </text>
              </g>
            );
          })}
      </svg>

      {/* Floating Status Bar & Coordinate Readout */}
      <div className="absolute bottom-2 left-2 z-10 flex items-center gap-3 bg-slate-900/90 backdrop-blur px-3 py-1.5 rounded-lg border border-slate-700/60 text-xs text-slate-300 shadow-md font-mono">
        {mouseCoords ? (
          <span>
            X: <strong className="text-white">{mouseCoords.x}</strong>, Y:{" "}
            <strong className="text-white">{mouseCoords.y}</strong>
          </span>
        ) : (
          <span>Plan Ready</span>
        )}
        <span className="text-slate-600">|</span>
        <span>
          Plots: <strong className="text-emerald-400 font-bold">{plots.length}</strong>
        </span>
        <span className="text-slate-600">|</span>
        <span>
          Roads: <strong className="text-sky-400 font-bold">{roads.length}</strong>
        </span>
      </div>

      {/* Selected Entity Banner */}
      {selectedPlot && (
        <div className="absolute top-2 left-2 z-10 bg-emerald-600 text-white text-xs px-3.5 py-2 rounded-lg shadow-xl flex items-center gap-2.5 font-medium border border-emerald-400/30">
          <span>Selected Plot:</span>
          <span className="bg-emerald-950/60 px-2 py-0.5 rounded font-mono font-bold text-emerald-200">
            {selectedPlot.original_number || selectedPlot.number}
          </span>
          <button
            onClick={() => onSelectPlot(null)}
            className="ml-2 hover:bg-emerald-700 p-0.5 rounded text-white"
            title="Deselect"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
