import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export default function SharedPropertyViewer() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [property, setProperty] = useState(null);
  const [media, setMedia] = useState([]);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  // Inquiry Form State
  const [inquiryName, setInquiryName] = useState("");
  const [inquiryPhone, setInquiryPhone] = useState("");
  const [inquiryEmail, setInquiryEmail] = useState("");
  const [inquiryMessage, setInquiryMessage] = useState("Hi, I am interested in this property. Please contact me with details.");
  const [submittingInquiry, setSubmittingInquiry] = useState(false);
  const [inquirySuccess, setInquirySuccess] = useState(false);
  const [inquiryError, setInquiryError] = useState(null);

  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);

    fetch(`/api/share/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "This property link is invalid or no longer available.");
        }
        return res.json();
      })
      .then((data) => {
        if (isMounted) {
          setProperty(data.property);
          setMedia(data.media || []);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message);
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [token]);

  useEffect(() => {
    if (!property || !mapContainerRef.current) return;

    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    const geom = property.geometry;
    if (!geom || !geom.coordinates) return;

    let center = [20.5937, 78.9629];
    if (property.centroid && Array.isArray(property.centroid.coordinates)) {
      center = [property.centroid.coordinates[1], property.centroid.coordinates[0]];
    }

    const map = L.map(mapContainerRef.current, {
      center: center,
      zoom: 18,
      zoomControl: true,
      attributionControl: false
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 21,
      maxNativeZoom: 19
    }).addTo(map);

    const geoLayer = L.geoJSON(geom, {
      style: {
        color: "#6366f1",
        weight: 3,
        fillColor: "#818cf8",
        fillOpacity: 0.45
      }
    }).addTo(map);

    if (geoLayer.getBounds().isValid()) {
      map.fitBounds(geoLayer.getBounds(), { padding: [40, 40] });
    }

    mapInstanceRef.current = map;

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [property]);

  const handleInquirySubmit = (e) => {
    e.preventDefault();
    setSubmittingInquiry(true);
    setInquiryError(null);
    setInquirySuccess(false);

    fetch("/api/public/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        share_token: token,
        name: inquiryName,
        phone: inquiryPhone,
        email: inquiryEmail,
        message: inquiryMessage,
        fax_number: "", // Honeypot field must stay empty
      }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "Could not submit inquiry");
        return body;
      })
      .then(() => {
        setInquirySuccess(true);
        setInquiryName("");
        setInquiryPhone("");
        setInquiryEmail("");
      })
      .catch((err) => setInquiryError(err.message))
      .finally(() => setSubmittingInquiry(false));
  };

  if (loading) {
    return (
      <div className="lm-page-container flex items-center justify-center min-h-screen text-slate-100 font-sans">
        <div className="text-center p-8 lm-modern-card max-w-sm">
          <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <div className="text-lg font-bold text-white mb-1">Loading Shared Property</div>
          <div className="text-xs text-slate-400">Verifying secure token & fetching spatial layout…</div>
        </div>
      </div>
    );
  }

  if (error || !property) {
    return (
      <div className="lm-page-container flex items-center justify-center min-h-screen text-slate-100 font-sans p-4">
        <div className="text-center max-w-md p-8 lm-modern-card">
          <div className="w-14 h-14 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center mx-auto mb-4 text-2xl">
            🔒
          </div>
          <h2 className="text-xl font-bold text-white mb-2">Property Unavailable</h2>
          <p className="text-slate-400 text-sm leading-relaxed mb-6">
            {error || "This property link is invalid or no longer available."}
          </p>
          <Link to="/" className="lm-btn-glow inline-flex items-center justify-center">
            Return to LiveMap
          </Link>
        </div>
      </div>
    );
  }

  const activeMedia = media[selectedImageIndex] || media[0];

  return (
    <div className="flex flex-col h-screen bg-[#F6F4EE] text-[#172A25] font-sans overflow-hidden">
      {/* Sleek Header */}
      <header className="h-16 bg-[#FFFFFF]/95 backdrop-blur-md border-b border-[#E8E2D6] flex items-center justify-between px-6 z-20">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-[#173F35] shadow-[0_0_10px_rgba(23,63,53,0.3)]" />
          <span className="font-extrabold text-base tracking-wider text-[#172A25]">
            LIVEMAP
          </span>
          <span className="text-[#9CA3AF]">/</span>
          <span className="text-xs font-semibold text-[#6B7280] uppercase tracking-widest">
            Property Showcase
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="px-3 py-1 rounded-full text-[11px] font-bold tracking-wide uppercase bg-[#173F35]/10 border border-[#173F35]/25 text-[#173F35]">
            Verified Share Link
          </span>
        </div>
      </header>

      {/* Main Split Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Drawer: Property Information & Media Gallery */}
        <div className="w-[430px] bg-[#FFFFFF] border-r border-[#E8E2D6] p-6 overflow-y-auto flex flex-col gap-5 z-10 shrink-0">
          <div>
            <div className="text-[11px] font-mono font-bold text-[#173F35] uppercase tracking-widest mb-1">
              Plot #{property.number}
            </div>
            <h1 className="text-2xl font-black text-[#172A25] tracking-tight leading-tight">
              {property.title || `Plot ${property.number}`}
            </h1>
            {property.facing && (
              <div className="text-xs font-semibold text-[#0D1B2A] mt-1 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#0D1B2A]" />
                {property.facing} Facing
              </div>
            )}
          </div>

          {/* Media Gallery */}
          {media.length > 0 && (
            <div className="p-3 bg-[#F6F4EE] rounded-2xl border border-[#E8E2D6]">
              <div className="h-52 bg-black/10 rounded-xl overflow-hidden flex items-center justify-center mb-3 border border-[#E8E2D6]">
                <img
                  src={activeMedia.url}
                  alt={activeMedia.alt_text || property.title}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </div>
              {media.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {media.map((m, idx) => (
                    <button
                      key={m.id}
                      onClick={() => setSelectedImageIndex(idx)}
                      className={`p-0 rounded-lg overflow-hidden shrink-0 transition-all ${
                        idx === selectedImageIndex
                          ? "ring-2 ring-[#173F35] scale-[1.02]"
                          : "opacity-60 hover:opacity-100 border border-[#E8E2D6]"
                      }`}
                      style={{ width: "64px", height: "46px" }}
                    >
                      <img src={m.url} alt="" className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pricing Highlight */}
          <div className="p-4 rounded-2xl bg-[#F6F4EE] border border-[#E8E2D6]">
            <div className="text-[10px] font-mono uppercase font-bold text-[#6B7280] tracking-wider mb-1">Total Valuation</div>
            <div className="text-2xl font-black text-[#173F35] tracking-tight">
              {property.price != null ? `₹${Number(property.price).toLocaleString("en-IN")}` : "Price on Request"}
            </div>
            {property.price_per_sqft != null && (
              <div className="text-xs text-[#6B7280] mt-1 font-mono">
                ₹{Number(property.price_per_sqft).toLocaleString("en-IN")} / sq.ft.
              </div>
            )}
          </div>

          {/* Description */}
          {property.description && (
            <div>
              <div className="text-[11px] font-mono uppercase font-bold text-[#6B7280] tracking-wider mb-1.5">Overview</div>
              <p className="text-xs text-[#374151] leading-relaxed m-0 whitespace-pre-wrap bg-[#F6F4EE] p-3.5 rounded-xl border border-[#E8E2D6]">
                {property.description}
              </p>
            </div>
          )}

          {/* Property Specifications Grid */}
          <div className="grid grid-cols-2 gap-2.5 bg-[#F6F4EE] p-3.5 rounded-2xl border border-[#E8E2D6]">
            <div className="p-2.5 rounded-xl bg-[#FFFFFF] border border-[#E8E2D6]">
              <div className="text-[10px] text-[#6B7280] uppercase font-mono">Area</div>
              <div className="text-xs font-bold text-[#172A25] mt-0.5">
                {property.area_sqft != null ? `${property.area_sqft} sq.ft` : "—"}
              </div>
            </div>
            <div className="p-2.5 rounded-xl bg-[#FFFFFF] border border-[#E8E2D6]">
              <div className="text-[10px] text-[#6B7280] uppercase font-mono">Dimensions</div>
              <div className="text-xs font-bold text-[#172A25] mt-0.5">
                {property.dimensions || "—"}
              </div>
            </div>
            <div className="p-2.5 rounded-xl bg-[#FFFFFF] border border-[#E8E2D6]">
              <div className="text-[10px] text-[#6B7280] uppercase font-mono">Shape</div>
              <div className="text-xs font-bold text-[#172A25] mt-0.5">
                {property.shape || "Rectangular"}
              </div>
            </div>
            <div className="p-2.5 rounded-xl bg-[#FFFFFF] border border-[#E8E2D6]">
              <div className="text-[10px] text-[#6B7280] uppercase font-mono">Sector / Zone</div>
              <div className="text-xs font-bold text-[#172A25] mt-0.5">
                {property.zone ? (property.zone.name || property.zone.code) : "Sector 1"}
              </div>
            </div>
          </div>

          {/* Customer Inquiry Form */}
          <div className="p-4 rounded-2xl bg-[#FFFFFF] border border-[#E8E2D6] shadow-sm">
            <div className="text-xs font-bold text-[#173F35] uppercase tracking-wider mb-3 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#173F35]" />
              Express Interest In Plot #{property.number}
            </div>

            {inquirySuccess ? (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3.5 rounded-xl text-xs font-medium text-center">
                ✓ Inquiry submitted successfully! Our sales team will get in touch with you shortly.
              </div>
            ) : (
              <form onSubmit={handleInquirySubmit} className="flex flex-col gap-2.5">
                {inquiryError && (
                  <div className="bg-rose-50 border border-rose-200 text-rose-800 p-2.5 rounded-lg text-xs">
                    {inquiryError}
                  </div>
                )}
                <div>
                  <input
                    type="text"
                    required
                    placeholder="Your Full Name *"
                    value={inquiryName}
                    onChange={(e) => setInquiryName(e.target.value)}
                    className="lm-modern-input w-full text-xs"
                  />
                </div>
                <div>
                  <input
                    type="tel"
                    required
                    placeholder="Phone Number (10 digits) *"
                    value={inquiryPhone}
                    onChange={(e) => setInquiryPhone(e.target.value)}
                    className="lm-modern-input w-full text-xs"
                  />
                </div>
                <div>
                  <input
                    type="email"
                    placeholder="Email Address (Optional)"
                    value={inquiryEmail}
                    onChange={(e) => setInquiryEmail(e.target.value)}
                    className="lm-modern-input w-full text-xs"
                  />
                </div>
                <div>
                  <textarea
                    rows={2}
                    required
                    placeholder="Your Message *"
                    value={inquiryMessage}
                    onChange={(e) => setInquiryMessage(e.target.value)}
                    className="lm-modern-input w-full text-xs resize-none"
                  />
                </div>
                {/* Honeypot field */}
                <input type="text" name="fax_number" style={{ display: "none" }} tabIndex={-1} autoComplete="off" />

                <button
                  type="submit"
                  disabled={submittingInquiry}
                  className="lm-btn-glow w-full justify-center text-xs py-2.5 mt-1"
                >
                  {submittingInquiry ? "Submitting Inquiry…" : "Submit Direct Inquiry"}
                </button>
              </form>
            )}
          </div>

          <div className="mt-auto pt-4 border-t border-[#F0ECE1] text-[11px] text-[#6B7280] text-center">
            Verified Colony Showcase • LiveMap Spatial Platform
          </div>
        </div>

        {/* Right Area: Interactive GIS Map */}
        <div className="flex-1 relative bg-[#F6F4EE]">
          <div ref={mapContainerRef} className="w-full h-full" />
        </div>
      </div>
    </div>
  );
}
