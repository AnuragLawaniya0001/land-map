"""Durga Enclave demo layout: irregular 5-corner parcel on open farmland south-west of
the Darapura main road (Padra, Vadodara). Local metre frame: +y points toward the main
road (the frame is rotated so the road runs along the top edge)."""
from math import cos, sin, radians

CENTER = {"lat": 22.222876, "lng": 73.105581}
LAT_PER_M = 1 / 110574
LNG_PER_M = 1 / (111320 * cos(radians(CENTER["lat"])))
ROT = radians(55.5)  # +y of local frame = bearing 55.5° (perpendicular to the main road)


def _rot(x, y, rot=None):
    r = ROT if rot is None else rot
    return x * cos(r) + y * sin(r), -x * sin(r) + y * cos(r)


def _lnglat(x, y, center=None, rot=None):
    c = center or CENTER
    rx, ry = _rot(x, y, rot)
    lng_per_m = 1 / (111320 * cos(radians(c["lat"])))
    return [round(c["lng"] + rx * lng_per_m, 7), round(c["lat"] + ry * LAT_PER_M, 7)]


LAYOUT_VERSION = 6
MAIN_ROAD_Y = 110  # centreline of the asphalt main road in the local frame

# Pentagon parcel (clockwise). Top edge runs parallel to the main road.
BOUNDARY = [(-75, 78), (85, 88), (100, -40), (10, -105), (-95, -50)]

# Roads: (name, x1, y1, x2, y2)
ROADS = [
    ("9 MT. WIDE ROAD", -4.5, 31, 4.5, 95),           # spine from gate
    ("9 MT. WIDE ROAD", -100, 22, 100, 31),           # top arterial
    ("7.5 MT. WIDE ROAD", -100, 49, 100, 56.5),       # north internal
    ("7.5 MT. WIDE ROAD", -100, -33.5, 100, -26),     # bottom arterial
    ("7.5 MT. WIDE ROAD", -60, -59, 62.5, -51.5),     # south internal
    ("PARK RING ROAD", -35.5, -33.5, -28, 29.5),      # ring left
    ("PARK RING ROAD", 28, -33.5, 35.5, 29.5),        # ring right
    ("7.5 MT. WIDE ROAD", -60, -105, -52.5, 95),      # west road
    ("7.5 MT. WIDE ROAD", 55, -105, 62.5, 97),        # east road
    ("7.5 MT. WIDE ROAD", -4.5, -105, 4.5, -33.5),    # spine south
]
ENTRY_ROAD = (-6, 84, 6, MAIN_ROAD_Y + 5)   # gate out to the main road
ENTRANCE = (0, 86)

ZONES = [
    ("A", "Zone A", "#35c7b4", (-100, 100, 31, 100)),
    ("B", "Zone B", "#f06b5f", (35.5, 110, -105, 31)),
    ("C", "Zone C", "#f2b84b", (-110, -35.5, -105, 31)),
    ("D", "Zone D", "#55a8ff", (-35.5, 35.5, -105, -33.5)),
]

# Plot rows. "h": (zone, x_start, x_end, y_front, depth, dir, width)
#            "v": (zone, y_start, y_end, x_front, depth, dir, height)
ROWS = [
    ("h", "A", -80, -60, 31, 18, +1, 12), ("h", "A", -52.5, -4.5, 31, 18, +1, 12),
    ("h", "A", 4.5, 55, 31, 18, +1, 12), ("h", "A", 62.5, 92, 31, 18, +1, 12),
    ("h", "A", -80, -60, 56.5, 40, +1, 13), ("h", "A", -52.5, -4.5, 56.5, 40, +1, 13),
    ("h", "A", 4.5, 55, 56.5, 40, +1, 13), ("h", "A", 62.5, 92, 56.5, 40, +1, 13),
    ("v", "B", -100, 22, 62.5, 45, +1, 12.5),
    ("v", "B", -26, 22, 55, 19.5, -1, 12),
    ("v", "C", -100, 22, -60, 30, -1, 12.5),
    ("v", "C", -26, 22, -52.5, 17, +1, 12),
    ("h", "D", -52.5, -4.5, -33.5, 18, -1, 12), ("h", "D", 4.5, 55, -33.5, 18, -1, 12),
    ("h", "D", -52.5, -4.5, -59, 19, -1, 12), ("h", "D", 4.5, 55, -59, 19, -1, 12),
]

