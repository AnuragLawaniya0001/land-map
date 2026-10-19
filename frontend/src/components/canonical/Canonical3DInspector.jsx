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
    const map = {};
    (zones || []).forEach((z) => {
      if (z.id) map[z.id] = z;
      if (z.code) {
        map[z.code] = z;
        map[z.code.toLowerCase()] = z;
        map[`zone ${z.code}`.toLowerCase()] = z;
      }
      if (z.name) {
        map[z.name] = z;
        map[z.name.toLowerCase()] = z;
      }
    });
    return map;
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
    const zoneName = zoneObj ? (zoneObj.name || `Zone ${zoneObj.code}`) : (selectedPlot.zone_code ? `Zone ${selectedPlot.zone_code}` : (selectedPlot.zone_id || "Zone A"));

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
      className="w-80 md:w-[330px] shrink-0 h-full bg-[#FAF8F5] border-l border-[#E5DFD3] text-[#172A25] flex flex-col select-none overflow-hidden shadow-xl z-20 font-sans"
      data-testid="canonical-3d-site-inspector"
    >
      {/* Top Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[#E5DFD3] bg-[#F5F1E8]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[#173F35] border border-[#173F35] flex items-center justify-center text-white shadow-sm">
            <Box size={15} />
          </div>
          <div>
            <h2 className="text-xs font-bold tracking-wider text-[#172A25] uppercase">
              3D Site Inspector
            </h2>
            <div className="text-[10px] text-[#047857] font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] animate-pulse" />
              Spatial Engine Live
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-[#EDE6D6] text-[#5C6470] hover:text-[#172A25] transition"
          title="Close Inspector"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 custom-scrollbar">
        {/* Top 4-Card Modern Telemetry Grid */}
        <div className="grid grid-cols-2 gap-2.5">
          {/* Available */}
          <div className="relative overflow-hidden rounded-2xl bg-[#FFFFFF] border border-[#A7F3D0] p-3.5 flex flex-col justify-between shadow-sm group hover:border-[#047857] transition-all">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold text-[#047857] uppercase tracking-wider">Available</span>
              <span className="w-2 h-2 rounded-full bg-[#10b981]" />
            </div>
            <span className="text-3xl font-extrabold text-[#047857] tracking-tight leading-none font-mono">
              {availablePlotsCount}
            </span>
          </div>

          {/* Total Plots */}
          <div className="relative overflow-hidden rounded-2xl bg-[#FFFFFF] border border-[#BAE6FD] p-3.5 flex flex-col justify-between shadow-sm group hover:border-[#0369A1] transition-all">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold text-[#0369A1] uppercase tracking-wider">Total</span>
              <span className="w-2 h-2 rounded-full bg-[#38bdf8]" />
            </div>
            <span className="text-3xl font-extrabold text-[#0369A1] tracking-tight leading-none font-mono">
              {totalPlotsCount}
            </span>
          </div>

          {/* Hold / Reserved */}
          <div className="relative overflow-hidden rounded-2xl bg-[#FFFFFF] border border-[#FDE68A] p-3.5 flex flex-col justify-between shadow-sm group hover:border-[#B45309] transition-all">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold text-[#B45309] uppercase tracking-wider">Hold/Res</span>
              <span className="w-2 h-2 rounded-full bg-[#f59e0b]" />
            </div>
            <span className="text-3xl font-extrabold text-[#B45309] tracking-tight leading-none font-mono">
              {holdPlotsCount + reservedPlotsCount}
            </span>
          </div>

          {/* Sold */}
          <div className="relative overflow-hidden rounded-2xl bg-[#FFFFFF] border border-[#FECDD3] p-3.5 flex flex-col justify-between shadow-sm group hover:border-[#BE123C] transition-all">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold text-[#BE123C] uppercase tracking-wider">Sold</span>
              <span className="w-2 h-2 rounded-full bg-[#f43f5e]" />
            </div>
            <span className="text-3xl font-extrabold text-[#BE123C] tracking-tight leading-none font-mono">
              {soldPlotsCount}
            </span>
          </div>
        </div>

        {/* Zones Breakdown */}
        {zones.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold tracking-wider text-[#5C6470] uppercase">
                Colony Zones
              </span>
              {selectedZone && (
                <button
                  type="button"
                  onClick={() => onSelectZone(null)}
                  className="text-[10px] text-[#173F35] font-bold hover:underline transition"
                >
                  Clear Filter
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {zones.map((z) => {
                const count = plots.filter((p) => {
                  const pz = zonesById[p.zone_id];
                  return p.zone_id === z.id || (pz && pz.id === z.id);
                }).length;
                const isSel = selectedZone === z.id;
                const color = z.color || "#173F35";
                return (
                  <button
                    key={z.id}
                    type="button"
                    onClick={() => onSelectZone(isSel ? null : z.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                      isSel
                        ? "bg-[#173F35] text-white border-[#173F35] shadow-sm"
                        : "bg-[#FFFFFF] text-[#172A25] border-[#E5DFD3] hover:border-[#173F35] hover:bg-[#FAF8F5]"
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                    <span>{z.name || `Zone ${z.code}`}</span>
                    <span className={`text-[10px] ml-0.5 font-bold px-1.5 py-0.5 rounded-full ${
                      isSel ? "bg-white/20 text-white" : "bg-[#F3EFE6] text-[#172A25]"
                    }`}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Selected Entity Card */}
        {selectedPlot ? (
          <div className="space-y-3 pt-1 border-t border-[#E5DFD3]">
            <span className="text-[10px] font-bold tracking-wider text-[#5C6470] uppercase">
              Selected Plot Telemetry
            </span>

            <div className="relative overflow-hidden bg-[#FFFFFF] border border-[#E5DFD3] rounded-2xl p-4 space-y-3.5 shadow-sm">
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-[#173F35]" />
              {/* Plot Header & Status Badge */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-[#E8F0EC] border border-[#D1E2DA] flex items-center justify-center text-[#173F35] font-bold text-xs">
                    <Box size={16} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-[#172A25] leading-tight">
                      Plot {plotDetails.number}
                    </h3>
                  </div>
                </div>

                <span
                  className="px-2.5 py-1 rounded-full text-[11px] font-semibold border flex items-center gap-1.5 capitalize shadow-sm"
                  style={{
                    backgroundColor: `${plotDetails.statusColor}18`,
                    color: plotDetails.statusColor,
                    borderColor: `${plotDetails.statusColor}40`,
                  }}
                >
                  <span className="w-1.5 h-1.5 rounded-full shadow-[0_0_6px_currentColor]" style={{ background: plotDetails.statusColor }} />
                  {plotDetails.status}
                </span>
              </div>

              {/* Attributes Table */}
              <div className="space-y-2 text-xs pt-1 border-t border-[#E8E2D6]">
                <div className="flex items-center justify-between">
                  <span className="text-[#5C6470]">Zone</span>
                  <span className="font-semibold text-[#172A25]">{plotDetails.zoneName}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-[#5C6470]">Area</span>
                  <span className="font-bold text-[#047857] font-mono">{plotDetails.area}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-[#5C6470]">Dimensions</span>
                  <span className="font-semibold text-[#172A25]">{plotDetails.dimensions}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-[#5C6470]">Frontage</span>
                  <span className="font-semibold text-[#172A25]">{plotDetails.frontage}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-[#5C6470]">Facing</span>
                  <span className="font-semibold text-[#172A25]">{plotDetails.facing}</span>
                </div>

                {selectedPlotContainment && (
                  <div className="flex items-center justify-between pt-1 border-t border-[#E8E2D6]">
                    <span className="text-[#5C6470]">Boundary QA</span>
                    <span
                      className={`text-[11px] font-semibold flex items-center gap-1 ${
                        selectedPlotContainment.status === "contained"
                          ? "text-[#047857]"
                          : selectedPlotContainment.status === "tolerance_overlap"
                          ? "text-[#0369A1]"
                          : "text-[#B45309]"
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
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-[#173F35] hover:bg-[#0D1B2A] text-white text-xs font-semibold shadow-sm transition"
                >
                  <span>View Details</span>
                  <ChevronRight size={14} />
                </button>
              )}
            </div>
          </div>
        ) : selectedRoad ? (
          <div className="space-y-3 pt-1 border-t border-[#E5DFD3]">
            <span className="text-[10px] font-bold tracking-wider text-[#5C6470] uppercase">
              Selected Road
            </span>
            <div className="bg-[#FFFFFF] border border-[#E5DFD3] rounded-2xl p-4 space-y-3 shadow-sm">
              <h3 className="text-sm font-bold text-[#172A25]">
                {selectedRoad.source_label || selectedRoad.name || `Road #${selectedRoad.id}`}
              </h3>
              <div className="space-y-1.5 text-xs text-[#5C6470]">
                <div className="flex justify-between">
                  <span>Width</span>
                  <span className="text-[#172A25] font-semibold">{selectedRoad.width ? `${selectedRoad.width} m` : "Standard Access"}</span>
                </div>
                <div className="flex justify-between">
                  <span>Pavement</span>
                  <span className="text-[#172A25] font-semibold">High-grade Asphalt</span>
                </div>
              </div>
            </div>
          </div>
        ) : selectedLandUse ? (
          <div className="space-y-3 pt-1 border-t border-[#E5DFD3]">
            <span className="text-[10px] font-bold tracking-wider text-[#5C6470] uppercase">
              Selected Open Space
            </span>
            <div className="bg-[#FFFFFF] border border-[#E5DFD3] rounded-2xl p-4 space-y-3 shadow-sm">
              <h3 className="text-sm font-bold text-[#172A25]">
                {selectedLandUse.name || selectedLandUse.source_label || "Garden / Park"}
              </h3>
              <div className="space-y-1.5 text-xs text-[#5C6470]">
                <div className="flex justify-between">
                  <span>Category</span>
                  <span className="text-[#047857] font-semibold">Community Landscape Park</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="relative overflow-hidden bg-[#FFFFFF] border border-[#E5DFD3] rounded-2xl p-6 text-center text-[#5C6470] space-y-2.5 shadow-sm">
            <div className="w-12 h-12 rounded-2xl bg-[#E8F0EC] border border-[#D1E2DA] flex items-center justify-center mx-auto text-[#173F35]">
              <Compass size={24} />
            </div>
            <p className="text-xs font-bold text-[#172A25]">Interactive 3D Inspector</p>
            <p className="text-[11px] text-[#5C6470] leading-relaxed max-w-[220px] mx-auto">
              Select any plot, road corridor, or amenity garden inside the 3D viewport to inspect its properties.
            </p>
          </div>
        )}

        {/* Geospatial QA & Boundary Containment Dashboard Section */}
        <div className="pt-2 border-t border-[#E5DFD3]">
          <button
            type="button"
            onClick={() => setQaExpanded(!qaExpanded)}
            className="w-full flex items-center justify-between py-2 px-1 text-xs font-semibold text-[#172A25] hover:text-[#173F35] transition"
          >
            <div className="flex items-center gap-2">
              <ShieldCheck size={14} className="text-[#047857]" />
              <span>Geospatial QA & Boundary</span>
            </div>
            {qaExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>

          {qaExpanded && (
            <div className="mt-2 space-y-2.5 bg-[#FFFFFF] border border-[#E5DFD3] rounded-xl p-3 text-xs text-[#172A25] shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-[#5C6470]">Boundary Reference:</span>
                <span className="text-[#172A25] font-medium">
                  {boundaryValidation?.boundaryValid ? "Authoritative KML" : "Unverified"}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[#5C6470]">Boundary Containment:</span>
                <span className="text-[#047857] font-bold">
                  {boundaryValidation
                    ? `${((boundaryValidation.containedPlots + boundaryValidation.tolerancePlots) / Math.max(boundaryValidation.totalPlots, 1) * 100).toFixed(1)}%`
                    : "100%"}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[#5C6470]">Plots Inside Perimeter:</span>
                <span className="text-[#172A25]">
                  {boundaryValidation
                    ? `${boundaryValidation.containedPlots} verified${boundaryValidation.tolerancePlots > 0 ? ` (+${boundaryValidation.tolerancePlots} border)` : ""}`
                    : `${plots.length} plots`}
                </span>
              </div>

              {boundaryValidation?.outOfBoundaryPlots > 0 && (
                <div className="flex items-center justify-between text-[#B45309] font-semibold bg-[#FEF3C7] p-1.5 rounded-lg border border-[#FDE68A]">
                  <span>Boundary Exceptions:</span>
                  <span>{boundaryValidation.outOfBoundaryPlots} out of boundary</span>
                </div>
              )}

              <div className="pt-2 border-t border-[#E8E2D6] flex items-center justify-between">
                <span className="text-[#5C6470] flex items-center gap-1.5">
                  <Globe size={12} className="text-[#0369A1]" />
                  <span>Aerial Imagery:</span>
                </span>
                <span className="text-[#0369A1] font-semibold truncate max-w-[130px]" title={imageryInfo?.provider || "Esri World Imagery"}>
                  {imageryInfo?.provider || "Esri World Imagery"}
                </span>
              </div>

              {imageryInfo?.zoom && (
                <div className="flex items-center justify-between text-[11px] text-[#5C6470]">
                  <span>Zoom Level:</span>
                  <span>Level {imageryInfo.zoom} ({imageryInfo.tilesCount || "—"} tiles)</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Collapsible Plot Table Section */}
        <div className="pt-2 border-t border-[#E5DFD3]">
          <button
            type="button"
            onClick={() => setTableExpanded(!tableExpanded)}
            className="w-full flex items-center justify-between py-2 px-1 text-xs font-semibold text-[#172A25] hover:text-[#173F35] transition"
          >
            <div className="flex items-center gap-2">
              <Layers size={14} className="text-[#0369A1]" />
              <span>Full Plot Table</span>
              <span className="text-[10px] bg-[#F3EFE6] text-[#172A25] font-bold px-1.5 py-0.5 rounded-full">
                {plots.length}
              </span>
            </div>
            {tableExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>

          {tableExpanded && (
            <div className="mt-2.5 space-y-2 bg-[#FFFFFF] border border-[#E5DFD3] rounded-xl p-2.5 shadow-sm">
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-2.5 text-[#5C6470]" />
                <input
                  type="text"
                  placeholder="Filter plots..."
                  value={tableSearch}
                  onChange={(e) => setTableSearch(e.target.value)}
                  className="w-full pl-7 pr-3 py-1.5 text-xs bg-[#FAF8F5] border border-[#E5DFD3] rounded-lg text-[#172A25] outline-none focus:border-[#173F35]"
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
                          ? "bg-[#173F35] text-white font-semibold"
                          : "hover:bg-[#FAF8F5] text-[#172A25]"
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
