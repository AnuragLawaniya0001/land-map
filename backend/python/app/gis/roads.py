"""Find the nearest mapped road to a colony boundary using OSM raster tiles (Overpass is not reachable)."""
import math
from io import BytesIO

import numpy as np
import requests
from PIL import Image
from shapely.geometry import Polygon, Point, LineString

Z = 17
TILE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
UA = {"User-Agent": "LiveMap/1.0 (colony entrance detection)"}


def _tile_xy(lat, lng):
    n = 2 ** Z
    fx = (lng + 180) / 360 * n
    fy = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return fx, fy


def _px_to_ll(px, py, x0, y0):
    n = 2 ** Z
    X, Y = x0 + px / 256, y0 + py / 256
    lng = X / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * Y / n))))
    return lat, lng


ROAD_COLORS = [(255, 255, 255), (247, 250, 191), (252, 214, 164), (249, 178, 156), (232, 146, 162)]
# residential/tertiary, secondary, primary, trunk, motorway, living street (OSM Carto)


def _road_mask(img):
    a = np.asarray(img.convert("RGB")).astype(int)
    mask = np.zeros(a.shape[:2], dtype=bool)
    for cr, cg, cb in ROAD_COLORS:
        mask |= (np.abs(a[..., 0] - cr) <= 4) & (np.abs(a[..., 1] - cg) <= 4) & (np.abs(a[..., 2] - cb) <= 4)
    # erode once to drop label halos / thin artefacts, keep real road bodies
    m = mask.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            m &= np.roll(np.roll(mask, dy, 0), dx, 1)
    return m


def nearest_road(boundary_ring, search_px=768):
    """boundary_ring: [[lng, lat], ...]. Returns dict(gate=(lat,lng), road=(lat,lng), dist_m) or None."""
    poly = Polygon([(lng, lat) for lng, lat in boundary_ring])
    c = poly.centroid
    fx, fy = _tile_xy(c.y, c.x)
    tiles = search_px // 256
    x0, y0 = int(fx) - tiles // 2, int(fy) - tiles // 2
    img = Image.new("RGB", (256 * tiles, 256 * tiles), (242, 239, 233))
    try:
        for i in range(tiles):
            for j in range(tiles):
                r = requests.get(TILE.format(z=Z, x=x0 + i, y=y0 + j), headers=UA, timeout=12)
                if r.ok:
                    img.paste(Image.open(BytesIO(r.content)).convert("RGB"), (i * 256, j * 256))
    except Exception:
        return None
    mask = _road_mask(img)
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    # boundary in pixel space
    bpx = []
    for lng, lat in boundary_ring:
        tx, ty = _tile_xy(lat, lng)
        bpx.append(((tx - x0) * 256, (ty - y0) * 256))
    bpoly = Polygon(bpx)
    road_pts = np.column_stack([xs, ys]).astype(float)
    # exclude road pixels inside the colony itself (the layout's own roads are not on OSM, but be safe)
    inside = np.array([bpoly.contains(Point(x, y)) for x, y in road_pts[:: max(1, len(road_pts) // 4000)]])
    sample = road_pts[:: max(1, len(road_pts) // 4000)][~inside]
    if len(sample) == 0:
        return None
    ring = LineString(list(bpoly.exterior.coords))
    d = np.array([ring.distance(Point(x, y)) for x, y in sample])
    k = int(d.argmin())
    rx, ry = sample[k]
    gate = ring.interpolate(ring.project(Point(rx, ry)))
    m_per_px = 156543.03 * math.cos(math.radians(c.y)) / (2 ** Z)
    return {
        "gate": _px_to_ll(gate.x, gate.y, x0, y0),
        "road": _px_to_ll(rx, ry, x0, y0),
        "dist_m": float(d[k]) * m_per_px,
    }


def entrance_fields(boundary_geo, plot_geos=None, width_m=12.0):
    """Build entrance / entry_road / entry_centerline GeoJSON for a boundary polygon, or {} if no road found.
    The gate is snapped to the boundary point nearest the road that opens onto internal road space (not a plot)."""
    ring = boundary_geo["coordinates"][0]
    hit = nearest_road(ring)
    if not hit:
        return {}
    (rlat, rlng) = hit["road"]
    kx, ky = 111320 * math.cos(math.radians(rlat)), 110574
    to_m = lambda lng, lat: ((lng - rlng) * kx, (lat - rlat) * ky)  # noqa: E731
    bpoly = Polygon([to_m(lng, lat) for lng, lat in ring])
    plots = [Polygon([to_m(lng, lat) for lng, lat in g["coordinates"][0]]) for g in (plot_geos or []) if g]
    ext_ring = LineString(list(bpoly.exterior.coords))
    cen = bpoly.centroid
    best, best_score = None, 1e18
    n = max(8, int(ext_ring.length / 2))
    for i in range(n):
        p = ext_ring.interpolate(i / n, normalized=True)
        # point 8 m inside the compound along the direction to the centroid
        vx, vy = cen.x - p.x, cen.y - p.y
        L = math.hypot(vx, vy) or 1
        q = Point(p.x + vx / L * 8, p.y + vy / L * 8)
        blocked = any(pl.contains(q) for pl in plots)
        score = math.hypot(p.x, p.y) + (400 if blocked else 0)
        if score < best_score:
            best, best_score = p, score
    glat, glng = rlat + best.y / ky, rlng + best.x / kx
    dx, dy = -best.x, -best.y
    L = math.hypot(dx, dy)
    out = {"entrance": {"type": "Point", "coordinates": [round(glng, 7), round(glat, 7)]}, "entry_width_m": width_m,
           "entry_distance_m": round(L, 1)}
    if L < 3 or L > 400:
        return out
    ux, uy = dx / L, dy / L
    nx, ny = -uy * width_m / 2, ux * width_m / 2
    ext = 4.0  # reach a little past the road centreline
    inset = 6.0  # start inside the compound so the gate reads as part of the colony
    pts = [(-ux * inset + nx, -uy * inset + ny), (ux * (L + ext) + nx, uy * (L + ext) + ny),
           (ux * (L + ext) - nx, uy * (L + ext) - ny), (-ux * inset - nx, -uy * inset - ny)]
    to_ll = lambda x, y: [round(glng + x / kx, 7), round(glat + y / ky, 7)]  # noqa: E731
    ring_out = [to_ll(*p) for p in pts]
    ring_out.append(ring_out[0])
    out["entry_road"] = {"type": "Polygon", "coordinates": [ring_out]}
    out["entry_centerline"] = {"type": "LineString", "coordinates": [to_ll(-ux * inset, -uy * inset), to_ll(ux * (L + ext), uy * (L + ext))]}
    return out
