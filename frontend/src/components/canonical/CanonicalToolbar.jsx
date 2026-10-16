/**
 * Canonical 2D Map Toolbar.
 *
 * Provides zoom, fit-to-boundary, reset, and layer visibility controls.
 */

import { useState } from "react";
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Focus,
  Layers,
  RotateCcw,
  Box,
  Map as MapIcon,
  Edit3,
  Download,
  Image as ImageIcon,
} from "lucide-react";

export default function CanonicalToolbar({
  onZoomIn,
  onZoomOut,
  onFitAll,
  onFitSelected,
  onReset,
  hasSelection = false,
  hasSourceArtwork = false,
  visibleLayers,
  onChangeLayer,
  viewMode = "2d",
  onToggleViewMode,
  isReviewMode = false,
  onToggleReviewMode,
  onOpenExport,
}) {
  const [layersOpen, setLayersOpen] = useState(false);

  return (
    <div className="relative flex items-center gap-1.5 bg-white border border-slate-200 rounded-lg p-1.5 shadow-sm">
      <button
        onClick={onZoomIn}
        className="p-1.5 hover:bg-slate-100 rounded text-slate-700 transition"
        title="Zoom In"
        aria-label="Zoom In"
      >
        <ZoomIn className="w-4 h-4" />
      </button>

      <button
        onClick={onZoomOut}
        className="p-1.5 hover:bg-slate-100 rounded text-slate-700 transition"
        title="Zoom Out"
        aria-label="Zoom Out"
      >
        <ZoomOut className="w-4 h-4" />
      </button>

      <div className="w-px h-5 bg-slate-200 my-auto" />

      <button
        onClick={onFitAll}
        className="p-1.5 hover:bg-slate-100 rounded text-slate-700 transition flex items-center gap-1 text-xs font-medium"
        title="Fit Colony Boundary"
        aria-label="Fit Colony Boundary"
      >
        <Maximize2 className="w-4 h-4" />
        <span className="hidden sm:inline">Fit Boundary</span>
      </button>

      {hasSelection && (
        <button
          onClick={onFitSelected}
          className="p-1.5 hover:bg-blue-50 text-blue-700 rounded transition flex items-center gap-1 text-xs font-medium"
          title="Fit Selected Plot"
          aria-label="Fit Selected Plot"
        >
          <Focus className="w-4 h-4" />
          <span className="hidden sm:inline">Fit Plot</span>
        </button>
      )}

      <button
        onClick={onReset}
        className="p-1.5 hover:bg-slate-100 rounded text-slate-700 transition"
        title="Reset View"
        aria-label="Reset View"
      >
        <RotateCcw className="w-4 h-4" />
      </button>

      <div className="w-px h-5 bg-slate-200 my-auto" />

      {/* Layer Controls Dropdown */}
      <div className="relative">
        <button
          onClick={() => setLayersOpen(!layersOpen)}
          className={`p-1.5 rounded transition flex items-center gap-1 text-xs font-medium ${
            layersOpen ? "bg-slate-200 text-slate-800" : "hover:bg-slate-100 text-slate-700"
          }`}
          title="Layer Visibility"
          aria-label="Layer Visibility"
        >
          <Layers className="w-4 h-4" />
          <span className="hidden sm:inline">Layers</span>
        </button>

        {layersOpen && (
          <div className="absolute top-full mt-2 left-0 z-30 bg-white border border-slate-200 rounded-lg shadow-xl p-3 w-56 text-xs flex flex-col gap-2 animate-in fade-in zoom-in-95">
            <div className="font-semibold text-slate-800 border-b pb-1.5">Layer Controls</div>

            <label className="flex items-center justify-between cursor-pointer hover:bg-slate-50 p-1 rounded">
              <span className="text-slate-700 font-medium">Site Boundary</span>
              <input
                type="checkbox"
                checked={visibleLayers.boundary}
                onChange={(e) => onChangeLayer("boundary", e.target.checked)}
                className="rounded text-blue-600 focus:ring-blue-500"
              />
            </label>

            {hasSourceArtwork && (
              <label className="flex items-center justify-between cursor-pointer hover:bg-slate-50 p-1 rounded">
                <span className="text-slate-700 font-medium flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5" />
                  Original PDF overlay
                </span>
                <input
                  type="checkbox"
                  checked={visibleLayers.sourceArtwork !== false}
                  onChange={(e) => onChangeLayer("sourceArtwork", e.target.checked)}
                  className="rounded text-blue-600 focus:ring-blue-500"
                />
              </label>
            )}

            <label className="flex items-center justify-between cursor-pointer hover:bg-slate-50 p-1 rounded">
              <span className="text-slate-700 font-medium">Plots</span>
              <input
                type="checkbox"
                checked={visibleLayers.plots}
                onChange={(e) => onChangeLayer("plots", e.target.checked)}
                className="rounded text-blue-600 focus:ring-blue-500"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer hover:bg-slate-50 p-1 rounded">
              <span className="text-slate-700 font-medium">Road Corridors</span>
              <input
                type="checkbox"
                checked={visibleLayers.roads}
                onChange={(e) => onChangeLayer("roads", e.target.checked)}
                className="rounded text-blue-600 focus:ring-blue-500"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer hover:bg-slate-50 p-1 rounded">
              <span className="text-slate-700 font-medium">Gardens / Open Space</span>
              <input
                type="checkbox"
                checked={visibleLayers.gardens !== false}
                onChange={(e) => onChangeLayer("gardens", e.target.checked)}
                className="rounded text-blue-600 focus:ring-blue-500"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer hover:bg-slate-50 p-1 rounded">
              <span className="text-slate-700 font-medium">Plot Number Labels</span>
              <input
                type="checkbox"
                checked={visibleLayers.plotLabels}
                onChange={(e) => onChangeLayer("plotLabels", e.target.checked)}
                className="rounded text-blue-600 focus:ring-blue-500"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer hover:bg-slate-50 p-1 rounded">
              <span className="text-slate-700 font-medium">Road Labels</span>
              <input
                type="checkbox"
                checked={visibleLayers.roadLabels}
                onChange={(e) => onChangeLayer("roadLabels", e.target.checked)}
                className="rounded text-blue-600 focus:ring-blue-500"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer hover:bg-slate-50 p-1 rounded">
              <span className="text-slate-700 font-medium">Open Space Labels</span>
              <input
                type="checkbox"
                checked={visibleLayers.landUseLabels !== false}
                onChange={(e) => onChangeLayer("landUseLabels", e.target.checked)}
                className="rounded text-blue-600 focus:ring-blue-500"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer hover:bg-slate-50 p-1 rounded">
              <span className="text-slate-700 font-medium">Dimensions & Notes</span>
              <input
                type="checkbox"
                checked={visibleLayers.dimensions}
                onChange={(e) => onChangeLayer("dimensions", e.target.checked)}
                className="rounded text-blue-600 focus:ring-blue-500"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer hover:bg-slate-50 p-1 rounded">
              <span className="text-slate-700 font-medium">QA Issue Markers</span>
              <input
                type="checkbox"
                checked={visibleLayers.qaOverlay}
                onChange={(e) => onChangeLayer("qaOverlay", e.target.checked)}
                className="rounded text-blue-600 focus:ring-blue-500"
              />
            </label>
          </div>
        )}
      </div>

      <div className="w-px h-5 bg-slate-200 my-auto" />

      {/* 2D / 3D Mode Toggle */}
      {onToggleViewMode && (
        <button
          onClick={onToggleViewMode}
          className={`p-1.5 rounded transition flex items-center gap-1 text-xs font-semibold ${
            viewMode === "3d"
              ? "bg-indigo-600 text-white shadow-sm"
              : "hover:bg-slate-100 text-slate-700"
          }`}
          title={viewMode === "3d" ? "Switch to 2D Vector Map" : "Switch to 3D Extruded View"}
          aria-label={viewMode === "3d" ? "Switch to 2D Vector Map" : "Switch to 3D Extruded View"}
        >
          {viewMode === "3d" ? <MapIcon className="w-4 h-4" /> : <Box className="w-4 h-4" />}
          <span>{viewMode === "3d" ? "2D Map" : "3D View"}</span>
        </button>
      )}

      {/* Review Mode Toggle (Phase 12) */}
      {onToggleReviewMode && (
        <button
          onClick={onToggleReviewMode}
          className={`p-1.5 rounded transition flex items-center gap-1 text-xs font-semibold ${
            isReviewMode
              ? "bg-amber-600 text-white shadow-sm"
              : "hover:bg-slate-100 text-slate-700"
          }`}
          title={isReviewMode ? "Exit Review & Correction Mode" : "Enter Review & Correction Mode"}
          aria-label="Toggle Review Mode"
        >
          <Edit3 className="w-4 h-4" />
          <span className="hidden sm:inline">{isReviewMode ? "Editing" : "Review"}</span>
        </button>
      )}

      {/* Export Dataset Button (Phase 13) */}
      {onOpenExport && (
        <button
          onClick={onOpenExport}
          className="p-1.5 hover:bg-slate-100 text-slate-700 rounded transition flex items-center gap-1 text-xs font-medium"
          title="Export Dataset (GeoJSON, CSV, QA, DXF)"
          aria-label="Export Dataset"
        >
          <Download className="w-4 h-4" />
          <span className="hidden sm:inline">Export</span>
        </button>
      )}
    </div>
  );
}
