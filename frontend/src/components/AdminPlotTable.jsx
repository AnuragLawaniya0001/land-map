import { useMemo, useState } from "react";
import { MapPin, FileText, CheckSquare } from "lucide-react";
import { fmt } from "@/lib/geo";
import { SHAPE_LABEL } from "@/components/PlotCard";

export default function AdminPlotTable({ data, onStatusChange, onBulkStatus, onOpenOnMap, busy }) {
  const [sel, setSel] = useState(new Set());
  const [zoneF, setZoneF] = useState("");
  const [statusF, setStatusF] = useState("");
  const [q, setQ] = useState("");
  const [bulkStatus, setBulkStatus] = useState("");

  const zonesById = Object.fromEntries(data.zones.map((z) => [z.id, z]));
  const rows = useMemo(() => data.plots
    .filter((p) => (!zoneF || p.zone_id === zoneF) && (!statusF || p.status_id === statusF) && (!q || p.number.includes(q.trim())))
    .sort((a, b) => Number(a.number) - Number(b.number) || a.number.localeCompare(b.number)), [data, zoneF, statusF, q]);

  const allChecked = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const toggleAll = () => setSel(allChecked ? new Set() : new Set(rows.map((r) => r.id)));
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="lm-plist" data-testid="admin-plot-list">
      <div className="lm-plist-bar">
        <input className="lm-input" placeholder="Search plot no." value={q} onChange={(e) => setQ(e.target.value)} data-testid="plot-list-search" />
        <select className="lm-input" value={zoneF} onChange={(e) => setZoneF(e.target.value)} data-testid="plot-list-zone-filter">
          <option value="">All zones</option>
          {data.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
        </select>
        <select className="lm-input" value={statusF} onChange={(e) => setStatusF(e.target.value)} data-testid="plot-list-status-filter">
          <option value="">All statuses</option>
          {data.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span className="lm-plist-count" data-testid="plot-list-count">{rows.length} plots</span>
      </div>

      {sel.size > 0 && (
        <div className="lm-bulk-bar" data-testid="bulk-bar">
          <CheckSquare size={15} /> <b>{sel.size}</b> selected →
          <select className="lm-input" value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} data-testid="bulk-status-select">
            <option value="">Set status…</option>
            {data.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button className="lm-btn-primary sm" disabled={!bulkStatus || busy}
            onClick={async () => { await onBulkStatus([...sel], bulkStatus); setSel(new Set()); setBulkStatus(""); }} data-testid="bulk-apply-btn">
            Apply to {sel.size}
          </button>
          <button className="lm-btn-ghost sm" onClick={() => setSel(new Set())} data-testid="bulk-clear-btn">Clear</button>
        </div>
      )}

      <div className="lm-ptable">
        <div className="lm-ptable-head">
          <span><input type="checkbox" checked={allChecked} onChange={toggleAll} data-testid="select-all-plots" /></span>
          <span>Plot</span><span>Zone</span><span>Size</span><span>Area</span><span>Status</span><span>Registry</span><span />
        </div>
        {rows.map((p) => {
          const z = zonesById[p.zone_id];
          return (
            <div className={`lm-ptable-row ${sel.has(p.id) ? "sel" : ""}`} key={p.id} data-testid={`plot-row-${p.number}`}>
              <span><input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} data-testid={`plot-check-${p.number}`} /></span>
              <span><b>Plot {p.number}</b><small>{SHAPE_LABEL[p.shape] || p.shape}</small></span>
              <span className="lm-zone-cell">{z && <i style={{ background: z.color }} />}{z?.name}</span>
              <span>{p.dimensions}</span>
              <span>{fmt(Math.round(p.area_sqyd))} sq yd<small>{fmt(Math.round(p.area_sqm))} m² · {fmt(Math.round(p.area_sqft))} ft²</small></span>
              <span>
                <select className="lm-status-select" value={p.status_id} disabled={busy}
                  style={{ "--c": data.statuses.find((s) => s.id === p.status_id)?.color }}
                  onChange={(e) => onStatusChange(p, e.target.value)} data-testid={`row-status-${p.number}`}>
                  {data.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </span>
              <span className="lm-reg-cell"><FileText size={13} /> {p.registry_count || 0}/3</span>
              <span><button className="lm-link-btn" onClick={() => onOpenOnMap(p)} data-testid={`row-open-map-${p.number}`}><MapPin size={13} /> Map</button></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
