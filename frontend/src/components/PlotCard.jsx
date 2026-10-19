import { useState } from "react";
import { X, MessageCircle, Navigation, MapPin, Image as ImageIcon, Share2 } from "lucide-react";
import { areaConversions, fmt } from "@/lib/geo";
import { plotCenter } from "@/components/InteractiveMap";

export const SHAPE_LABEL = { 
  rectangular: "Rectangular", 
  diagonal: "Diagonal", 
  polygon: "Irregular", 
  triangular: "Triangular" 
};

export function estimateDimsText(plot, a) {
  if (plot.dimensions && plot.dimensions !== "—") {
    return plot.dimensions.replace(/approx\.?\s*/i, "").trim();
  }
  if (plot.frontage_declared && plot.depth_declared) {
    return `${plot.frontage_declared}M × ${plot.depth_declared}M`;
  }
  if (a?.sqm && a.sqm > 0) {
    // Standard real-estate ratio ~1:1.33
    const width = Math.round(Math.sqrt(a.sqm / 1.33) * 10) / 10;
    const depth = Math.round((a.sqm / width) * 10) / 10;
    return `${width}M × ${depth}M`;
  }
  return "9M × 12M";
}

export function PlotSummary({ plot, status, zone, showGps = true }) {
  const a = (plot.area_sqft || plot.area_sqyd) ? {
    sqft: Math.round(plot.area_sqft || (plot.area_sqyd * 9)),
    sqyd: Math.round(plot.area_sqyd || (plot.area_sqft / 9)),
    sqm: Math.round(plot.area_sqm || (plot.area_sqft * 0.092903)),
  } : areaConversions(plot.area_sqm || 0);
  const c = plotCenter(plot);

  const formatPrice = (val) => {
    if (!val || isNaN(val)) return null;
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(val);
  };

  const formattedPrice = formatPrice(plot.price);
  const formattedRate = formatPrice(plot.price_per_sqft);
  const dimsText = estimateDimsText(plot, a);

  return (
    <div className="lm-ps space-y-3" data-testid="plot-summary">
      {/* 3-Column Key Metric Specs Grid (Area | Dimensions | Facing) */}
      <div className="lm-modern-specs-grid" data-testid="plot-modern-specs">
        <div className="lm-modern-spec-col">
          <span className="lm-modern-spec-val" data-testid="plot-sqft">
            {a.sqft ? `${fmt(a.sqft)} sqft` : "—"}
          </span>
          <span className="lm-modern-spec-sub">{a.sqyd ? `${fmt(a.sqyd)} sqyd` : "Area"}</span>
        </div>

        <div className="lm-modern-spec-col">
          <span className="lm-modern-spec-val" data-testid="plot-dims">
            {dimsText}
          </span>
          <span className="lm-modern-spec-sub">Dimensions</span>
        </div>

        <div className="lm-modern-spec-col">
          <span className="lm-modern-spec-val" data-testid="plot-facing-val">
            {plot.facing || "East"}
          </span>
          <span className="lm-modern-spec-sub">Facing</span>
        </div>
      </div>

      {/* Price & Primary details strip if set */}
      {formattedPrice && (
        <div className="lm-ps-price-card" data-testid="plot-price-row">
          <div>
            <span className="lm-ps-price-label">Asking Price</span>
            <div className="lm-ps-price-val" data-testid="plot-price">{formattedPrice}</div>
          </div>
          {formattedRate && (
            <div className="text-right">
              <span className="lm-ps-price-label">Rate</span>
              <div className="lm-ps-rate-val" data-testid="plot-price-rate">{formattedRate} / sq.ft</div>
            </div>
          )}
        </div>
      )}

      {/* Additional details (Zone, Shape) */}
      <div className="lm-ps-specs-grid">
        <div className="lm-ps-spec-item">
          <span className="lm-ps-spec-label">Zone</span>
          <span className="lm-ps-spec-val" data-testid="plot-zone">
            {zone && <span className="lm-ps-dot" style={{ background: zone.color }} />}
            {zone?.name || "Main Sector"}
          </span>
        </div>

        <div className="lm-ps-spec-item">
          <span className="lm-ps-spec-label">Layout Shape</span>
          <span className="lm-ps-spec-val" data-testid="plot-shape">
            {SHAPE_LABEL[plot.shape] || plot.shape || "Rectangular"}
          </span>
        </div>
      </div>

      {/* Location / Navigation footer */}
      {showGps && c && (
        <div className="lm-ps-gps-bar">
          <div className="lm-ps-gps-coords">
            <MapPin size={13} className="text-emerald-400 shrink-0" />
            <span className="mono" data-testid="plot-gps">{c[0].toFixed(5)}, {c[1].toFixed(5)}</span>
          </div>
          <a
            className="lm-ps-nav-link"
            target="_blank"
            rel="noreferrer"
            data-testid="plot-navigate"
            href={`https://www.google.com/maps/dir/?api=1&destination=${c[0]},${c[1]}`}
          >
            <Navigation size={12} /> Directions
          </a>
        </div>
      )}
    </div>
  );
}

export default function PlotCard({
  plot,
  status,
  zone,
  onClose,
  onWhatsApp,
  onEnquire,
  onMedia,
  onShare,
}) {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    if (onShare) {
      onShare();
      return;
    }
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: `Plot ${plot.number}`, url });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* ignore */
    }
  };

  const statusName = status?.name?.toUpperCase() || "AVAILABLE";
  const statusColor = status?.color || "#10b981";

  return (
    <div className="lm-plot-card lm-plot-card-modern" data-testid="plot-card">
      {/* Header with Title and Quick Action Icons */}
      <div className="lm-plot-card-head">
        <div className="flex items-center gap-2">
          <h2 data-testid="plot-card-number">Plot {plot.number}</h2>
        </div>
        <div className="flex items-center gap-1.5">
          {onMedia && (
            <button
              className="lm-card-icon-btn"
              onClick={onMedia}
              title="View plot photos"
              aria-label="View media"
            >
              <ImageIcon size={16} />
            </button>
          )}
          <button
            className="lm-card-icon-btn"
            onClick={handleShare}
            title={copied ? "Link Copied!" : "Share plot"}
            aria-label="Share plot"
          >
            <Share2 size={16} />
          </button>
          <button
            className="lm-close-btn"
            onClick={onClose}
            data-testid="close-plot-card"
            aria-label="Close plot card"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Modern Status Badge Pill */}
      <div className="lm-status-row-wrap">
        <span
          className="lm-modern-status-badge"
          style={{
            backgroundColor: `${statusColor}18`,
            color: statusColor,
            borderColor: `${statusColor}40`,
          }}
          data-testid="plot-status"
        >
          <span
            className="lm-status-dot-glowing"
            style={{
              backgroundColor: statusColor,
              boxShadow: `0 0 8px ${statusColor}`,
            }}
          />
          {statusName}
        </span>
        {copied && <span className="text-xs text-emerald-400 font-medium">Link copied!</span>}
      </div>

      {/* Plot Details & 3-Column Spec Grid */}
      <PlotSummary plot={plot} status={status} zone={zone} />

      {/* Dual Modern Action CTA Buttons */}
      <div className="lm-modern-cta-row">
        <button
          className="lm-modern-btn-chat"
          onClick={onWhatsApp}
          data-testid="plot-card-whatsapp"
        >
          <MessageCircle size={16} />
          <span>Chat now</span>
        </button>
        <button
          className="lm-modern-btn-enquire"
          onClick={onEnquire || onWhatsApp}
          data-testid="plot-card-enquire"
        >
          <span>Enquire now</span>
        </button>
      </div>
    </div>
  );
}
