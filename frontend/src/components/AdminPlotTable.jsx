import { useMemo, useState } from "react";
import { MapPin, FileText, CheckSquare, Edit3, Download, Upload } from "lucide-react";
import { fmt } from "@/lib/geo";
import { SHAPE_LABEL } from "@/components/PlotCard";

export default function AdminPlotTable({
  data,
  onStatusChange,
  onBulkStatus,
  onOpenOnMap,
  onEditPlot,
  onExportCsv,
  onImportCsv,
  busy,
}) {
  const [sel, setSel] = useState(new Set());
  const [zoneF, setZoneF] = useState("");
  const [statusF, setStatusF] = useState("");
  const [q, setQ] = useState("");
  const [bulkStatus, setBulkStatus] = useState("");

  const zonesById = useMemo(() => {
    const map = {};
    (data.zones || []).forEach((z) => {
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
  }, [data.zones]);

  const rows = useMemo(
    () =>
      (data.plots || [])
        .filter((p) => {
          if (zoneF) {
            const pZone = zonesById[p.zone_id];
            const matchesZone =
              p.zone_id === zoneF ||
              (pZone && pZone.id === zoneF) ||
              (pZone && pZone.code === zoneF) ||
              (pZone && pZone.name === zoneF);
            if (!matchesZone) return false;
          }
          if (statusF && p.status_id !== statusF) return false;
          if (q && !String(p.number || "").toLowerCase().includes(q.trim().toLowerCase())) return false;
          return true;
        })
        .sort(
          (a, b) =>
            Number(a.number) - Number(b.number) ||
            String(a.number || "").localeCompare(String(b.number || ""))
        ),
    [data, zoneF, statusF, q, zonesById]
  );

  const allChecked = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const toggleAll = () => setSel(allChecked ? new Set() : new Set(rows.map((r) => r.id)));
  const toggle = (id) =>
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <div className="lm-plist" data-testid="admin-plot-list">
      <div className="lm-plist-bar">
        <input
          className="lm-input"
          placeholder="Search plot no."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="plot-list-search"
        />
        <select
          className="lm-input"
          value={zoneF}
          onChange={(e) => setZoneF(e.target.value)}
          data-testid="plot-list-zone-filter"
        >
          <option value="">All zones</option>
          {(data.zones || []).map((z) => {
            const zPlotsCount = (data.plots || []).filter((p) => {
              const pz = zonesById[p.zone_id];
              return p.zone_id === z.id || (pz && pz.id === z.id);
            }).length;
            return (
              <option key={z.id} value={z.id}>
                {z.name || `Zone ${z.code}`} ({zPlotsCount})
              </option>
            );
          })}
        </select>
        <select
          className="lm-input"
          value={statusF}
          onChange={(e) => setStatusF(e.target.value)}
          data-testid="plot-list-status-filter"
        >
          <option value="">All statuses</option>
          {(data.statuses || []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <span className="lm-plist-count" data-testid="plot-list-count">
          {rows.length} plots
        </span>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
          {onExportCsv && (
            <button
              className="lm-btn-secondary sm"
              style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "6px 12px" }}
              onClick={onExportCsv}
              type="button"
              data-testid="plot-table-export-csv"
              title="Download all plots as CSV"
            >
              <Download size={13} /> Export CSV
            </button>
          )}
          {onImportCsv && (
            <button
              className="lm-btn-primary sm"
              style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "6px 12px" }}
              onClick={onImportCsv}
              type="button"
              data-testid="plot-table-import-csv"
              title="Upload and bulk update plots from CSV"
            >
              <Upload size={13} /> Import CSV
            </button>
          )}
        </div>
      </div>

      {sel.size > 0 && (
        <div className="lm-bulk-bar" data-testid="bulk-bar">
          <CheckSquare size={15} /> <b>{sel.size}</b> selected →
          <select
            className="lm-input"
            value={bulkStatus}
            onChange={(e) => setBulkStatus(e.target.value)}
            data-testid="bulk-status-select"
          >
            <option value="">Set status…</option>
            {(data.statuses || []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            className="lm-btn-primary sm"
            disabled={!bulkStatus || busy}
            onClick={async () => {
              await onBulkStatus([...sel], bulkStatus);
              setSel(new Set());
              setBulkStatus("");
            }}
            data-testid="bulk-apply-btn"
          >
            Apply to {sel.size}
          </button>
          <button
            className="lm-btn-ghost sm"
            onClick={() => setSel(new Set())}
            data-testid="bulk-clear-btn"
          >
            Clear
          </button>
        </div>
      )}

      <div className="lm-ptable">
        <div className="lm-ptable-head">
          <span>
            <input
              type="checkbox"
              checked={allChecked}
              onChange={toggleAll}
              data-testid="select-all-plots"
            />
          </span>
          <span>Plot</span>
          <span>Zone</span>
          <span>Size</span>
          <span>Area</span>
          <span>Status</span>
          <span>Registry</span>
          <span style={{ textAlign: "right", paddingRight: "10px" }}>Actions</span>
        </div>
        {rows.map((p) => {
          const z = zonesById[p.zone_id];
          return (
            <div
              className={`lm-ptable-row ${sel.has(p.id) ? "sel" : ""}`}
              key={p.id}
              data-testid={`plot-row-${p.number}`}
            >
              <span>
                <input
                  type="checkbox"
                  checked={sel.has(p.id)}
                  onChange={() => toggle(p.id)}
                  data-testid={`plot-check-${p.number}`}
                />
              </span>
              <span>
                <b>Plot {p.number}</b>
                <small>{SHAPE_LABEL[p.shape] || p.shape}</small>
              </span>
              <span className="lm-zone-cell">
                {z && <i style={{ background: z.color }} />}
                {z ? (z.name || `Zone ${z.code}`) : (p.zone_id ? (String(p.zone_id).startsWith("zone-") ? "Zone" : p.zone_id) : "—")}
              </span>
              <span>{p.dimensions || "—"}</span>
              <span>
                {fmt(Math.round(p.area_sqyd || 0))} sq yd
                <small>
                  {fmt(Math.round(p.area_sqm || 0))} m² · {fmt(Math.round(p.area_sqft || 0))} ft²
                </small>
              </span>
              <span>
                <select
                  className="lm-status-select"
                  value={p.status_id}
                  disabled={busy}
                  style={{
                    "--c": (data.statuses || []).find((s) => s.id === p.status_id)?.color,
                  }}
                  onChange={(e) => onStatusChange(p, e.target.value)}
                  data-testid={`row-status-${p.number}`}
                >
                  {(data.statuses || []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </span>
              <span className="lm-reg-cell">
                <FileText size={13} /> {p.registry_count || 0}/3
              </span>
              <span style={{ display: "flex", gap: "6px", justifyContent: "flex-end", alignItems: "center" }}>
                {onEditPlot && (
                  <button
                    className="lm-link-btn"
                    style={{ color: "#173F35", fontWeight: 600 }}
                    onClick={() => onEditPlot(p)}
                    data-testid={`row-edit-plot-${p.number}`}
                    title="Edit plot dimensions, zone, price, etc."
                  >
                    <Edit3 size={13} /> Edit
                  </button>
                )}
                <button
                  className="lm-link-btn"
                  onClick={() => onOpenOnMap(p)}
                  data-testid={`row-open-map-${p.number}`}
                  title="View on Map"
                >
                  <MapPin size={13} /> Map
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
