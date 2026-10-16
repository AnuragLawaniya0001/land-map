import { useState } from "react";
import { MessageCircle, Share2, Search, LocateFixed, Navigation, Info, Layers, CircleDot } from "lucide-react";

function Toggle({ label, on, onChange, testId, icon: Icon }) {
  return (
    <button className={`lm-pill lm-toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)} data-testid={testId} aria-pressed={on}>
      <Icon size={15} /> <span>{label}</span>
      <i className="lm-switch"><i /></i>
    </button>
  );
}

export default function MapControls({
  showZones, setShowZones, showStatus, setShowStatus, selectedPlot,
  onWhatsApp, onShare, onSearch, onGps, onLocate, onInfo, gpsBusy, shareMsg,
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const submit = () => { if (q.trim()) { onSearch(q.trim()); setQ(""); setSearchOpen(false); } };

  return (
    <div className="lm-controls" data-testid="map-controls">
      <div className="lm-ctrl-row">
        <Toggle label="Zones" on={showZones} onChange={setShowZones} testId="toggle-zones" icon={Layers} />
        <Toggle label="Status" on={showStatus} onChange={setShowStatus} testId="toggle-status" icon={CircleDot} />
      </div>
      <div className="lm-ctrl-row">
        <button className="lm-pill lm-pill-wa" onClick={onWhatsApp} data-testid="whatsapp-btn">
          <MessageCircle size={18} />
          <span className="lm-pill-2l">
            <b>WhatsApp</b>
            <small data-testid="whatsapp-btn-sub">{selectedPlot ? `Inquire plot ${selectedPlot.number}` : "Inquire about project"}</small>
          </span>
        </button>
        <button className="lm-pill lm-pill-icon" onClick={onShare} data-testid="share-btn" title="Share">
          <Share2 size={16} />
          {shareMsg && <em className="lm-share-toast">{shareMsg}</em>}
        </button>
      </div>
      <div className="lm-ctrl-row">
        {searchOpen ? (
          <div className="lm-pill lm-pill-search">
            <Search size={15} />
            <input autoFocus placeholder="Plot number…" value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setSearchOpen(false); }}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)} data-testid="search-input" />
          </div>
        ) : (
          <button className="lm-pill" onClick={() => setSearchOpen(true)} data-testid="search-btn"><Search size={15} /> <span>Search</span></button>
        )}
        <button className={`lm-pill ${gpsBusy ? "busy" : ""}`} onClick={onGps} data-testid="gps-btn"><LocateFixed size={15} /> <span>GPS</span></button>
      </div>
      <div className="lm-ctrl-row">
        <button className="lm-pill" onClick={onInfo} data-testid="info-btn"><Info size={15} /> <span>Info</span></button>
        <button className="lm-pill" onClick={onLocate} data-testid="locate-btn"><Navigation size={15} /> <span>Locate</span></button>
      </div>
    </div>
  );
}
