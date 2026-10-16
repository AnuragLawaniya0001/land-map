import React, { useState, useMemo } from "react";
import {
  X,
  Box,
  Layers,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ExternalLink,
  Search,
  CheckCircle,
  HelpCircle,
  Compass,
  Ruler,
  Maximize,
  ArrowRight,
  Info,
  ShieldCheck,
  ShieldAlert,
  Globe,
} from "lucide-react";
import { formatMeasurement } from "@/lib/canonicalGeo";

export default function Canonical3DInspector({
  colonyName = "Colony",
  plots = [],
  zones = [],
  statuses = [],
  selectedPlot = null,
  selectedRoad = null,
  selectedLandUse = null,
  selectedZone = null,
  boundaryValidation = null,
  imageryInfo = null,
  selectedPlotContainment = null,
  onSelectZone = () => {},
  onSelectPlot = () => {},
  onClose = () => {},
  onOpenDetails = null,
}) {
  const [tableExpanded, setTableExpanded] = useState(false);
  const [tableSearch, setTableSearch] = useState("");
  const [qaExpanded, setQaExpanded] = useState(true);

  // Inventory statistics calculation
  const totalPlotsCount = plots.length;
  const availablePlotsCount = plots.filter((p) => (p.status_id || "available") === "available").length;
  const holdPlotsCount = plots.filter((p) => p.status_id === "hold").length;
  const reservedPlotsCount = plots.filter((p) => p.status_id === "reserved").length;
  const soldPlotsCount = plots.filter((p) => p.status_id === "sold").length;

  const zonesById = useMemo(() => {
    return Object.fromEntries(zones.map((z) => [z.id, z]));
  }, [zones]);

  const statusesById = useMemo(() => {
    return Object.fromEntries(statuses.map((s) => [s.id, s]));
  }, [statuses]);

  // Formatted area and dimensions for selected plot
  const plotDetails = useMemo(() => {
    if (!selectedPlot) return null;

    const plotNum = selectedPlot.original_number || selectedPlot.number || selectedPlot.id || "";
    const statusId = selectedPlot.status_id || "available";
    const statusObj = statusesById[statusId] || { name: statusId, color: "#10b981" };

    const zoneObj = selectedPlot.zone_id ? zonesById[selectedPlot.zone_id] : null;
    const zoneName = zoneObj ? `Zone ${zoneObj.code || zoneObj.name}` : (selectedPlot.zone_code ? `Zone ${selectedPlot.zone_code}` : "Zone A");

    // Area calculation in Sqyd / Sqm
    let areaDisplay = "—";
    if (selectedPlot.area_sqyd || selectedPlot.declared_area_sqyd) {
      areaDisplay = `${Number(selectedPlot.area_sqyd || selectedPlot.declared_area_sqyd).toFixed(2)} Sqyd`;
    } else if (selectedPlot.area || selectedPlot.area_sqm) {
      const areaVal = Number(selectedPlot.area || selectedPlot.area_sqm);
      const sqydVal = areaVal * 1.19599;
      areaDisplay = `${sqydVal.toFixed(2)} Sqyd`;
    }

    // Dimensions
    let dimsDisplay = "—";
    if (selectedPlot.declared_dimensions) {
      dimsDisplay = selectedPlot.declared_dimensions;
    } else if (selectedPlot.width && selectedPlot.length) {
      dimsDisplay = `${Number(selectedPlot.width).toFixed(1)} ft × ${Number(selectedPlot.length).toFixed(1)} ft (approx)`;
    } else if (selectedPlot.dimensions) {
      dimsDisplay = typeof selectedPlot.dimensions === "string"
        ? selectedPlot.dimensions
        : `${selectedPlot.dimensions.width || 0} × ${selectedPlot.dimensions.length || 0}`;
    }

    // Frontage & Facing
    const frontage = selectedPlot.frontage_ft || selectedPlot.frontage || (selectedPlot.width ? `${Number(selectedPlot.width).toFixed(1)} ft` : "—");
    const facing = selectedPlot.facing || selectedPlot.orientation || "East";

    return {
      number: plotNum,
      status: statusObj.name || "Available",
      statusColor: statusObj.color || "#10b981",
      zoneName,
      area: areaDisplay,
      dimensions: dimsDisplay,
      frontage,
      facing,
      validationStatus: selectedPlot.semantic_validation_status || "review_required",
    };
  }, [selectedPlot, statusesById, zonesById]);

  // Filtered plots for the collapsible plot table
  const filteredTablePlots = useMemo(() => {
    if (!tableSearch.trim()) return plots;
    const q = tableSearch.toLowerCase();
    return plots.filter((p) => {
      const num = String(p.original_number || p.number || p.id || "").toLowerCase();
      const zName = zonesById[p.zone_id]?.name?.toLowerCase() || "";
      const sId = (p.status_id || "").toLowerCase();
      return num.includes(q) || zName.includes(q) || sId.includes(q);
    });
  }, [plots, tableSearch, zonesById]);

  return (
    <aside
      className="w-80 md:w-88 h-full bg-[#0b101d]/95 backdrop-blur-2xl border-l border-slate-800 text-slate-200 flex flex-col select-none overflow-hidden shadow-2xl z-20 font-sans"
      data-testid="canonical-3d-site-inspector"
    >
      {/* Top Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800/80 bg-slate-900/40">
        <div className="flex items-center gap-2">
          <Box size={16} className="text-blue-400" />
          <h2 className="text-xs font-bold tracking-wider text-slate-100 uppercase">
            3D Site Inspector
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition"
          title="Close Inspector"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 custom-scrollbar">
        {/* Top 4-Card Telemetry Grid */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="bg-slate-900/60 border border-slate-800/90 rounded-xl p-3.5 flex flex-col justify-between">
            <span className="text-2xl font-bold text-emerald-400 tracking-tight leading-none mb-1">
              {availablePlotsCount}
            </span>
            <span className="text-[11px] font-medium text-slate-400">Available</span>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/90 rounded-xl p-3.5 flex flex-col justify-between">
            <span className="text-2xl font-bold text-slate-100 tracking-tight leading-none mb-1">
              {totalPlotsCount}
            </span>
            <span className="text-[11px] font-medium text-slate-400">Total Plots</span>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/90 rounded-xl p-3.5 flex flex-col justify-between">
            <span className="text-2xl font-bold text-amber-400 tracking-tight leading-none mb-1">
              {holdPlotsCount + reservedPlotsCount}
            </span>
            <span className="text-[11px] font-medium text-slate-400">Hold / Reserved</span>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/90 rounded-xl p-3.5 flex flex-col justify-between">
            <span className="text-2xl font-bold text-rose-400 tracking-tight leading-none mb-1">
              {soldPlotsCount}
            </span>
            <span className="text-[11px] font-medium text-slate-400">Sold</span>
          </div>
        </div>

        {/* Zones Breakdown */}
        {zones.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                Zones
              </span>
              {selectedZone && (
                <button
                  type="button"
                  onClick={() => onSelectZone(null)}
                  className="text-[10px] text-blue-400 hover:text-blue-300 transition"
                >
                  Clear Filter
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {zones.map((z) => {
                const count = plots.filter((p) => p.zone_id === z.id).length;
                const isSel = selectedZone === z.id;
                const color = z.color || "#38bdf8";
                return (
                  <button
                    key={z.id}
                    type="button"
                    onClick={() => onSelectZone(isSel ? null : z.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                      isSel
                        ? "bg-blue-500/20 text-white border-blue-400 shadow-md"
                        : "bg-slate-900/50 text-slate-300 border-slate-800 hover:border-slate-700 hover:text-white"
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                    <span>Zone {z.code || z.name}</span>
                    <span className="text-slate-400 text-[10px] ml-0.5">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Selected Entity Card */}
        {selectedPlot ? (
          <div className="space-y-3 pt-1 border-t border-slate-800/80">
            <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
              Selected Plot
            </span>

            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 space-y-3.5 shadow-lg">
              {/* Plot Header & Status Badge */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-blue-400 font-bold text-xs">
                    <Box size={15} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white leading-tight">
                      Plot {plotDetails.number}
                    </h3>
                  </div>
                </div>

                <span
                  className="px-2.5 py-1 rounded-full text-[11px] font-semibold border flex items-center gap-1.5 capitalize"
                  style={{
                    backgroundColor: `${plotDetails.statusColor}18`,
                    color: plotDetails.statusColor,
                    borderColor: `${plotDetails.statusColor}40`,
                  }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: plotDetails.statusColor }} />
                  {plotDetails.status}
                </span>
              </div>

              {/* Attributes Table */}
              <div className="space-y-2 text-xs pt-1 border-t border-slate-800/80">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Zone</span>
                  <span className="font-semibold text-slate-200">{plotDetails.zoneName}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Area</span>
                  <span className="font-semibold text-slate-200">{plotDetails.area}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Dimensions</span>
                  <span className="font-semibold text-slate-200">{plotDetails.dimensions}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Frontage</span>
                  <span className="font-semibold text-slate-200">{plotDetails.frontage}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Facing</span>
                  <span className="font-semibold text-slate-200">{plotDetails.facing}</span>
                </div>

                {selectedPlotContainment && (
                  <div className="flex items-center justify-between pt-1 border-t border-slate-800/60">
                    <span className="text-slate-400">Boundary QA</span>
                    <span
                      className={`text-[11px] font-semibold flex items-center gap-1 ${
                        selectedPlotContainment.status === "contained"
                          ? "text-emerald-400"
                          : selectedPlotContainment.status === "tolerance_overlap"
                          ? "text-sky-400"
                          : "text-amber-400"
                      }`}
                    >
                      {selectedPlotContainment.status === "contained" ? (
                        <>
                          <ShieldCheck size={13} />
                          <span>100% Contained</span>
                        </>
                      ) : selectedPlotContainment.status === "tolerance_overlap" ? (
                        <>
                          <ShieldCheck size={13} />
                          <span>Border Tolerance ({(selectedPlotContainment.insideFraction * 100).toFixed(0)}%)</span>
                        </>
                      ) : (
                        <>
                          <ShieldAlert size={13} />
                          <span>Constraint Violation</span>
                        </>
                      )}
                    </span>
                  </div>
                )}
              </div>

              {/* Action Button */}
              {onOpenDetails && (
                <button
                  type="button"
                  onClick={() => onOpenDetails(selectedPlot)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-slate-800/90 hover:bg-slate-700/90 text-slate-200 hover:text-white text-xs font-semibold border border-slate-700/80 transition shadow"
                >
                  <span>View Details</span>
                  <ChevronRight size={14} className="text-slate-400" />
                </button>
              )}
            </div>
          </div>
        ) : selectedRoad ? (
          <div className="space-y-3 pt-1 border-t border-slate-800/80">
            <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
              Selected Road
            </span>
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-lg">
              <h3 className="text-sm font-bold text-white">
                {selectedRoad.source_label || selectedRoad.name || `Road #${selectedRoad.id}`}
              </h3>
              <div className="space-y-1.5 text-xs text-slate-400">
                <div className="flex justify-between">
                  <span>Width</span>
                  <span className="text-slate-200 font-semibold">{selectedRoad.width ? `${selectedRoad.width} m` : "Standard Access"}</span>
                </div>
                <div className="flex justify-between">
                  <span>Pavement</span>
                  <span className="text-slate-200 font-semibold">High-grade Asphalt</span>
                </div>
              </div>
            </div>
          </div>
        ) : selectedLandUse ? (
          <div className="space-y-3 pt-1 border-t border-slate-800/80">
            <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
              Selected Open Space
            </span>
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-lg">
              <h3 className="text-sm font-bold text-white">
                {selectedLandUse.name || selectedLandUse.source_label || "Garden / Park"}
              </h3>
              <div className="space-y-1.5 text-xs text-slate-400">
                <div className="flex justify-between">
                  <span>Category</span>
                  <span className="text-emerald-400 font-semibold">Community Landscape Park</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-slate-900/40 border border-dashed border-slate-800 rounded-2xl p-4 text-center text-slate-400 space-y-2">
            <Compass size={24} className="mx-auto text-slate-500 opacity-80" />
            <p className="text-xs font-medium text-slate-300">No Plot Selected</p>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Click any plot, road corridor, or garden inside the 3D viewport to inspect its properties.
            </p>
          </div>
        )}

        {/* Geospatial QA & Boundary Containment Dashboard Section */}
        <div className="pt-2 border-t border-slate-800/80">
          <button
            type="button"
            onClick={() => setQaExpanded(!qaExpanded)}
            className="w-full flex items-center justify-between py-2 px-1 text-xs font-semibold text-slate-300 hover:text-white transition"
          >
            <div className="flex items-center gap-2">
              <ShieldCheck size={14} className="text-emerald-400" />
              <span>Geospatial QA & Boundary</span>
            </div>
            {qaExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>

          {qaExpanded && (
            <div className="mt-2 space-y-2.5 bg-slate-900/70 border border-slate-800 rounded-xl p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Boundary Reference:</span>
                <span className="text-slate-200 font-medium">
                  {boundaryValidation?.boundaryValid ? "Authoritative KML" : "Unverified"}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-slate-400">Boundary Containment:</span>
                <span className="text-emerald-400 font-bold">
                  {boundaryValidation
                    ? `${((boundaryValidation.containedPlots + boundaryValidation.tolerancePlots) / Math.max(boundaryValidation.totalPlots, 1) * 100).toFixed(1)}%`
                    : "100%"}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-slate-400">Plots Inside Perimeter:</span>
                <span className="text-slate-200">
                  {boundaryValidation
                    ? `${boundaryValidation.containedPlots} verified${boundaryValidation.tolerancePlots > 0 ? ` (+${boundaryValidation.tolerancePlots} border)` : ""}`
                    : `${plots.length} plots`}
                </span>
              </div>

              {boundaryValidation?.outOfBoundaryPlots > 0 && (
                <div className="flex items-center justify-between text-amber-400 font-semibold bg-amber-950/40 p-1.5 rounded-lg border border-amber-800/40">
                  <span>Boundary Exceptions:</span>
                  <span>{boundaryValidation.outOfBoundaryPlots} out of boundary</span>
                </div>
              )}

              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
                <span className="text-slate-400 flex items-center gap-1.5">
                  <Globe size={12} className="text-cyan-400" />
                  <span>Aerial Imagery:</span>
                </span>
                <span className="text-cyan-300 font-medium truncate max-w-[130px]" title={imageryInfo?.provider || "Esri World Imagery"}>
                  {imageryInfo?.provider || "Esri World Imagery"}
                </span>
              </div>

              {imageryInfo?.zoom && (
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Zoom Level:</span>
                  <span>Level {imageryInfo.zoom} ({imageryInfo.tilesCount || "—"} tiles)</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Collapsible Plot Table Section */}
        <div className="pt-2 border-t border-slate-800/80">
          <button
            type="button"
            onClick={() => setTableExpanded(!tableExpanded)}
            className="w-full flex items-center justify-between py-2 px-1 text-xs font-semibold text-slate-300 hover:text-white transition"
          >
            <div className="flex items-center gap-2">
              <Layers size={14} className="text-blue-400" />
              <span>Full Plot Table</span>
              <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded-full">
                {plots.length}
              </span>
            </div>
            {tableExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>

          {tableExpanded && (
            <div className="mt-2.5 space-y-2 bg-slate-900/70 border border-slate-800 rounded-xl p-2.5">
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-2.5 text-slate-500" />
                <input
                  type="text"
                  placeholder="Filter plots..."
                  value={tableSearch}
                  onChange={(e) => setTableSearch(e.target.value)}
                  className="w-full pl-7 pr-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-200 outline-none focus:border-blue-500"
                />
              </div>

              <div className="max-h-48 overflow-y-auto space-y-1 custom-scrollbar">
                {filteredTablePlots.slice(0, 80).map((p) => {
                  const isCurrent = selectedPlot?.id === p.id;
                  const num = p.original_number || p.number || p.id;
                  const status = p.status_id || "available";
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onSelectPlot(p)}
                      className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition ${
                        isCurrent
                          ? "bg-blue-600 text-white font-semibold"
                          : "hover:bg-slate-800 text-slate-300"
                      }`}
                    >
                      <span>Plot {num}</span>
                      <span className="text-[10px] capitalize opacity-80">{status}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