# Hand-placed odd plots (triangles at the south tip), local metres
EXTRA_PLOTS = [
    ("D", [(4.5, -78), (26, -78), (4.5, -97)]),
    ("D", [(26, -78), (44, -78), (26, -89)]),
]

GREENS = [
    ("Central Park", (-28, 28, -26, 22)),
    ("Green Belt", (-110, -90, -105, 95)),
    ("Kids Corner", (-60, -4.5, -110, -78)),
]

STATUS_CYCLE = ["available", "available", "sold", "available", "hold", "available", "reserved", "sold", "available", "available", "blocked"]


def _inset(poly, factor):
    cx = sum(p[0] for p in poly) / len(poly)
    cy = sum(p[1] for p in poly) / len(poly)
    return [(cx + (x - cx) * factor, cy + (y - cy) * factor) for x, y in poly]


def _clip(subject, clip):
    """Sutherland-Hodgman clip of subject polygon against convex clip polygon (clockwise)."""
    def inside(p, a, b):
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) <= 0

    def intersect(p1, p2, a, b):
        x1, y1 = p1; x2, y2 = p2; x3, y3 = a; x4, y4 = b
        den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        if abs(den) < 1e-9:
            return p2
        t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
        return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))

    out = list(subject)
    for i in range(len(clip)):
        a, b = clip[i], clip[(i + 1) % len(clip)]
        inp, out = out, []
        if not inp:
            break
        s = inp[-1]
        for e in inp:
            if inside(e, a, b):
                if not inside(s, a, b):
                    out.append(intersect(s, e, a, b))
                out.append(e)
            elif inside(s, a, b):
                out.append(intersect(s, e, a, b))
            s = e
    return _dedupe(out)


def _dedupe(poly):
    res = []
    for p in poly:
        if not res or ((res[-1][0] - p[0]) ** 2 + (res[-1][1] - p[1]) ** 2) ** 0.5 > 1.5:
            res.append((round(p[0], 2), round(p[1], 2)))
    if len(res) > 1 and ((res[0][0] - res[-1][0]) ** 2 + (res[0][1] - res[-1][1]) ** 2) ** 0.5 < 1.5:
        res.pop()
    return res


def _area(poly):
    s = 0
    for i in range(len(poly)):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % len(poly)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def _rect(x1, x2, y1, y2):
    return [(x1, y2), (x2, y2), (x2, y1), (x1, y1)]


def _shape(poly, raw):
    if len(poly) == 3:
        return "triangular"
    if len(poly) == 4 and abs(_area(poly) - _area(raw)) < 0.5:
        return "rectangular"
    return "diagonal" if len(poly) == 4 else "polygon"


def to_geo(poly, center=None, rot=None):
    ring = [_lnglat(x, y, center, rot) for x, y in poly]
    ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def point_geo(x, y, center=None, rot=None):
    return {"type": "Point", "coordinates": _lnglat(x, y, center, rot)}


