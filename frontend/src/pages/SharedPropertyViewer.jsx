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
      <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", background: "#0f172a", color: "#f8fafc", fontFamily: "sans-serif" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "1.25rem", fontWeight: "600", marginBottom: "0.5rem" }}>Loading shared property...</div>
          <div style={{ color: "#94a3b8" }}>Securing access & fetching map layout</div>
        </div>
      </div>
    );
  }

  if (error || !property) {
    return (
      <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", background: "#0f172a", color: "#f8fafc", fontFamily: "sans-serif" }}>
        <div style={{ textAlign: "center", maxWidth: "420px", padding: "2rem", background: "#1e293b", borderRadius: "12px", border: "1px solid #334155" }}>
          <div style={{ fontSize: "2rem", marginBottom: "1rem" }}>🔒</div>
          <h2 style={{ fontSize: "1.25rem", fontWeight: "700", marginBottom: "0.5rem", color: "#f8fafc" }}>Property Unavailable</h2>
          <p style={{ color: "#94a3b8", fontSize: "0.95rem", lineHeight: "1.5", marginBottom: "1.5rem" }}>
            {error || "This property link is invalid or no longer available."}
          </p>
          <Link to="/" style={{ display: "inline-block", padding: "0.6rem 1.2rem", background: "#3b82f6", color: "#fff", textDecoration: "none", borderRadius: "6px", fontWeight: "600", fontSize: "0.9rem" }}>
            Return to Home
          </Link>
        </div>
      </div>
    );
  }

  const activeMedia = media[selectedImageIndex] || media[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0f172a", color: "#f8fafc", fontFamily: "sans-serif" }}>
      {/* Header */}
      <header style={{ height: "64px", background: "#1e293b", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span style={{ fontWeight: "800", fontSize: "1.2rem", color: "#60a5fa", letterSpacing: "0.05em" }}>SPACER</span>
          <span style={{ color: "#475569" }}>|</span>
          <span style={{ fontSize: "0.95rem", color: "#cbd5e1", fontWeight: "500" }}>Property Showcase</span>
        </div>
        <div>
          <span style={{ fontSize: "0.85rem", background: "#334155", color: "#94a3b8", padding: "0.3rem 0.75rem", borderRadius: "9999px", fontWeight: "600" }}>
            Controlled Share
          </span>
        </div>
      </header>

      {/* Content Body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Left Drawer: Property Information & Media Gallery */}
        <div style={{ width: "420px", background: "#1e293b", borderRight: "1px solid #334155", padding: "1.5rem", overflowY: "auto", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          <div>
            <div style={{ fontSize: "0.8rem", color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: "700", marginBottom: "0.25rem" }}>
              Plot #{property.number}
            </div>
            <h1 style={{ fontSize: "1.5rem", fontWeight: "800", color: "#f8fafc", margin: 0, lineHeight: 1.2 }}>
              {property.title || `Plot ${property.number}`}
            </h1>
            {property.facing && (
              <div style={{ fontSize: "0.85rem", color: "#60a5fa", marginTop: "0.25rem", fontWeight: "600" }}>
                {property.facing} Facing
              </div>
            )}
          </div>

          {/* Media Gallery */}
          {media.length > 0 && (
            <div style={{ background: "#0f172a", borderRadius: "8px", border: "1px solid #334155", overflow: "hidden", padding: "0.75rem" }}>
              <div style={{ height: "200px", background: "#020617", borderRadius: "6px", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: media.length > 1 ? "0.5rem" : "0" }}>
                <img
                  src={activeMedia.url}
                  alt={activeMedia.alt_text || property.title}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  loading="lazy"
                />
              </div>
              {media.length > 1 && (
                <div style={{ display: "flex", gap: "0.5rem", overflowX: "auto", paddingBottom: "0.25rem" }}>
                  {media.map((m, idx) => (
                    <button
                      key={m.id}
                      onClick={() => setSelectedImageIndex(idx)}
                      style={{
                        padding: 0, border: idx === selectedImageIndex ? "2px solid #3b82f6" : "1px solid #334155",
                        borderRadius: "4px", background: "none", cursor: "pointer", width: "56px", height: "42px", overflow: "hidden", flexShrink: 0
                      }}
                    >
                      <img src={m.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pricing Details */}
          <div style={{ background: "#0f172a", padding: "1rem", borderRadius: "8px", border: "1px solid #334155" }}>
            <div style={{ fontSize: "0.75rem", color: "#94a3b8", textTransform: "uppercase", fontWeight: "700", marginBottom: "0.25rem" }}>Total Price</div>
            <div style={{ fontSize: "1.6rem", fontWeight: "800", color: "#4ade80" }}>
              {property.price != null ? `₹${Number(property.price).toLocaleString("en-IN")}` : "Price on Request"}
            </div>
            {property.price_per_sqft != null && (
              <div style={{ fontSize: "0.85rem", color: "#94a3b8", marginTop: "0.25rem" }}>
                ₹{Number(property.price_per_sqft).toLocaleString("en-IN")} / sq.ft.
              </div>
            )}
          </div>

          {/* Description */}
          {property.description && (
            <div>
              <div style={{ fontSize: "0.8rem", color: "#94a3b8", textTransform: "uppercase", fontWeight: "700", marginBottom: "0.4rem" }}>Description</div>
              <p style={{ fontSize: "0.9rem", color: "#cbd5e1", lineHeight: 1.5, margin: 0, whiteSpace: "pre-wrap" }}>
                {property.description}
              </p>
            </div>
          )}

          {/* Property Specifications */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", background: "#0f172a", padding: "1rem", borderRadius: "8px", border: "1px solid #334155" }}>
            <div>
              <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>Area</div>
              <div style={{ fontSize: "0.95rem", fontWeight: "700", color: "#f1f5f9" }}>
                {property.area_sqft != null ? `${property.area_sqft} sq.ft` : "N/A"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>Dimensions</div>
              <div style={{ fontSize: "0.95rem", fontWeight: "700", color: "#f1f5f9" }}>
                {property.dimensions || "N/A"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>Shape</div>
              <div style={{ fontSize: "0.95rem", fontWeight: "700", color: "#f1f5f9" }}>
                {property.shape || "N/A"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>Zone</div>
              <div style={{ fontSize: "0.95rem", fontWeight: "700", color: "#f1f5f9" }}>
                {property.zone ? (property.zone.name || property.zone.code) : "N/A"}
              </div>
            </div>
          </div>

          {/* Customer Inquiry Form */}
          <div style={{ background: "#0f172a", padding: "1rem", borderRadius: "8px", border: "1px solid #334155" }}>
            <div style={{ fontSize: "0.85rem", fontWeight: "700", color: "#38bdf8", marginBottom: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Interested in this plot?
            </div>
            {inquirySuccess ? (
              <div style={{ background: "#064e3b", border: "1px solid #047857", color: "#a7f3d0", padding: "0.75rem", borderRadius: "6px", fontSize: "0.85rem", textAlign: "center" }}>
                ✓ Inquiry submitted! Our team will contact you shortly.
              </div>
            ) : (
              <form onSubmit={handleInquirySubmit} style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                {inquiryError && (
                  <div style={{ background: "#7f1d1d", color: "#fca5a5", padding: "0.4rem 0.6rem", borderRadius: "4px", fontSize: "0.8rem" }}>
                    {inquiryError}
                  </div>
                )}
                <div>
                  <input
                    type="text"
                    required
                    placeholder="Your Name *"
                    value={inquiryName}
                    onChange={(e) => setInquiryName(e.target.value)}
                    style={{ width: "100%", background: "#1e293b", border: "1px solid #475569", color: "#fff", padding: "0.45rem 0.6rem", borderRadius: "4px", fontSize: "0.85rem" }}
                  />
                </div>
                <div>
                  <input
                    type="tel"
                    required
                    placeholder="Phone Number (10 digits) *"
                    value={inquiryPhone}
                    onChange={(e) => setInquiryPhone(e.target.value)}
                    style={{ width: "100%", background: "#1e293b", border: "1px solid #475569", color: "#fff", padding: "0.45rem 0.6rem", borderRadius: "4px", fontSize: "0.85rem" }}
                  />
                </div>
                <div>
                  <input
                    type="email"
                    placeholder="Email Address (Optional)"
                    value={inquiryEmail}
                    onChange={(e) => setInquiryEmail(e.target.value)}
                    style={{ width: "100%", background: "#1e293b", border: "1px solid #475569", color: "#fff", padding: "0.45rem 0.6rem", borderRadius: "4px", fontSize: "0.85rem" }}
                  />
                </div>
                <div>
                  <textarea
                    rows={2}
                    required
                    placeholder="Your Message *"
                    value={inquiryMessage}
                    onChange={(e) => setInquiryMessage(e.target.value)}
                    style={{ width: "100%", background: "#1e293b", border: "1px solid #475569", color: "#fff", padding: "0.45rem 0.6rem", borderRadius: "4px", fontSize: "0.85rem", resize: "none" }}
                  />
                </div>
                {/* Honeypot field */}
                <input type="text" name="fax_number" style={{ display: "none" }} tabIndex={-1} autoComplete="off" />

                <button
                  type="submit"
                  disabled={submittingInquiry}
                  style={{ background: "#0284c7", color: "#fff", border: "none", padding: "0.6rem", borderRadius: "4px", fontWeight: "700", fontSize: "0.85rem", cursor: "pointer" }}
                >
                  {submittingInquiry ? "Submitting..." : "Send Inquiry"}
                </button>
              </form>
            )}
          </div>

          <div style={{ marginTop: "auto", paddingTop: "1rem", borderTop: "1px solid #334155", fontSize: "0.8rem", color: "#64748b", textAlign: "center" }}>
            Verified Property Showcase • Jasjot Sir Spacer Platform
          </div>
        </div>

        {/* Right Area: Interactive GIS Map */}
        <div style={{ flex: 1, position: "relative" }}>
          <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
        </div>
      </div>
    </div>
  );
}
