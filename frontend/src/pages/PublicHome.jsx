import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MapPin, ArrowUpRight } from "lucide-react";
import { api, errMsg } from "@/lib/api";

export default function PublicHome({ ownerSlug }) {
  const [data, setData] = useState({ owner: null, colonies: [] });
  const [error, setError] = useState("");

  useEffect(() => {
    const url = ownerSlug ? `/public/colonies?owner=${ownerSlug}` : "/public/colonies";
    api
      .get(url)
      .then((r) => setData(r.data))
      .catch((e) => setError(errMsg(e)));
  }, [ownerSlug]);

  return (
    <main className="lm-public-shell" data-testid="public-home-page">
      <header className="lm-public-nav" data-testid="public-nav">
        <Link
          to={ownerSlug ? `/u/${ownerSlug}` : "/"}
          className="lm-brand"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.75rem",
            textDecoration: "none",
            color: "#172A25",
          }}
        >
          <img
            src="/logo.png"
            alt="LiveMap"
            style={{
              width: "42px",
              height: "42px",
              objectFit: "contain",
              flexShrink: 0,
              filter: "drop-shadow(0 2px 4px rgba(23, 63, 53, 0.12))",
            }}
          />
          <span
            style={{
              fontFamily: "'Plus Jakarta Sans', 'Inter', system-ui, sans-serif",
              fontWeight: 900,
              fontSize: "1.75rem",
              letterSpacing: "-0.035em",
              color: "#0A1612",
              lineHeight: 1,
              textRendering: "geometricPrecision",
            }}
          >
            {data.owner ? data.owner.name : "LiveMap"}
          </span>
        </Link>
        <nav className="lm-public-links">
          <a href="#projects">Colonies & Projects</a>
          {data.owner?.phone && (
            <a href={`tel:${data.owner.phone}`} className="lm-btn-glow text-xs" data-testid="owner-phone">
              Call {data.owner.phone}
            </a>
          )}
          <Link to="/admin" className="lm-btn-secondary-dark text-xs">
            Admin Workspace
          </Link>
        </nav>
      </header>

      <section className="lm-hero">
        <div className="lm-hero-grid" aria-hidden />
        <div className="lm-hero-copy">
          <span className="lm-modern-eyebrow">
            {data.owner
              ? `PORTFOLIO · ${data.owner.name.toUpperCase()}`
              : "GEO-ANCHORED · INTERACTIVE GIS PARCELS"}
          </span>
          <h1>
            Every plot <em>on the live map,</em><br />
            every status in real time.
          </h1>
          <p className="lm-hero-lede">
            {data.owner
              ? `Explore ${data.owner.name}'s active layout plots anchored to true GPS coordinates with 2D & 3D visualization.`
              : "LiveMap is an interactive land intelligence platform used by developers and buyers to explore verified, status-aware colony layouts."}
          </p>
          <div className="lm-hero-actions">
            <a href="#projects" className="lm-btn-glow">
              Explore Active Projects <ArrowUpRight size={16} />
            </a>
          </div>
        </div>
        <div className="lm-hero-map-art" aria-hidden>
          <div className="lm-hero-plots">
            {Array.from({ length: 18 }).map((_, i) => (
              <span key={i} className={`lm-chip-${i % 4}`} />
            ))}
          </div>
        </div>
      </section>

      <section id="projects" className="lm-projects">
        <div className="lm-section-head">
          <div>
            <span className="lm-modern-eyebrow">
              Published Colonies · {data.colonies.length}
            </span>
            <h2 className="text-2xl font-bold font-serif text-white mt-1">Open the plan. Walk the plots.</h2>
          </div>
          <span className="text-xs text-slate-400">
            {data.owner
              ? "Showing only this developer's published colonies."
              : "Curated catalog of geo-anchored interactive colonies."}
          </span>
        </div>

        {error && (
          <div className="lm-badge-danger p-3 rounded-xl mb-4 text-xs font-medium w-full">
            {error}
          </div>
        )}

        <div className="lm-project-grid">
          {data.colonies.map((c) => (
            <Link
              to={`/project/${c.slug}`}
              className="lm-project-card group"
              key={c.id}
              data-testid={`project-card-${c.slug}`}
            >
              <div className="lm-project-art">
                <span className="lm-project-tag">LIVE PLAN</span>
                <div className="lm-contour" />
              </div>
              <div className="lm-project-body">
                <div>
                  <h3 className="group-hover:text-emerald-400 transition-colors">{c.name}</h3>
                  <p>
                    <MapPin size={13} className="text-emerald-400 shrink-0" /> {c.location || "Location available on map"}
                  </p>
                </div>
                <div className="lm-project-meta">
                  <span>{c.plot_count}</span>
                  <small>plots</small>
                </div>
              </div>
            </Link>
          ))}
          {!data.colonies.length && !error && (
            <div className="lm-empty-state col-span-full py-16 text-center text-slate-400">
              <p>No published colonies yet.</p>
            </div>
          )}
        </div>
      </section>

      <footer className="lm-footer">
        <span>{data.owner ? `${data.owner.name} · Powered by LiveMap GIS` : "LiveMap GIS · Real-Estate Plot Intelligence"}</span>
        <span>© {new Date().getFullYear()} LiveMap</span>
      </footer>
    </main>
  );
}
