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
    <main className="lm-public-shell">
      <header className="lm-public-nav" data-testid="public-nav">
        <Link to={ownerSlug ? `/u/${ownerSlug}` : "/"} className="lm-brand">
          <span className="lm-brand-dot" />
          {data.owner ? data.owner.name : "LiveMap"}
        </Link>
        <nav className="lm-public-links">
          <a href="#projects">Projects</a>
          <a href="#about">About</a>
          {data.owner?.phone && <a href={`tel:${data.owner.phone}`} className="lm-pill-btn" data-testid="owner-phone">Call {data.owner.phone}</a>}
        </nav>
      </header>

      <section className="lm-hero">
        <div className="lm-hero-grid" aria-hidden />
        <div className="lm-hero-copy">
          <p className="lm-eyebrow">
            {data.owner
              ? `BY ${data.owner.name.toUpperCase()}`
              : "LIVE INVENTORY · GEO-ANCHORED"}
          </p>
          <h1>
            Every plot <em>on the map,</em><br />
            every status in real time.
          </h1>
          <p className="lm-hero-lede">
            {data.owner
              ? `Explore ${data.owner.name}'s active plot inventory anchored to real coordinates.`
              : "LiveMap is an interactive plot management workspace used by developers and realtors to publish accurate, status-aware colony plans."}
          </p>
          <div className="lm-hero-actions">
            <a href="#projects" className="lm-btn-primary">
              Browse projects <ArrowUpRight size={16} />
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
            <p className="lm-eyebrow">PROJECTS · {data.colonies.length}</p>
            <h2>Open the plan. Walk the plots.</h2>
          </div>
          <span className="lm-muted">
            {data.owner
              ? "Showing only this admin's published projects."
              : "A curated catalog of live colonies across LiveMap."}
          </span>
        </div>

        {error && <div className="lm-error">{error}</div>}

        <div className="lm-project-grid">
          {data.colonies.map((c) => (
            <Link
              to={`/project/${c.slug}`}
              className="lm-project-card"
              key={c.id}
              data-testid={`project-card-${c.slug}`}
            >
              <div className="lm-project-art">
                <span className="lm-project-tag">LIVE PLAN</span>
                <div className="lm-contour" />
              </div>
              <div className="lm-project-body">
                <div>
                  <h3>{c.name}</h3>
                  <p>
                    <MapPin size={13} /> {c.location}
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
            <div className="lm-empty-state">
              <p>No published colonies yet.</p>
            </div>
          )}
        </div>
      </section>

      <footer className="lm-footer">
        <span>{data.owner ? `${data.owner.name} · Powered by LiveMap` : "LiveMap · Plot management, live."}</span>
        <span>© {new Date().getFullYear()} LiveMap Labs</span>
      </footer>
    </main>
  );
}