def build_layout():
    wall = _inset(BOUNDARY, 0.965)  # compound-wall setback
    zones = [{"id": f"zone-{c.lower()}", "code": c, "name": n, "color": col,
              "geometry": _clip(_rect(*box), wall)} for c, n, col, box in ZONES]
    greens = [{"name": n, "geometry": _clip(_rect(*box), wall)} for n, box in GREENS]
    roads = [{"name": n, "width_m": round(min(x2 - x1, y2 - y1), 1), "geometry": _clip(_rect(x1, x2, y1, y2), wall)} for n, x1, y1, x2, y2 in ROADS]

    plots = []
    for kind, zone, s, e, front, depth, d, w in ROWS:
        pos = s
        while pos + w * 0.45 < e:
            pos2 = min(pos + w, e)
            rear = front + d * depth
            lo, hi = min(front, rear), max(front, rear)
            raw = _rect(pos, pos2, lo, hi) if kind == "h" else _rect(lo, hi, pos, pos2)
            poly = _clip(raw, wall)
            if len(poly) >= 3 and _area(poly) >= 70:
                plots.append({"zone": zone, "poly": poly, "width_m": round(pos2 - pos, 2), "depth_m": depth,
                              "shape": _shape(poly, raw)})
            pos = pos2
    for zone, tri in EXTRA_PLOTS:
        poly = _clip(tri, wall)
        plots.append({"zone": zone, "poly": poly, "width_m": round(_area(poly) ** 0.5, 2), "depth_m": 0, "shape": _shape(poly, tri)})
    return {"wall": wall, "zones": zones, "greens": greens, "roads": roads, "plots": plots}


def _dimensions(poly, shape):
    sides = []
    for i in range(len(poly)):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % len(poly)]
        sides.append(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5)
    if shape == "rectangular":
        sides = sides[:2]
    return " × ".join(f"{s:.1f}m" for s in sides)


def seed_documents(colony_id, now, center=None, rot_deg=None):
    center = center or CENTER
    rot = ROT if rot_deg is None else radians(rot_deg)
    g = lambda poly: to_geo(poly, center, rot)  # noqa: E731
    lay = build_layout()
    zone_docs, plot_docs = [], []
    for i, z in enumerate(lay["zones"]):
        zone_docs.append({"id": z["id"], "colony_id": colony_id, "code": z["code"], "name": z["name"],
                          "color": z["color"], "geometry": g(z["geometry"]), "sort_order": i, "created_at": now})
    order = {"A": 0, "B": 1, "C": 2, "D": 3}
    plots = sorted(lay["plots"], key=lambda p: order[p["zone"]])
    for n, p in enumerate(plots, start=1):
        area = round(_area(p["poly"]), 1)
        plot_docs.append({
            "id": f"plot-{n}", "colony_id": colony_id, "zone_id": f"zone-{p['zone'].lower()}", "number": str(n),
            "area_sqm": area, "area_sqft": round(area * 10.7639, 1), "area_sqyd": round(area * 1.19599, 1),
            "width_m": p["width_m"], "depth_m": p["depth_m"], "shape": p["shape"], "sides": len(p["poly"]),
            "dimensions": _dimensions(p["poly"], p["shape"]),
            "status_id": STATUS_CYCLE[n % len(STATUS_CYCLE)],
            "geometry": g(p["poly"]), "notes": "", "created_at": now,
        })
    colony_fields = {
        "layout_version": LAYOUT_VERSION,
        "map_center": center,
        "rotation_deg": round(rot * 180 / 3.141592653589793, 2),
        "boundary": g(BOUNDARY),
        "greens": [{"name": gr["name"], "geometry": g(gr["geometry"])} for gr in lay["greens"]],
        "roads": [{"name": r["name"], "width_m": r["width_m"], "geometry": g(r["geometry"])} for r in lay["roads"]],
        "entry_width_m": round(ENTRY_ROAD[2] - ENTRY_ROAD[0], 1),
        "entry_road": g(_rect(ENTRY_ROAD[0], ENTRY_ROAD[2], ENTRY_ROAD[1], ENTRY_ROAD[3])),
        "entrance": point_geo(*ENTRANCE, center, rot),
        "entry_centerline": {"type": "LineString", "coordinates": [_lnglat(0, 86, center, rot), _lnglat(0, MAIN_ROAD_Y + 2, center, rot)]},
        "total_area_sqm": round(_area(BOUNDARY)),
    }
    return colony_fields, zone_docs, plot_docs


if __name__ == "__main__":
    c, z, p = seed_documents("x", "now")
    from collections import Counter
    print(len(p), Counter(d["zone_id"] for d in p), Counter(d["shape"] for d in p), Counter(d["sides"] for d in p), c["total_area_sqm"])
    print(min(d["area_sqm"] for d in p), max(d["area_sqm"] for d in p))
