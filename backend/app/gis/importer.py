"""Automatic colony import: DXF (CAD) or PDF (georeferenced or scaled) -> GeoJSON features.

Pipeline: extract linework + texts -> polygonize faces -> georeference (GeoPDF /Measure,
lat/lng, UTM via Google-pin zone, or fit-at-pin) -> classify (boundary / plots / greens /
roads) -> number plots from texts -> group into zones.
"""
import math
import logging
import os
import re
import tempfile
from collections import defaultdict

import ezdxf
import numpy as np
import pymupdf
import requests
from shapely import set_precision
from shapely import affinity
from pyproj import Transformer
from shapely.geometry import (
    LineString,
    Polygon,
    Point,
    MultiPolygon,
    MultiPoint,
    MultiLineString,
    shape,
)
from shapely.ops import nearest_points, polygonize, snap, transform as transform_geometry, unary_union, voronoi_diagram
from shapely.ops import split as split_polygon
from shapely.strtree import STRtree
from scipy.optimize import minimize
from scipy.spatial import cKDTree
from app.gis.debug_artifacts import generate_debug_package

logger = logging.getLogger(__name__)
GREEN_WORDS = re.compile(r"\b(park|garden|green|lawn|open\s*space|play|club|amenit|pond|lake)", re.I)
ROAD_WORDS = re.compile(r"\b(road|rd\.?|street|path|lane|marg|mt\.?\s*wide|m\s*wide|wide)", re.I)
BOUNDARY_WORDS = re.compile(r"(boundary|site|limit|layout|compound|plot_bdy|extent)", re.I)
PLOT_NO = re.compile(
    r"^(?:plot\s*(?:no\.?)?\s*)?([A-Z]{0,2}[-/ ]?\d{1,4}[A-Z]?|\d{1,4}[-/ ]+[A-Z]{1,2})$",
    re.I,
)
SCALE_RE = re.compile(r"scale\s*[:=]?\s*1\s*[:/]\s*(\d{2,6})", re.I)
M_PER_FT = 0.3048


def _inside_anchor(geometry):
    """Return a point guaranteed to lie inside a polygon when possible.

    For concave and irregular boundaries, centroid can fall outside the actual
    shape and distort registration. Using a representative point that remains in
    the polygon is safer for translation and local-coordinate anchoring.
    """
    if geometry is None or geometry.is_empty:
        return None
    candidates = [geometry.representative_point(), geometry.centroid]
    if geometry.geom_type == "Polygon":
        candidates.extend(Point(coord) for coord in geometry.exterior.coords[:-1])
    elif geometry.geom_type == "MultiPolygon":
        for part in geometry.geoms:
            candidates.extend(Point(coord) for coord in part.exterior.coords[:-1])
    for candidate in candidates:
        if geometry.covers(candidate):
            return candidate
    return geometry.representative_point()


class ImportError_(Exception):
    pass


def _clip_translation_region(region, a, b, c):
    """Clip a convex translation region to the half-plane a*x + b*y >= c."""
    if not region:
        return []
    clipped = []
    previous = region[-1]
    previous_value = a * previous[0] + b * previous[1] - c
    for current in region:
        current_value = a * current[0] + b * current[1] - c
        previous_inside = previous_value >= -1e-9
        current_inside = current_value >= -1e-9
        if previous_inside != current_inside:
            denominator = previous_value - current_value
            if abs(denominator) > 1e-15:
                fraction = previous_value / denominator
                clipped.append((
                    previous[0] + fraction * (current[0] - previous[0]),
                    previous[1] + fraction * (current[1] - previous[1]),
                ))
        if current_inside:
            clipped.append(current)
        previous = current
        previous_value = current_value
    return clipped


def _feasible_translation_region(target, source_points, scale):
    """Find translations that place a scaled convex source fully inside target."""
    target_coords = list(target.exterior.coords)[:-1]
    if not target.exterior.is_ccw:
        target_coords.reverse()
    source_xs = [point[0] for point in source_points]
    source_ys = [point[1] for point in source_points]
    min_x, min_y, max_x, max_y = target.bounds
    region = [
        (min_x - scale * min(source_xs), min_y - scale * min(source_ys)),
        (max_x - scale * max(source_xs), min_y - scale * min(source_ys)),
        (max_x - scale * max(source_xs), max_y - scale * max(source_ys)),
        (min_x - scale * min(source_xs), max_y - scale * max(source_ys)),
    ]
    if region[0][0] > region[1][0] + 1e-9 or region[0][1] > region[3][1] + 1e-9:
        return []

    for index, start in enumerate(target_coords):
        end = target_coords[(index + 1) % len(target_coords)]
        edge_x, edge_y = end[0] - start[0], end[1] - start[1]
        min_source_cross = min(
            edge_x * point[1] - edge_y * point[0]
            for point in source_points
        )
        boundary_cross = edge_x * start[1] - edge_y * start[0]
        region = _clip_translation_region(
            region,
            -edge_y,
            edge_x,
            boundary_cross - scale * min_source_cross,
        )
        if not region:
            return []
    return region





# ----------------------------------------------------------------------------- Google Maps link
def parse_maps_link(link):
    if not link:
        return None
    url = link.strip()
    try:
        if re.search(r"(goo\.gl|maps\.app\.goo\.gl|g\.co)", url):
            r = requests.get(url, allow_redirects=True, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
            url = r.url
    except Exception:
        pass
    for pat in (r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", r"@(-?\d+\.\d+),(-?\d+\.\d+)", r"[?&](?:q|ll|query|destination|center)=(-?\d+\.\d+),\s*(-?\d+\.\d+)",
                r"(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})"):
        m = re.search(pat, url)
        if m:
            lat, lng = float(m.group(1)), float(m.group(2))
            if -90 <= lat <= 90 and -180 <= lng <= 180:
                return {"lat": lat, "lng": lng}
    return None


def _extract_dxf(data, is_dwg=False, filename=""):
    ext = os.path.splitext((filename or "").lower())[1]
    is_cad_binary = is_dwg or ext in (".dwg", ".dwf")
    tmp_path = _tmp(data, ext if ext in (".dwg", ".dwf", ".dxf") else (".dwg" if is_cad_binary else ".dxf"))
    try:
        if tmp_path.endswith(".dwg") or tmp_path.endswith(".dwf"):
            from ezdxf.addons import odafc

            converter_path = os.environ.get("ODA_FILE_CONVERTER", "").strip()
            if not converter_path and os.name == "nt":
                default_oda = r"C:\Program Files\ODA\ODAFileConverter 27.9.0\ODAFileConverter.exe"
                if os.path.exists(default_oda):
                    converter_path = default_oda
                    os.environ["ODA_FILE_CONVERTER"] = converter_path
            if converter_path:
                option = "win_exec_path" if os.name == "nt" else "unix_exec_path"
                ezdxf.options.set("odafc-addon", option, converter_path)
            if not odafc.is_installed():
                raise ImportError_(
                    "DWG/DWF conversion requires ODA File Converter. Install it on the Python GIS worker and set ODA_FILE_CONVERTER to its executable path."
                )
            try:
                doc = odafc.readfile(tmp_path)
            except Exception as error:
                raise ImportError_(f"ODA File Converter could not read the CAD drawing file: {error}") from error
        else:
            doc = ezdxf.readfile(tmp_path)

        units = doc.header.get("$INSUNITS", 0)
        unit_m = {1: 0.0254, 2: M_PER_FT, 4: 0.001, 5: 0.01, 6: 1.0, 14: 10.0}.get(units)
        lines, polys, texts = [], [], []

        def _process_entity(e, depth=0):
            if depth > 10:
                return
            t = e.dxftype()
            layer = getattr(e.dxf, "layer", "") or ""
            try:
                if t == "INSERT":
                    try:
                        for att in getattr(e, "attribs", []):
                            _process_entity(att, depth + 1)
                    except Exception:
                        pass
                    try:
                        for sub in e.virtual_entities():
                            _process_entity(sub, depth + 1)
                    except Exception:
                        pass
                elif t == "LWPOLYLINE":
                    pts = []
                    try:
                        for p in e.get_points(format="xyb"):
                            pts.append((p[0], p[1]))
                    except Exception:
                        pts = [(p[0], p[1]) for p in e.get_points()]
                    if len(pts) >= 2:
                        is_closed = getattr(e, "closed", False) or getattr(e.dxf, "is_closed", False)
                        (polys if (is_closed and len(pts) >= 3) else lines).append((pts, layer, None))
                elif t == "POLYLINE":
                    pts = [(v.dxf.location.x, v.dxf.location.y) for v in getattr(e, "vertices", [])]
                    if len(pts) >= 2:
                        is_closed = getattr(e, "is_closed", False) or getattr(e.dxf, "is_closed", False)
                        (polys if (is_closed and len(pts) >= 3) else lines).append((pts, layer, None))
                elif t == "LINE":
                    lines.append(([(e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)], layer, None))
                elif t in ("CIRCLE", "ARC"):
                    center = (e.dxf.center.x, e.dxf.center.y)
                    radius = getattr(e.dxf, "radius", 0)
                    if radius > 0:
                        start_ang = getattr(e.dxf, "start_angle", 0)
                        end_ang = getattr(e.dxf, "end_angle", 360 if t == "CIRCLE" else 0)
                        if t == "CIRCLE":
                            end_ang = start_ang + 360
                        elif end_ang < start_ang:
                            end_ang += 360
                        steps = max(8, int(abs(end_ang - start_ang) / 10))
                        pts = []
                        for step in range(steps + 1):
                            ang = math.radians(start_ang + (end_ang - start_ang) * step / steps)
                            pts.append((center[0] + radius * math.cos(ang), center[1] + radius * math.sin(ang)))
                        if t == "CIRCLE":
                            polys.append((pts, layer, None))
                        else:
                            lines.append((pts, layer, None))
                elif t in ("SOLID", "3DFACE"):
                    pts = []
                    for attr in ("vtx0", "vtx1", "vtx2", "vtx3"):
                        if hasattr(e.dxf, attr):
                            pt = getattr(e.dxf, attr)
                            pts.append((pt.x, pt.y))
                    if len(pts) >= 3:
                        polys.append((pts, layer, None))
                elif t == "HATCH":
                    for path in getattr(e, "paths", []):
                        if hasattr(path, "vertices") and path.vertices:
                            pts = [(v[0], v[1]) for v in path.vertices]
                            if len(pts) >= 3:
                                polys.append((pts, layer, _aci_rgb(getattr(e.dxf, "color", 7))))
                        elif hasattr(path, "edges") and path.edges:
                            pts = []
                            for edge in path.edges:
                                if hasattr(edge, "start") and hasattr(edge, "end"):
                                    pts.append((edge.start[0], edge.start[1]))
                                    pts.append((edge.end[0], edge.end[1]))
                            if len(pts) >= 3:
                                polys.append((pts, layer, _aci_rgb(getattr(e.dxf, "color", 7))))
                elif t in ("TEXT", "MTEXT", "ATTRIB", "ATTDEF"):
                    s = e.plain_text() if t == "MTEXT" else getattr(e.dxf, "text", "")
                    if s:
                        s = re.sub(r"\\[A-Za-z0-9]+\b;?", "", str(s))
                        s = re.sub(r"[\{\}\\]", "", s).strip()
                    p = getattr(e.dxf, "insert", None) or getattr(e.dxf, "align_point", None)
                    if s and p:
                        texts.append((p.x, p.y, s, layer))
            except Exception:
                pass

        msp = doc.modelspace()
        for e in msp:
            _process_entity(e)

        if not lines and not polys:
            for b in getattr(doc, "blocks", []):
                if getattr(b, "name", "").startswith("*"):
                    continue
                for e in b:
                    _process_entity(e)

        return {"lines": lines, "polys": polys, "texts": texts, "unit_m": unit_m, "georef": None, "src": "dxf"}
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass




def _aci_rgb(aci):
    try:
        from ezdxf.colors import aci2rgb
        return tuple(c / 255 for c in aci2rgb(aci))
    except Exception:
        return None


def _tmp(data, suffix):
    import tempfile
    f = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    f.write(data)
    f.close()
    return f.name


def _pdf_georef(doc, page):
    """Return (pdf_pts[(x,y)], geo_pts[(lng,lat)]) from a GeoPDF /VP /Measure dictionary."""
    try:
        vp_type, vp_val = doc.xref_get_key(page.xref, "VP")
    except Exception:
        return None
    if vp_type != "array" or not vp_val:
        return None
    refs = re.findall(r"(\d+)\s+0\s+R", vp_val)
    for ref in refs:
        xref = int(ref)
        bbox = _xref_array(doc, xref, "BBox")
        mt, mv = doc.xref_get_key(xref, "Measure")
        mref = int(re.match(r"(\d+)\s+0\s+R", mv).group(1)) if mt == "xref" else None
        if mref is None or not bbox or len(bbox) < 4:
            continue
        gpts = _xref_array(doc, mref, "GPTS")
        lpts = _xref_array(doc, mref, "LPTS") or [0, 0, 0, 1, 1, 1, 1, 0]
        if not gpts or len(gpts) < 8:
            continue
        x0, y0, x1, y1 = bbox[0], bbox[1], bbox[2], bbox[3]
        bx0, bx1, by0, by1 = min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1)
        pdf_pts, geo_pts = [], []
        for i in range(0, min(len(gpts), len(lpts)) - 1, 2):
            u, v = lpts[i], lpts[i + 1]
            pdf_pts.append((bx0 + u * (bx1 - bx0), by0 + v * (by1 - by0)))
            geo_pts.append((gpts[i + 1], gpts[i]))  # GPTS are lat,lng pairs
        return pdf_pts, geo_pts
    return None


def _xref_array(doc, xref, key):
    try:
        t, v = doc.xref_get_key(xref, key)
    except Exception:
        return None
    if t == "xref":
        try:
            xr = int(re.match(r"(\d+)\s+0\s+R", v).group(1))
            v = doc.xref_object(xr)
        except Exception:
            return None
    nums = re.findall(r"-?\d+(?:\.\d+)?(?:e[-+]?\d+)?", v or "")
    return [float(n) for n in nums] if nums else None


def detect_pdf_content_type(doc) -> str:
    """
    Returns: 'vector', 'raster', or 'hybrid'
    Used to route to correct extraction branch.
    """
    total_lines = 0
    total_text = 0
    total_images = 0

    for page in doc:
        drawings = page.get_drawings()
        total_lines += sum(len(d.get("items", [])) for d in drawings)
        blocks = page.get_text("dict").get("blocks", [])
        total_text += len([b for b in blocks if b.get("type") == 0])
        total_images += len(page.get_images(full=True))

    if total_lines > 100 and total_images == 0:
        return "vector"
    elif total_images > 0 and total_lines < 10:
        return "raster"
    else:
        return "hybrid"


def _extract_pdf(data):
    doc = pymupdf.open(stream=data, filetype="pdf")
    if not doc.page_count:
        doc.close()
        raise ImportError_("The uploaded PDF does not contain any pages")
    detected_pipeline_type = detect_pdf_content_type(doc)
    page_summaries = []
    for page_index, candidate_page in enumerate(doc):
        drawings = candidate_page.get_drawings()
        vector_items = sum(len(drawing.get("items", [])) for drawing in drawings)
        images = candidate_page.get_images(full=True)
        words = candidate_page.get_text("words")
        image_info = candidate_page.get_image_info(xrefs=True)
        largest_image_area = max(
            (int(item.get("width", 0)) * int(item.get("height", 0)) for item in image_info),
            default=0,
        )
        has_vector = vector_items > 0
        has_raster = bool(images or image_info)
        if has_vector and has_raster:
            content_type = "mixed"
        elif has_vector:
            content_type = "vector"
        elif has_raster:
            content_type = "raster"
        elif words:
            content_type = "text_only"
        else:
            content_type = "blank"
        page_summaries.append({
            "page_index": page_index,
            "width_points": round(float(candidate_page.rect.width), 3),
            "height_points": round(float(candidate_page.rect.height), 3),
            "rotation_deg": int(candidate_page.rotation),
            "content_type": content_type,
            "drawing_count": len(drawings),
            "vector_item_count": vector_items,
            "embedded_image_count": len(images),
            "image_placement_count": len(image_info),
            "text_word_count": len(words),
            "largest_image_pixel_area": largest_image_area,
        })

    content_types = {summary["content_type"] for summary in page_summaries}
    if "mixed" in content_types or {"vector", "raster"} <= content_types:
        pdf_type = "mixed"
    elif "vector" in content_types:
        pdf_type = "vector"
    elif "raster" in content_types:
        pdf_type = "raster"
    elif "text_only" in content_types:
        pdf_type = "text_only"
    else:
        pdf_type = "blank"
    pdf_content = {
        "pdf_type": pdf_type,
        "content_type": detected_pipeline_type,
        "page_count": len(doc),
        "pages": page_summaries,
        "extracted_page_index": 0,
        "page_selection": "first_page_compatibility",
    }
    page = doc[0]
    H = page.cropbox.height
    W = page.cropbox.width
    page_area = W * H
    flip = lambda x, y: (x, H - y)  # PDF user space -> y-up drawing space
    lines, polys, texts = [], [], []
    for d in page.get_drawings():
        fill = d.get("fill")
        chain = []
        chains = []
        for it in d["items"]:
            if it[0] == "l":
                a = it[1]
                b = it[2]
                if chain and (
                    abs(chain[-1][0] - a.x) > 0.01
                    or abs(chain[-1][1] - a.y) > 0.01
                ):
                    chains.append(chain)
                    chain = []
                if not chain:
                    chain = [(a.x, a.y)]
                chain.append((b.x, b.y))
            elif it[0] == "c" and not fill:
                a, b = it[1], it[4]
                lines.append(([flip(a.x, a.y), flip(b.x, b.y)], "", fill))
            else:
                if chain:
                    chains.append(chain)
                    chain = []
                if it[0] == "re":
                    r = it[1]
                    pts = [
                        flip(r.x0, r.y0), flip(r.x1, r.y0),
                        flip(r.x1, r.y1), flip(r.x0, r.y1),
                    ]
                    poly_area = (r.x1 - r.x0) * (r.y1 - r.y0)
                    if poly_area < 0.35 * page_area:
                        polys.append((pts, "", fill))
                elif it[0] == "qu":
                    q = it[1]
                    polys.append(([
                        flip(q.ul.x, q.ul.y), flip(q.ur.x, q.ur.y),
                        flip(q.lr.x, q.lr.y), flip(q.ll.x, q.ll.y),
                    ], "", fill))
        if chain:
            chains.append(chain)

        for chain in chains:
            if len(chain) < 2:
                continue
            closed = (
                d.get("closePath")
                or fill
                or (
                    len(chain) >= 4
                    and abs(chain[0][0] - chain[-1][0]) < 0.01
                    and abs(chain[0][1] - chain[-1][1]) < 0.01
                )
            )
            if closed and len(chain) >= 4:
                pts = [flip(x, y) for x, y in chain]
                if abs(chain[0][0] - chain[-1][0]) < 0.01 and abs(chain[0][1] - chain[-1][1]) < 0.01:
                    pts = pts[:-1]
                try:
                    poly_area = Polygon(pts).area
                    if poly_area < 0.35 * page_area:
                        polys.append((pts, "", fill))
                except Exception:
                    polys.append((pts, "", fill))
            else:
                for start, end in zip(chain, chain[1:]):
                    lines.append(([flip(*start), flip(*end)], "", fill))
    annotations = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            direction = line.get("dir", (1.0, 0.0))
            direction_up = (float(direction[0]), -float(direction[1]))
            for span in line.get("spans", []):
                content = str(span.get("text", "")).strip()
                bbox = span.get("bbox")
                if not content or not bbox or len(bbox) != 4:
                    continue
                center_x, center_y = flip(
                    (float(bbox[0]) + float(bbox[2])) / 2,
                    (float(bbox[1]) + float(bbox[3])) / 2,
                )
                annotations.append({
                    "x": center_x,
                    "y": center_y,
                    "text": content,
                    "direction": direction_up,
                    "font_size": float(span.get("size", 0) or 0),
                })

    for w in page.get_text("words"):
        x0, y0, x1, y1, s = w[:5]
        cx, cy = flip((x0 + x1) / 2, (y0 + y1) / 2)
        texts.append((cx, cy, s.strip(), ""))
    texts = _merge_words(texts)
    georef = _pdf_georef(doc, page)  # already in PDF user space (y-up), same frame as flipped drawings
    full_text = page.get_text()
    scale = SCALE_RE.search(full_text)
    unit_m = (0.0254 / 72) * float(scale.group(1)) if scale else None
    doc.close()
    return {
        "lines": lines,
        "polys": polys,
        "texts": texts,
        "annotations": annotations,
        "unit_m": unit_m,
        "georef": georef,
        "pdf_content": pdf_content,
        "src": "pdf",
    }


def _merge_words(texts):
    """Join words on the same baseline that are close together (e.g. 'PLOT' '12', 'CENTRAL' 'PARK')."""
    texts = sorted(texts, key=lambda t: (-round(t[1], 1), t[0]))
    out = []
    for x, y, s, layer in texts:
        if out and abs(out[-1][1] - y) < 2 and 0 < x - out[-1][0] < 40 and not (s.isdigit() and out[-1][2].split()[-1].isdigit()):
            px, py, ps, pl = out[-1]
            out[-1] = ((px + x) / 2, py, f"{ps} {s}", pl)
        else:
            out.append((x, y, s, layer))
    return out


# ----------------------------------------------------------------------------- georeferencing
def _affine_from_points(src, dst):
    A = np.array([[x, y, 1] for x, y in src]); B = np.array(dst)
    sol, *_ = np.linalg.lstsq(A, B, rcond=None)
    return sol  # 3x2: [x y 1] @ sol -> (lng, lat)


def _looks_latlng(xs, ys):
    return all(-180 <= x <= 180 for x in xs) and all(-90 <= y <= 90 for y in ys) and (max(xs) - min(xs)) < 1 and (max(ys) - min(ys)) < 1


def _looks_utm(xs, ys):
    return all(100000 <= x <= 900000 for x in xs) and all(0 <= y <= 10000000 for y in ys)

def _similarity_from_points(src, dst):
    """Compute 2D similarity transform (translation, rotation, uniform scale - preserves plot shapes & 90° angles)."""
    if len(src) < 2 or len(dst) < 2:
        return _affine_from_points(src, dst)

    lng0 = sum(p[0] for p in dst) / len(dst)
    lat0 = sum(p[1] for p in dst) / len(dst)
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110574

    dst_local = [((lng - lng0) * kx, (lat - lat0) * ky) for lng, lat in dst]

    A = []
    B = []
    for (x, y), (u, v) in zip(src, dst_local):
        A.append([x, -y, 1, 0])
        B.append(u)
        A.append([y, x, 0, 1])
        B.append(v)

    sol, *_ = np.linalg.lstsq(np.array(A), np.array(B), rcond=None)
    a, b, tx, ty = sol

    M = np.array([
        [a / kx, b / ky],
        [-b / kx, a / ky],
        [lng0 + tx / kx, lat0 + ty / ky]
    ])
    return M


def _point_label_calibration(ex, target_boundary):
    if not isinstance(target_boundary, dict) or target_boundary.get("type") != "FeatureCollection":
        return None

    pdf_labels = defaultdict(list)
    for text in ex.get("texts", []):
        raw_number = str(text[2]).strip()
        if PLOT_NO.match(raw_number):
            pdf_labels[normalize_plot_no(raw_number)].append((text[0], text[1]))

    geo_labels = defaultdict(list)
    for feature in target_boundary.get("features") or []:
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            continue
        properties = feature.get("properties") or {}
        raw_number = next(
            (properties.get(key) for key in
             ("plot_no", "plot_number", "lot_number", "lot_no", "number", "name", "label")
             if properties.get(key) is not None and str(properties.get(key)).strip()),
            None,
        )
        if raw_number is None or not PLOT_NO.match(str(raw_number).strip()):
            continue
        coordinates = geometry.get("coordinates") or []
        if len(coordinates) >= 2:
            geo_labels[normalize_plot_no(raw_number)].append(
                (float(coordinates[0]), float(coordinates[1]))
            )

    matches = [
        (number, pdf_labels[number][0], geo_labels[number][0])
        for number in pdf_labels.keys() & geo_labels.keys()
        if len(pdf_labels[number]) == 1 and len(geo_labels[number]) == 1
    ]
    if len(matches) < 4:
        return None

    def fit(selected):
        return _similarity_from_points(
            [pdf_point for _, pdf_point, _ in selected],
            [geo_point for _, _, geo_point in selected],
        )

    def residual_meters(solution, match):
        _, (x, y), (lng, lat) = match
        predicted = np.array([x, y, 1]) @ solution
        return math.hypot(
            (predicted[0] - lng) * 111320 * math.cos(math.radians(lat)),
            (predicted[1] - lat) * 110574,
        )

    solution = fit(matches)
    inliers = [match for match in matches if residual_meters(solution, match) <= 12]
    if len(inliers) >= 4:
        solution = fit(inliers)
        validated = [match for match in matches if residual_meters(solution, match) <= 15]
        if len(validated) >= 4:
            solution = fit(validated)

    plot_texts = {number: pdf_point for number, pdf_point, _ in matches}
    for number in pdf_labels.keys() & geo_labels.keys():
        if number in plot_texts:
            continue
        best_cand = None
        best_res = 15.0
        for pdf_pt in pdf_labels[number]:
            for geo_pt in geo_labels[number]:
                cand_match = (number, pdf_pt, geo_pt)
                res = residual_meters(solution, cand_match)
                if res < best_res:
                    best_res = res
                    best_cand = pdf_pt
        if best_cand:
            plot_texts[number] = best_cand

    return {
        "solution": solution,
        "plot_texts": plot_texts,
    }


_PLOT_PREFIX = re.compile(r"^(?:plot|shop|unit|flat|khasra|site|parcel)\s*(?:no\.?)?\s*([a-zA-Z0-9\-_/]+)$", re.I)


def normalize_plot_no(text):
    if not text:
        return None
    raw = str(text).strip()
    m = PLOT_NO.match(raw)
    if m and m.group(1):
        val = m.group(1).upper().replace(" ", "").replace("-", "").replace("/", "")
        if val:
            return val
    m2 = _PLOT_PREFIX.match(raw)
    if m2 and m2.group(1):
        val = m2.group(1).upper().replace(" ", "").replace("-", "").replace("/", "")
        if val:
            return val
    return None


def extract_pdf_plot_numbers(data, extracted=None):
    """Extract unique numbered plot labels without performing spatial registration."""
    if extracted is None:
        extracted = _extract_pdf(data)
    numbers = {
        number
        for text in extracted.get("texts", [])
        if (number := normalize_plot_no(text[2]))
    }
    return sorted(
        numbers,
        key=lambda number: (not number.isdigit(), int(number) if number.isdigit() else number),
    )


def _labeled_plot_polygons(ex):
    """Recover individual plot cells by splitting PDF parcel blocks at divider lines, polygonizing vector faces, or Voronoi boundary partitioning."""
    labels = []
    seen = set()
    for text in ex.get("texts", []):
        s = str(text[2]).strip()
        if PLOT_NO.match(s):
            no = normalize_plot_no(s)
            if no and no not in seen:
                seen.add(no)
                labels.append(text)
    if len(labels) < 3:
        return None

    label_coordinates = np.asarray(
        [(x, y) for x, y, _, _ in labels], dtype=np.float64
    )
    nearest_distances, _ = cKDTree(label_coordinates).query(label_coordinates, k=2)
    nearest_spacings = nearest_distances[:, 1]
    nearest_spacings = nearest_spacings[nearest_spacings > 0].tolist()
    if not nearest_spacings:
        return None

    spacing = sorted(nearest_spacings)[len(nearest_spacings) // 2]
    is_cad = ex.get("src") in ("dxf", "dwg")
    snap_tolerance = max(0.5, spacing * 0.05)
    min_line_length = spacing * 0.3
    contain_buf = snap_tolerance * 0.6 if is_cad else min(snap_tolerance * 0.2, 0.25)
    labels_by_num = {normalize_plot_no(l[2]): Point(l[0], l[1]) for l in labels}

    vector_faces = _faces(ex)
    # Exclude tiny symbol / label badge boxes (which have area ~ 0.02 * spacing^2)
    # Real plot parcels have area on the order of spacing^2. Exclude shapes smaller than 0.20 * spacing^2.
    min_feature_area = max(50.0, spacing * spacing * 0.20) if spacing else 25.0
    valid_vector_faces = [f for f in vector_faces if f.is_valid and f.area >= min_feature_area]
    if not valid_vector_faces:
        valid_vector_faces = [f for f in vector_faces if f.is_valid and f.area > 25.0]

    one_label_areas = []
    for face in valid_vector_faces:
        contained = [
            normalize_plot_no(label[2])
            for label in labels
            if face.buffer(contain_buf).covers(Point(label[0], label[1]))
        ]
        if len(contained) == 1:
            one_label_areas.append(face.area)

    if one_label_areas:
        med_face_area = sorted(one_label_areas)[len(one_label_areas) // 2]
        min_cell_area = max(25.0 if is_cad else 50.0, min(100.0, med_face_area * 0.15))
        max_cell_area = max(50000.0, spacing * spacing * 5.0, med_face_area * 3.5)
        expected_cell_area = med_face_area
    else:
        min_cell_area = max(25.0 if is_cad else 50.0, spacing * spacing * 0.15)
        max_cell_area = max(50000.0, spacing * spacing * 5.0)
        expected_cell_area = spacing * spacing * 0.65

    candidates = {}

    # Pass 1: Direct closed vector faces from valid_vector_faces
    multi_label_blocks = []
    direct_candidates = defaultdict(list)
    try:
        for face in valid_vector_faces:
            contained = [
                normalize_plot_no(label[2])
                for label in labels
                if face.buffer(contain_buf).covers(Point(label[0], label[1]))
            ]
            if len(contained) == 1:
                no = contained[0]
                if min_cell_area <= face.area <= max_cell_area:
                    # Exclude parent enclosing frames (e.g. whole layout boundary)
                    is_parent_frame = any(
                        other != face and other.area > min_cell_area and face.contains(other.representative_point())
                        for other in valid_vector_faces[:40]
                    )
                    if not is_parent_frame:
                        direct_candidates[no].append(face)
            elif len(contained) > 1:
                multi_label_blocks.append(face)
    except Exception:
        pass
    for number, faces_for_number in direct_candidates.items():
        candidates[number] = min(
            faces_for_number,
            key=lambda face: abs(math.log(face.area / expected_cell_area)),
        )

    # Pass 2: Block splitting for polygon blocks and multi-label vector faces
    segments = []
    for points, _, _ in ex.get("lines", []):
        if len(points) >= 2:
            segment = LineString(points)
            if segment.length >= min_line_length * 0.5:
                segments.append(segment)
    for points, _, _ in ex.get("polys", []):
        if len(points) >= 3:
            segment = LineString(list(points) + [points[0]])
            if segment.length >= min_line_length * 0.5:
                segments.append(segment)

    if segments:
        segment_tree = STRtree(segments)
        blocks_to_split = list(multi_label_blocks)
        for points, _, _ in ex.get("polys", []):
            if len(points) >= 3:
                try:
                    p = Polygon(points)
                    if p.is_valid and p.area > min_cell_area * 0.3:
                        blocks_to_split.append(p)
                except Exception:
                    pass

        for block in blocks_to_split:
            if not any(block.buffer(snap_tolerance).covers(Point(label[0], label[1])) for label in labels):
                continue
            block = set_precision(block, grid_size=0.001)
            parts = [block]
            matching_indices = segment_tree.query(block.buffer(snap_tolerance * 2.0))
            for _ in range(4):
                split_occurred = False
                for segment_index in matching_indices:
                    segment = segments[int(segment_index)]
                    clipped = segment.intersection(block.buffer(snap_tolerance * 2.0))
                    if clipped.geom_type == "LineString":
                        clipped_lines = [clipped]
                    elif clipped.geom_type == "MultiLineString":
                        clipped_lines = list(clipped.geoms)
                    else:
                        continue

                    for clipped_line in clipped_lines:
                        if clipped_line.length < min_line_length * 0.5:
                            continue
                        coords = list(clipped_line.coords)
                        divider = set_precision(LineString(coords), grid_size=0.001)
                        next_parts = []
                        for part in parts:
                            if divider.intersects(part):
                                p_coords = list(divider.coords)
                                for endpoint in (0, -1):
                                    point = Point(p_coords[endpoint])
                                    distance = point.distance(part.boundary)
                                    if 0 < distance <= snap_tolerance * 2.0:
                                        p_coords[endpoint] = tuple(
                                            nearest_points(point, part.boundary)[1].coords[0]
                                        )
                                p_divider = set_precision(LineString(p_coords), grid_size=0.001)
                                try:
                                    res = split_polygon(part, p_divider)
                                    if len(res.geoms) > 1:
                                        next_parts.extend(res.geoms)
                                        split_occurred = True
                                    else:
                                        next_parts.append(part)
                                except Exception:
                                    next_parts.append(part)
                            else:
                                next_parts.append(part)
                        parts = next_parts
                if not split_occurred:
                    break

            for part in parts:
                cell = Polygon(part.exterior.coords)
                contained_numbers = {
                    normalize_plot_no(label[2])
                    for label in labels
                    if cell.buffer(snap_tolerance * 0.2).covers(Point(label[0], label[1]))
                }
                if len(contained_numbers) == 1:
                    number = next(iter(contained_numbers))
                    if not min_cell_area <= cell.area <= max_cell_area:
                        continue
                    previous = candidates.get(number)
                    label_pt = labels_by_num.get(number)
                    prev_contains = (
                        previous is not None
                        and label_pt is not None
                        and previous.buffer(snap_tolerance * 0.2).covers(label_pt)
                    )
                    if (
                        previous is None
                        or not prev_contains
                        or abs(math.log(cell.area / expected_cell_area))
                        < abs(math.log(previous.area / expected_cell_area))
                    ):
                        candidates[number] = cell

    # Pass 3: CAD Proximity matching for unassigned labels and faces (only for DXF/DWG CAD files)
    if is_cad and len(candidates) < len(labels) and valid_vector_faces:
        used_faces = set(candidates.values())
        unused_faces = [f for f in valid_vector_faces if f not in used_faces and min_cell_area <= f.area <= max_cell_area]
        unmatched_labels = [l for l in labels if normalize_plot_no(l[2]) not in candidates]
        if unused_faces and unmatched_labels:
            pairs = []
            for l in unmatched_labels:
                pt = Point(l[0], l[1])
                no = normalize_plot_no(l[2])
                for f in unused_faces:
                    d = f.distance(pt)
                    if d <= spacing * 0.8:
                        pairs.append((d, no, f))
            pairs.sort(key=lambda x: x[0])
            matched_l = set()
            matched_f = set()
            for d, no, f in pairs:
                if no not in matched_l and f not in matched_f:
                    matched_l.add(no)
                    matched_f.add(f)
                    candidates[no] = f

    # Pass 4: Voronoi Geometric Partition Fallback for remaining unmatched labels
    if len(candidates) < len(labels) and (is_cad or len(candidates) < 0.6 * len(labels)):
        allpts = [p for pts, _, _ in ex.get("lines", []) + ex.get("polys", []) for p in pts]
        if allpts:
            drawing_hull = MultiPoint(allpts).convex_hull
            if drawing_hull.is_valid and drawing_hull.area > 50:
                pts = MultiPoint([Point(x, y) for x, y, _, _ in labels])
                try:
                    vor = voronoi_diagram(pts, envelope=drawing_hull.envelope)
                    for g in vor.geoms:
                        clipped = g.intersection(drawing_hull)
                        if clipped.is_valid and clipped.area > min_cell_area * 0.2:
                            for text in labels:
                                no = normalize_plot_no(text[2])
                                if no and no not in candidates:
                                    if clipped.contains(Point(text[0], text[1])):
                                        candidates[no] = clipped
                                        break
                except Exception:
                    pass

    # Pass 5: Sequential Edge Snapping for neighboring plot cells
    if candidates:
        all_cells = list(candidates.values())
        try:
            cells_union = unary_union(all_cells)
            for no, cell in list(candidates.items()):
                try:
                    snapped_cell = snap(cell, cells_union, snap_tolerance * 0.5)
                    if snapped_cell.is_valid and snapped_cell.area > 0:
                        simplified = snapped_cell.simplify(max(0.1, snap_tolerance * 0.1), preserve_topology=True)
                        if simplified.is_valid and simplified.geom_type == "Polygon" and simplified.area > min_cell_area * 0.5:
                            candidates[no] = Polygon(simplified.exterior.coords)
                        else:
                            candidates[no] = Polygon(snapped_cell.exterior.coords)
                except Exception:
                    pass
        except Exception:
            pass

    return candidates if candidates else None


def _evaluate_registration_candidate(cand_poly, target_poly_m):
    if not cand_poly.is_valid:
        cand_poly = cand_poly.buffer(0)
    if cand_poly.is_empty or cand_poly.area <= 0:
        return -100.0, {}

    cand_area = cand_poly.area
    target_area = target_poly_m.area
    inter_poly = target_poly_m.intersection(cand_poly)
    inter_area = inter_poly.area if not inter_poly.is_empty else 0.0
    union_poly = target_poly_m.union(cand_poly)
    union_area = union_poly.area if not union_poly.is_empty else 1.0

    iou = inter_area / union_area if union_area > 0 else 0.0
    coverage = inter_area / cand_area if cand_area > 0 else 0.0
    target_fill = inter_area / target_area if target_area > 0 else 0.0
    spill_ratio = max(0.0, (cand_area - inter_area) / cand_area)

    is_contained = (spill_ratio <= 1e-4) or target_poly_m.covers(cand_poly)
    if is_contained:
        score = 10.0 + 0.40 * iou + 0.35 * coverage + 0.25 * target_fill
    else:
        score = 0.40 * iou + 0.35 * coverage + 0.25 * target_fill - 100.0 * spill_ratio

    metrics = {
        "score": score,
        "iou": iou,
        "coverage": coverage,
        "target_fill": target_fill,
        "spill_ratio": spill_ratio,
        "is_contained": is_contained,
        "cand_area": cand_area,
        "target_area": target_area,
    }
    return score, metrics


def _dynamic_pdf_layout_boundary(ex, target_poly_m=None):
    """Dynamically determine the true PDF colony layout boundary (G_pdf).
    Separates colony layout from page borders, highway linework, legends, and title blocks.
    When target_poly_m is provided, candidate aspect ratio and shape compatibility
    are used to rank the most representative layout perimeter.
    """
    faces = _faces(ex)
    labels = []
    seen = set()
    for text in ex.get("texts", []):
        s = str(text[2]).strip()
        m = PLOT_NO.match(s)
        if m:
            no = normalize_plot_no(s)
            if no and no not in seen:
                seen.add(no)
                labels.append(text)

    is_cad = ex.get("src") in ("dxf", "dwg")
    allpts = [p for pts, _, _ in ex.get("lines", []) + ex.get("polys", []) for p in pts]
    drawing_hull = MultiPoint(allpts).convex_hull if allpts else None
    max_parcel_area = (drawing_hull.area * 0.35) if drawing_hull and drawing_hull.area > 0 else 50000.0

    plot_faces = []
    if labels and faces:
        for f in faces:
            # Exclude giant outer page frames / margin containers
            if f.area > max_parcel_area:
                continue
            contained_count = sum(1 for l in labels if f.buffer(1.0 if is_cad else 0.1).covers(Point(l[0], l[1])))
            if 1 <= contained_count <= 4:
                plot_faces.append(f)

    candidates = []

    # If polys exist from recovered plot parcels, their union hull is the most accurate layout boundary!
    if ex.get("polys"):
        direct_polys = []
        for pts, _, _ in ex.get("polys", []):
            if len(pts) >= 3:
                try:
                    poly = Polygon(pts)
                    # Exclude giant outer page frames
                    if poly.is_valid and 10 < poly.area < max_parcel_area:
                        direct_polys.append(poly)
                except Exception:
                    pass
        if direct_polys:
            poly_hull = unary_union(direct_polys).convex_hull
            if poly_hull.is_valid and poly_hull.area > 0:
                candidates.append({"name": "parcel_polys_hull", "geom": poly_hull})

    if plot_faces:
        pf_union = unary_union(plot_faces)
        pf_hull = pf_union.convex_hull
        candidates.append({"name": "plot_faces_hull", "geom": pf_hull})

        # Layout union with internal road/park spaces
        internal_faces = [
            f for f in faces
            if (pf_hull.contains(f.representative_point()) or pf_hull.intersects(f))
            and f.area < pf_hull.area * 0.45
        ]
        if internal_faces:
            layout_union = unary_union(plot_faces + internal_faces)
            candidates.append({"name": "layout_with_internal_spaces", "geom": layout_union.convex_hull})

    if labels:
        label_pts = MultiPoint([(l[0], l[1]) for l in labels])
        l_hull = label_pts.convex_hull
        l_minx, l_miny, l_maxx, l_maxy = l_hull.bounds
        l_span = max(l_maxx - l_minx, l_maxy - l_miny, 10.0)
        candidates.append({"name": "buffered_label_cluster", "geom": l_hull.buffer(l_span * 0.08)})

    if drawing_hull and drawing_hull.is_valid and drawing_hull.area > 0:
        candidates.append({"name": "all_points_hull", "geom": drawing_hull})

    if faces:
        overall_union = unary_union(faces)
        candidates.append({"name": "overall_faces_hull", "geom": overall_union.convex_hull})

    if not candidates:
        return None, [], []

    target_aspect = None
    if target_poly_m and hasattr(target_poly_m, "bounds"):
        tb = target_poly_m.bounds
        tw = max(tb[2] - tb[0], 1e-3)
        th = max(tb[3] - tb[1], 1e-3)
        target_aspect = tw / th

    scored = []
    pf_union = unary_union(plot_faces) if plot_faces else None
    for cand in candidates:
        geom = cand["geom"]
        if not geom.is_valid:
            geom = geom.buffer(0)
        if geom.is_empty or geom.area <= 0:
            continue

        label_cov = 1.0
        if labels:
            cov_count = sum(1 for l in labels if geom.buffer(1.0).covers(Point(l[0], l[1])))
            label_cov = cov_count / len(labels)

        face_cov = 1.0
        if pf_union and pf_union.area > 0:
            inter = geom.intersection(pf_union)
            face_cov = inter.area / pf_union.area if not inter.is_empty else 0.0

        perim = geom.length
        compactness = (4.0 * math.pi * geom.area) / max(perim * perim, 1e-6)

        score = label_cov * 150.0 + face_cov * 100.0 + compactness * 5.0
        if cand.get("name") in ("parcel_polys_hull", "layout_with_internal_spaces", "plot_faces_hull"):
            score += 60.0
        elif cand.get("name") == "buffered_label_cluster":
            score += 40.0

        # Heavily penalize shapes that do not contain the colony's plot labels
        if label_cov < 0.95:
            score -= (0.95 - label_cov) * 1000.0
        if face_cov < 0.95 and pf_union and pf_union.area > 0:
            score -= (0.95 - face_cov) * 500.0

        # Penalize excessive whitespace that is much larger than the plot cluster
        if pf_union and pf_union.area > 0 and geom.area > pf_union.area * 2.5:
            excess_ratio = (geom.area - pf_union.area * 2.5) / pf_union.area
            score -= min(150.0, excess_ratio * 30.0)

        # Incorporate aspect ratio alignment with target land boundary if known
        if target_aspect is not None:
            cb = geom.bounds
            cw = max(cb[2] - cb[0], 1e-3)
            ch = max(cb[3] - cb[1], 1e-3)
            c_aspect = cw / ch
            asp_diff = min(abs(c_aspect - target_aspect), abs(1.0 / c_aspect - target_aspect))
            score -= min(40.0, asp_diff * 25.0)

        scored.append({
            "name": cand["name"],
            "geometry": geom,
            "score": score,
            "label_coverage": label_cov,
            "face_coverage": face_cov,
            "area": geom.area,
        })

    scored.sort(key=lambda x: x["score"], reverse=True)
    selected = scored[0]["geometry"]
    return selected, scored, plot_faces



def _fit_drawing_to_boundary(ex, target_ring, warnings, target_boundary_geo=None):
    """Geometrically register the PDF outer layout boundary to the KML land boundary.

    1. Dynamically discover candidate PDF layout boundaries aware of the target KML aspect ratio.
    2. Project target KML land boundary (G_kml) into local metric space (meters).
    3. Perform hierarchical anisotropic registration (fast angle sweep -> grid search -> continuous Nelder-Mead).
    4. Dynamically adapt independent horizontal and vertical scales (s_x, s_y) within bounded aspect distortion,
       guaranteeing tight, gap-free fitting inside the KML boundary while preserving plot geometry realism.
    """
    if not target_ring or len(target_ring) < 4:
        return None
    try:
        target_poly = Polygon(target_ring)
        if not target_poly.is_valid or target_poly.area <= 0:
            target_poly = target_poly.buffer(0)
            if not target_poly.is_valid or target_poly.area <= 0:
                return None

        t_xs = [p[0] for p in target_ring]
        t_ys = [p[1] for p in target_ring]
        min_x, max_x = min(t_xs), max(t_xs)
        min_y, max_y = min(t_ys), max(t_ys)
        span_x = max_x - min_x
        span_y = max_y - min_y

        tc = _inside_anchor(target_poly) or target_poly.representative_point()
        lng0, lat0 = tc.x, tc.y

        is_geo = (-180 <= min_x <= 180 and -90 <= min_y <= 90 and span_x < 1.0 and span_y < 1.0 and (abs(lng0) > 0.01 or abs(lat0) > 0.01))

        if is_geo:
            ky = 110574.0
            kx0 = 111320.0 * math.cos(math.radians(lat0))
            if kx0 <= 0:
                kx0 = 1.0
        else:
            ky = 1.0
            kx0 = 1.0

        target_poly_m = Polygon([((x - lng0) * kx0, (y - lat0) * ky) for x, y in target_ring])
        if not target_poly_m.is_valid or target_poly_m.area <= 0:
            target_poly_m = target_poly_m.buffer(0)

        # 1. Dynamic PDF Layout Boundary Discovery (G_pdf) aware of target aspect
        pdf_layout_boundary, cand_boundaries, plot_faces = _dynamic_pdf_layout_boundary(ex, target_poly_m=target_poly_m)
        if not pdf_layout_boundary or pdf_layout_boundary.area <= 0:
            return None

        t_minx, t_miny, t_maxx, t_maxy = target_poly_m.bounds
        target_w = max(t_maxx - t_minx, 1e-3)
        target_h = max(t_maxy - t_miny, 1e-3)

        # 2. Select top candidate boundaries that cover the plots
        candidates_to_try = [c for c in cand_boundaries if c.get("label_coverage", 0) >= 0.85][:3]
        if not candidates_to_try:
            candidates_to_try = cand_boundaries[:1]

        overall_best_score = -1e9
        overall_best_metrics = {}
        overall_best_params = None
        overall_best_cand_info = None

        for c_info in candidates_to_try:
            cand_geom = c_info["geometry"]
            src_center = _inside_anchor(cand_geom) or cand_geom.centroid
            c_pts = list(cand_geom.exterior.coords)[:-1]
            cntr_pts = np.array([(p[0] - src_center.x, p[1] - src_center.y) for p in c_pts])

            # A. Fast coarse angle sweep
            angle_scores = []
            for deg in range(0, 360, 5):
                rad = math.radians(deg)
                cos_a, sin_a = math.cos(rad), math.sin(rad)
                rot_x = cntr_pts[:, 0] * cos_a - cntr_pts[:, 1] * sin_a
                rot_y = cntr_pts[:, 0] * sin_a + cntr_pts[:, 1] * cos_a
                rw = max(rot_x.max() - rot_x.min(), 1e-3)
                rh = max(rot_y.max() - rot_y.min(), 1e-3)
                sx = target_w / rw
                sy = target_h / rh
                poly = Polygon(zip(rot_x * sx, rot_y * sy))
                score, _ = _evaluate_registration_candidate(poly, target_poly_m)
                ad = max(sx / max(sy, 1e-6), sy / max(sx, 1e-6))
                if ad > 1.8:
                    score -= (ad - 1.8) * 20.0
                angle_scores.append((score, deg, sx, sy))

            angle_scores.sort(key=lambda x: x[0], reverse=True)
            top_angles = angle_scores[:2]

            # B. Targeted scale & shift grid search on top angles
            c_best_score = -1e9
            c_best_params = None
            for _, deg, base_sx, base_sy in top_angles:
                rad = math.radians(deg)
                cos_a, sin_a = math.cos(rad), math.sin(rad)
                rot_x = cntr_pts[:, 0] * cos_a - cntr_pts[:, 1] * sin_a
                rot_y = cntr_pts[:, 0] * sin_a + cntr_pts[:, 1] * cos_a
                for sfx in [0.90, 1.0, 1.05]:
                    for sfy in [0.90, 1.0, 1.05]:
                        sx = base_sx * sfx
                        sy = base_sy * sfy
                        for s_shift_x in [-0.03, 0.0, 0.03]:
                            tx = s_shift_x * target_w
                            for s_shift_y in [-0.03, 0.0, 0.03]:
                                ty = s_shift_y * target_h
                                poly = Polygon(zip(rot_x * sx + tx, rot_y * sy + ty))
                                score, _ = _evaluate_registration_candidate(poly, target_poly_m)
                                ad = max(sx / max(sy, 1e-6), sy / max(sx, 1e-6))
                                if ad > 1.8:
                                    score -= (ad - 1.8) * 20.0
                                if score > c_best_score:
                                    c_best_score = score
                                    c_best_params = (deg, sx, sy, tx, ty)

            if not c_best_params:
                continue

            # C. Continuous Nelder-Mead refinement
            def loss(p):
                d, sx, sy, tx, ty = p
                r = math.radians(d)
                rx = cntr_pts[:, 0] * math.cos(r) - cntr_pts[:, 1] * math.sin(r)
                ry = cntr_pts[:, 0] * math.sin(r) + cntr_pts[:, 1] * math.cos(r)
                poly = Polygon(zip(rx * sx + tx, ry * sy + ty))
                score, _ = _evaluate_registration_candidate(poly, target_poly_m)
                ad = max(sx / max(sy, 1e-6), sy / max(sx, 1e-6))
                if ad > 1.8:
                    score -= (ad - 1.8) * 20.0
                return -score

            res = minimize(
                loss,
                x0=list(c_best_params),
                method="Nelder-Mead",
                options={"maxiter": 120, "xatol": 0.02, "fatol": 0.001}
            )
            d, sx, sy, tx, ty = res.x
            r = math.radians(d)
            rx = cntr_pts[:, 0] * math.cos(r) - cntr_pts[:, 1] * math.sin(r)
            ry = cntr_pts[:, 0] * math.sin(r) + cntr_pts[:, 1] * math.cos(r)
            final_poly = Polygon(zip(rx * sx + tx, ry * sy + ty))
            score, metrics = _evaluate_registration_candidate(final_poly, target_poly_m)

            if score > overall_best_score:
                overall_best_score = score
                overall_best_metrics = metrics
                overall_best_params = (float(d % 360.0), float(sx), float(sy), float(tx), float(ty))
                overall_best_cand_info = (cand_geom, src_center, c_pts)

        if not overall_best_params:
            return None

        best_angle, best_scale_x, best_scale_y, best_tx, best_ty = overall_best_params
        best_cand_boundary, source_center, coords_pts = overall_best_cand_info
        final_rad = math.radians(best_angle)
        cos_f, sin_f = math.cos(final_rad), math.sin(final_rad)

        # Strict containment verification & adaptive fine adjustment
        scaled_pts = [
            (((x - source_center.x) * cos_f - (y - source_center.y) * sin_f) * best_scale_x,
             ((x - source_center.x) * sin_f + (y - source_center.y) * cos_f) * best_scale_y)
            for x, y in coords_pts
        ]
        cand_final_m = Polygon([(px + best_tx, py + best_ty) for px, py in scaled_pts])
        if not target_poly_m.covers(cand_final_m):
            for shrink in [0.998, 0.995, 0.99, 0.985, 0.98]:
                sx_try = best_scale_x * shrink
                sy_try = best_scale_y * shrink
                test_pts = [
                    (((x - source_center.x) * cos_f - (y - source_center.y) * sin_f) * sx_try + best_tx,
                     ((x - source_center.x) * sin_f + (y - source_center.y) * cos_f) * sy_try + best_ty)
                    for x, y in coords_pts
                ]
                test_poly = Polygon(test_pts)
                if target_poly_m.covers(test_poly):
                    best_scale_x = sx_try
                    best_scale_y = sy_try
                    break

        def transform(x, y):
            dx = x - source_center.x
            dy = y - source_center.y
            rx = dx * cos_f - dy * sin_f
            ry = dx * sin_f + dy * cos_f
            mx = rx * best_scale_x + best_tx
            my = ry * best_scale_y + best_ty
            return (lng0 + mx / kx0, lat0 + my / ky)

        registration_diagnostics = {
            "kml_boundary_area_sqm": round(target_poly_m.area, 2),
            "pdf_layout_area_sqm": round(best_cand_boundary.area, 2),
            "scale": round((best_scale_x + best_scale_y) / 2.0, 6),
            "scale_x": round(best_scale_x, 6),
            "scale_y": round(best_scale_y, 6),
            "aspect_scale_ratio": round(best_scale_x / max(best_scale_y, 1e-6), 4),
            "rotation_deg": round(best_angle, 3),
            "translation": [round(best_tx, 3), round(best_ty, 3)],
            "coverage_ratio": round(overall_best_metrics.get("coverage", 1.0), 4),
            "spill_ratio": round(overall_best_metrics.get("spill_ratio", 0.0), 4),
            "iou": round(overall_best_metrics.get("iou", 0.0), 4),
            "edge_alignment_score": round(overall_best_metrics.get("target_fill", 0.0), 4),
            "shape_similarity": round(overall_best_metrics.get("iou", 0.0), 4),
            "registration_confidence": 0.95 if overall_best_metrics.get("iou", 0) > 0.85 else 0.85,
            "registration_method": "dynamic_anisotropic_boundary_fit",
            "registration_requires_review": False if overall_best_metrics.get("iou", 0) > 0.85 else True,
            "detected_label_count": len({
                normalize_plot_no(text[2])
                for text in ex.get("texts", [])
                if normalize_plot_no(text[2])
            }),
            "plot_candidate_face_count": len(plot_faces),
            "recovered_plot_count": int(ex.get("recovered_plot_count", 0)),
            "plot_extraction_confidence": None,
            "boundary_detection_confidence": None,
        }
        transform.diagnostics = registration_diagnostics
        ex["_last_registration_diagnostics"] = registration_diagnostics
        ex["_last_selected_pdf_boundary"] = best_cand_boundary
        ex["_last_candidate_boundaries"] = cand_boundaries
        ex["_last_target_poly_m"] = target_poly_m

        doc_type = "CAD" if ex.get("src") == "dxf" else "PDF"
        warnings.append(
            f"Placed {doc_type} layout using dynamic anisotropic boundary-shape fit "
            f"({overall_best_score:.2f} score, {overall_best_metrics.get('iou', 0):.1%} IoU, "
            f"fill {overall_best_metrics.get('target_fill', 0):.1%}, "
            f"rotation {best_angle:.2f}°, scale ratio {best_scale_x/best_scale_y:.3f})."
        )

        return transform
    except Exception as e:
        warnings.append(f"Failed to fit drawing to boundary: {e}")
        return None


def build_transform(ex, pin, warnings, control_points=None, rotation_deg=0, target_boundary=None):
    """Return fn(x, y) -> (lng, lat) in WGS84 for drawing coordinates."""
    if control_points and len(control_points.get("pdf_pts", [])) >= 2 and len(control_points.get("geo_pts", [])) >= 2:
        sol = _affine_from_points(control_points["pdf_pts"], control_points["geo_pts"])
        return (lambda x, y: tuple(float(v) for v in (np.array([x, y, 1]) @ sol))), "calibrated"

    allpts = [p for pts, _, _ in ex["lines"] + ex["polys"] for p in pts]
    if not allpts:
        raise ImportError_("No drawing geometry found in the file")
    xs, ys = [p[0] for p in allpts], [p[1] for p in allpts]
    minX, maxX, minY, maxY = min(xs), max(xs), min(ys), max(ys)

    # Fit drawing bounding box into target land boundary perimeter if provided
    if target_boundary:
        try:
            # Fit the complete drawing footprint inside the land polygon,
            # preserving its proportions with one uniform scale.
            coords = _target_boundary_ring(target_boundary)
            if len(coords) >= 4:
                fitted = _fit_drawing_to_boundary(ex, coords, warnings, target_boundary_geo=target_boundary)
                if fitted:
                    return fitted, "boundary_fitted"
            raise ImportError_("The supplied land boundary could not be used to fit the PDF drawing.")
        except Exception as e:
            if isinstance(e, ImportError_):
                raise
            warnings.append(f"Could not fit drawing into land boundary: {e}")

    if ex.get("georef"):
        sol = _affine_from_points(*ex["georef"])
        return (lambda x, y: tuple(float(v) for v in (np.array([x, y, 1]) @ sol))), "geopdf"
    if _looks_latlng(xs, ys):
        return (lambda x, y: (x, y)), "latlng"
    if _looks_utm(xs, ys):
        lat0, lng0 = (pin["lat"], pin["lng"]) if pin else (27.0, 78.0)
        zone = int((lng0 + 180) // 6) + 1
        epsg = (32600 if lat0 >= 0 else 32700) + zone
        tr = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
        cx0, cy0 = (maxX + minX) / 2, (maxY + minY) / 2
        lng_c, lat_c = tr.transform(cx0, cy0)
        is_valid_utm = False
        if pin:
            dist_km = math.hypot((lng_c - pin["lng"]) * 111.32 * math.cos(math.radians(lat_c)), (lat_c - pin["lat"]) * 110.57)
            if dist_km <= 250:
                is_valid_utm = True
        else:
            if 6.0 <= lat_c <= 38.0 and 68.0 <= lng_c <= 98.0:
                is_valid_utm = True

        if is_valid_utm:
            if not pin:
                warnings.append(f"No Google Maps link: assumed UTM zone {zone}N for the CAD coordinates")
            return (lambda x, y: tuple(float(v) for v in tr.transform(x, y))), f"utm{zone}"
    # Local / unitless drawing: fit at the Google pin or fallback location
    if not pin:
        if ex.get("src") == "dxf":
            pin = {"lat": 27.0, "lng": 78.0}
            warnings.append("CAD file has local coordinates without a Google Maps link: placed drawing at default coordinates (27.0°N, 78.0°E).")
        else:
            raise ImportError_("The file has no real-world coordinates. Add a Google Maps link so the layout can be placed on the land.")
    unit_m = ex.get("unit_m")
    if not unit_m and ex.get("src") == "dxf":
        faces = [f for f in _faces(ex) if f.area > 0]
        if faces:
            med_area = sorted(f.area for f in faces)[len(faces) // 2]
            if 800 <= med_area <= 12000:
                unit_m = M_PER_FT
                warnings.append("CAD drawing units were detected as feet (plot sizes ~1000-4000 sq ft). Preserved exact scale.")
            elif med_area > 50000:
                unit_m = 0.001
                warnings.append("CAD drawing units were detected as millimetres. Preserved exact scale.")
            else:
                unit_m = 1.0
                warnings.append("DXF has no unit header; assumed metres")
        else:
            unit_m = 1.0
            warnings.append("DXF has no unit header; assumed metres")
    cx, cy = (maxX + minX) / 2, (maxY + minY) / 2
    if unit_m is None:
        # estimate scale so that the median small face is ~200 m² (typical plot)
        faces = [f for f in _faces(ex) if f.area > 0]
        areas = sorted(f.area for f in faces)
        if not areas:
            raise ImportError_("Could not detect closed plot shapes in the PDF")
        med = areas[len(areas) // 2]
        unit_m = math.sqrt(200.0 / med)
        warnings.append("PDF has no georeference or scale note; drawing scale was estimated from plot sizes (±15%)")
    lat_per_m = 1 / 110574
    lng_per_m = 1 / (111320 * math.cos(math.radians(pin["lat"])))

    if rotation_deg:
        rad = math.radians(rotation_deg)
        cos_a, sin_a = math.cos(rad), math.sin(rad)
        def transform_rot(x, y):
            dx = (x - cx) * unit_m
            dy = (y - cy) * unit_m
            rx = dx * cos_a - dy * sin_a
            ry = dx * sin_a + dy * cos_a
            return (pin["lng"] + rx * lng_per_m, pin["lat"] + ry * lat_per_m)
        return transform_rot, f"fitted_rot_{rotation_deg}deg"

    return (lambda x, y: (pin["lng"] + (x - cx) * unit_m * lng_per_m, pin["lat"] + (y - cy) * unit_m * lat_per_m)), "fitted"


def _target_boundary_ring(target_boundary):
    """Get the explicit site outline, never an arbitrary first plot polygon."""
    if isinstance(target_boundary, list):
        return target_boundary[0] if target_boundary and isinstance(target_boundary[0], list) and target_boundary[0] and isinstance(target_boundary[0][0], (list, tuple)) else target_boundary
    if not isinstance(target_boundary, dict):
        return []
    kind = target_boundary.get("type")
    if kind == "Feature":
        return _target_boundary_ring(target_boundary.get("geometry"))
    if kind == "Polygon":
        rings = target_boundary.get("coordinates") or []
        return rings[0] if rings else []
    if kind == "MultiPolygon":
        polygons = target_boundary.get("coordinates") or []
        largest = max(polygons, key=lambda polygon: Polygon(polygon[0]).area if polygon else 0, default=[])
        return largest[0] if largest else []
    if kind != "FeatureCollection":
        return []

    features = target_boundary.get("features") or []
    boundaries = []
    polygons = []
    for feature in features:
        geometry = feature.get("geometry") or {}
        properties = feature.get("properties") or {}
        ring = _target_boundary_ring(geometry)
        if len(ring) < 4:
            continue
        polygon = Polygon(ring)
        if not polygon.is_valid or polygon.area <= 0:
            continue
        polygons.append((polygon.area, ring))
        marker = " ".join(str(properties.get(key) or "") for key in
                          ("feature_type", "boundary_type", "role", "kind", "name", "layer"))
        if BOUNDARY_WORDS.search(marker):
            boundaries.append((polygon.area, ring))
    candidates = boundaries or (polygons if len(polygons) == 1 else [])
    return max(candidates, key=lambda item: item[0])[1] if candidates else []


# ----------------------------------------------------------------------------- faces & classification
def _faces(ex):
    if ex is not None and "_cached_faces" in ex:
        return ex["_cached_faces"]
    segs = []
    direct_polys = []
    for pts, _, _ in ex.get("polys", []):
        if len(pts) >= 3:
            try:
                poly = Polygon(pts)
                if poly.is_valid and poly.area > 0:
                    direct_polys.append(poly)
            except Exception:
                pass
            segs.append(LineString(list(pts) + [pts[0]]))

    raw_lines = ex.get("lines", [])
    is_large = len(raw_lines) > 3000
    for pts, _, _ in raw_lines:
        if len(pts) >= 2:
            if is_large:
                dx = pts[1][0] - pts[0][0]
                dy = pts[1][1] - pts[0][1]
                if math.hypot(dx, dy) < 0.2:
                    continue
            segs.append(LineString(pts))

    if not segs and not direct_polys:
        return []

    polygonized_faces = []
    if segs:
        segs = [set_precision(segment, grid_size=0.001) for segment in segs]
        segs = [segment for segment in segs if not segment.is_empty and segment.length > 0]
        if segs:
            merged = unary_union(segs)
            try:
                # First attempt fast direct polygonization
                polygonized_faces = [f for f in polygonize(merged) if f.is_valid and f.area > 0]
                if not polygonized_faces:
                    snapped_merged = snap(merged, merged, 1.2)
                    polygonized_faces = [f for f in polygonize(snapped_merged) if f.is_valid and f.area > 0]
                elif not is_large and len(polygonized_faces) < 5:
                    # For small drawings with near-duplicate edges, test snapping
                    snapped_merged = snap(merged, merged, 1.2)
                    snapped_faces = [f for f in polygonize(snapped_merged) if f.is_valid and f.area > 0]
                    if len(snapped_faces) > 0:
                        polygonized_faces = snapped_faces
            except Exception:
                polygonized_faces = [f for f in polygonize(merged) if f.is_valid and f.area > 0]

    all_faces = list(direct_polys)
    for pf in polygonized_faces:
        if not any(pf.symmetric_difference(df).area < 0.01 * max(pf.area, 1e-9) for df in direct_polys):
            all_faces.append(pf)

    if ex is not None:
        ex["_cached_faces"] = all_faces
    return all_faces


def _layer_of(face, ex):
    """Best-effort: layer/fill of the closed poly that matches this face."""
    for pts, layer, fill in ex["polys"]:
        if len(pts) >= 3:
            try:
                p = Polygon(pts)
                if p.is_valid and face.symmetric_difference(p).area < 0.02 * max(face.area, 1e-9):
                    return layer, fill
            except Exception:
                pass
    return "", None


def _is_green_fill(fill):
    return bool(fill) and fill[1] > fill[0] + 0.08 and fill[1] > fill[2] + 0.08


def _is_dark_fill(fill):
    return bool(fill) and max(fill) < 0.45


def classify(ex, to_wgs, warnings):
    faces = _faces(ex)
    if not faces:
        raise ImportError_("No closed shapes could be formed from the drawing")
    is_pdf_source = "pdf_content" in ex
    # metric helper (local metres around drawing centre)
    c0 = faces[0].representative_point()
    lng0, lat0 = to_wgs(c0.x, c0.y)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110574

    def metric(poly):
        return Polygon([((lng - lng0) * kx, (lat - lat0) * ky) for lng, lat in (to_wgs(x, y) for x, y in poly.exterior.coords)])

    items = []
    for f in faces:
        m = metric(f)
        if not m.is_valid or m.area < 0.1:
            continue
        layer, fill = _layer_of(f, ex)
        items.append({"face": f, "m": m, "area": m.area, "layer": layer, "fill": fill, "texts": []})
    if not items:
        raise ImportError_("Drawing shapes are too small to be plots")
    scale_m = math.sqrt(sum(it["area"] for it in items) / max(sum(it["face"].area for it in items), 1e-12))  # metres per drawing unit
    plot_label_points = [
        Point(text[0], text[1])
        for text in ex["texts"]
        if PLOT_NO.match(str(text[2]).strip())
    ]
    for t in ex["texts"]:
        pt = Point(t[0], t[1])
        containing = [it for it in items if it["face"].covers(pt)]
        host = None
        if PLOT_NO.match(str(t[2]).strip()):
            plot_sized = [it for it in containing if it["area"] > 0]
            if plot_sized:
                host = min(plot_sized, key=lambda item: item["area"])
        elif is_pdf_source and (
            GREEN_WORDS.search(str(t[2])) or ROAD_WORDS.search(str(t[2]))
        ):
            nearest_plot_distance = min(
                (pt.distance(plot_point) for plot_point in plot_label_points),
                default=125.0,
            )
            max_distance = min(75.0, nearest_plot_distance * 0.6)
            min_area = max(100.0, nearest_plot_distance ** 2 * 0.04)
            candidates = [
                item for item in items
                if item["face"].area >= min_area
                and item["face"].distance(pt) <= max_distance
                and not any(item["face"].covers(plot_point) for plot_point in plot_label_points)
            ]
            if candidates:
                host = min(
                    candidates,
                    key=lambda item: (item["face"].distance(pt), item["area"]),
                )
        elif containing:
            host = (
                min(containing, key=lambda item: item["area"])
                if is_pdf_source
                else containing[0]
            )
        elif items:
            near = min(items, key=lambda it: it["face"].distance(pt))
            if near["face"].distance(pt) * scale_m <= 100:
                host = near
        if host is not None:
            host["texts"].append(t)
    has_numbers = any(_plot_number(it) for it in items)

    union = unary_union([it["face"] for it in items])
    outer = max(union.geoms, key=lambda g: g.area) if isinstance(union, MultiPolygon) else union
    boundary = Polygon(outer.exterior.coords)
    # drop faces that are the boundary itself or contain other faces (block outlines)
    plots, greens, roads = [], [], []
    for it in items:
        f = it["face"]
        if f.area > 0.25 * boundary.area:
            continue  # the boundary itself or the open road network between plots (rendered as base)
        txt = " ".join(t[2] for t in it["texts"])
        has_plot_no = bool(_plot_number(it))
        if is_pdf_source and not has_plot_no:
            if GREEN_WORDS.search(txt) or GREEN_WORDS.search(it["layer"]) or _is_green_fill(it["fill"]):
                greens.append(it)
                continue
            if ROAD_WORDS.search(txt) or ROAD_WORDS.search(it["layer"]):
                roads.append(it)
                continue
        contains_others = any(o is not it and f.contains(o["face"].representative_point()) and o["area"] < 0.9 * it["area"] for o in items)
        if contains_others:
            continue
        mb = it["m"].minimum_rotated_rectangle
        xs = [p[0] for p in mb.exterior.coords]; ys = [p[1] for p in mb.exterior.coords]
        e = sorted([math.dist(mb.exterior.coords[0], mb.exterior.coords[1]), math.dist(mb.exterior.coords[1], mb.exterior.coords[2])])
        aspect = e[1] / max(e[0], 0.1)
        if not has_plot_no:
            if GREEN_WORDS.search(txt) or GREEN_WORDS.search(it["layer"]) or (_is_green_fill(it["fill"]) and not has_numbers):
                greens.append(it)
                continue
            if ROAD_WORDS.search(txt) or ROAD_WORDS.search(it["layer"]) or (_is_dark_fill(it["fill"]) and not has_numbers) or (aspect > 5 and it["area"] > 150):
                roads.append(it)
                continue
        n_vertices = len(f.exterior.coords) - 1
        if n_vertices == 4 and aspect <= 6.0 and (f.area / max(f.minimum_rotated_rectangle.area, 1e-9)) > 0.85:
            clean_poly = f.minimum_rotated_rectangle
            it["face"] = clean_poly
            it["m"] = metric(clean_poly)
        plots.append(it)

    if not plots:
        # Fallback: include all items that are not boundary
        plots = [it for it in items if it["face"].area < 0.25 * boundary.area]
    if not plots:
        raise ImportError_("No plot shapes could be extracted from the drawing")
    return boundary, plots, greens, roads
    return boundary, plots, greens, roads


def _plot_number(it):
    cands = []
    for _, _, s, _ in it["texts"]:
        number = normalize_plot_no(s)
        if number:
            cands.append(number)
    return cands[0] if cands else None


def _zone_of(number):
    m = re.match(r"^([A-Z]{1,2})[-/]?\d", number or "")
    return m.group(1) if m else None


ZONE_COLORS = ["#35c7b4", "#f06b5f", "#f2b84b", "#55a8ff", "#b787f5", "#7bd389", "#ff9f68", "#6fd3e9"]


def _geo(poly, to_wgs):
    ring = [[round(v, 7) for v in to_wgs(x, y)] for x, y in poly.exterior.coords]
    return {"type": "Polygon", "coordinates": [ring]}


def _clip_plots_to_boundary(plot_docs, target_boundary_geo, to_wgs):
    """Clip plot geometries to ensure they are contained within the land boundary.
    
    This function checks each plot and clips it to the boundary if it extends beyond,
    using intersection in local metric coordinates for accuracy.
    Note: plot_docs are expected to already be in WGS84 coordinates.
    """
    if not plot_docs or not target_boundary_geo:
        return plot_docs
    
    try:
        target_boundary = shape(target_boundary_geo)
        if not target_boundary.is_valid or target_boundary.is_empty:
            return plot_docs
    except Exception:
        return plot_docs
    
    # Get boundary centroid for local coordinate conversion
    center = target_boundary.centroid
    lng0, lat0 = center.x, center.y
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110574
    
    def to_local(lng, lat):
        return ((lng - lng0) * kx, (lat - lat0) * ky)
    
    def to_wgs_local(x, y):
        return (lng0 + x / kx, lat0 + y / ky)
    
    # Convert target boundary to local coordinates
    try:
        target_boundary_local = Polygon([to_local(x, y) for x, y in target_boundary.exterior.coords])
        if not target_boundary_local.is_valid:
            target_boundary_local = target_boundary_local.buffer(0)
        if target_boundary_local.is_empty or target_boundary_local.area <= 0:
            return plot_docs
    except Exception:
        return plot_docs
    
    clipped_plots = []
    for plot in plot_docs:
        try:
            geo = plot.get("geometry", {})
            if geo.get("type") != "Polygon" or not geo.get("coordinates"):
                clipped_plots.append(plot)
                continue
            
            ring = geo["coordinates"][0]
            if len(ring) < 4:
                clipped_plots.append(plot)
                continue
            
            # Plot coordinates are already in WGS84 - convert directly to local metric
            plot_local = Polygon([to_local(lng, lat) for lng, lat in ring])
            repaired = not plot_local.is_valid
            if repaired:
                plot_local = plot_local.buffer(0)
            if plot_local.is_empty or plot_local.area <= 0:
                clipped_plots.append(plot)
                continue
            if plot_local.geom_type == "MultiPolygon":
                plot_local = max(plot_local.geoms, key=lambda geometry: geometry.area)
                repaired = True
            elif plot_local.geom_type != "Polygon":
                clipped_plots.append(plot)
                continue

            # Check if plot is already fully contained
            if target_boundary_local.covers(plot_local) and not repaired:
                clipped_plots.append(plot)
                continue

            # Clip plot to boundary
            clipped = plot_local if target_boundary_local.covers(plot_local) else plot_local.intersection(target_boundary_local)
            if clipped.is_empty or clipped.area <= 0:
                clipped_plots.append(plot)
                continue
            
            # Handle MultiPolygon result - take largest piece
            if clipped.geom_type == "MultiPolygon":
                largest = max(clipped.geoms, key=lambda g: g.area)
                clipped = largest
            elif clipped.geom_type != "Polygon":
                clipped_plots.append(plot)
                continue
            
            # Convert back to WGS84
            clipped_local_coords = list(clipped.exterior.coords)
            clipped_wgs_ring = [[round(v, 9) for v in to_wgs_local(x, y)] for x, y in clipped_local_coords]
            if len(clipped_wgs_ring) < 4:
                clipped_plots.append(plot)
                continue
            output_polygon = Polygon(clipped_wgs_ring)
            if not output_polygon.is_valid:
                output_polygon = output_polygon.buffer(0)
            if output_polygon.is_empty or not output_polygon.is_valid or output_polygon.geom_type != "Polygon":
                raise ImportError_(f"Could not repair invalid plot geometry for plot {plot.get('number', '(unknown)')}")
            clipped_wgs_ring = [[round(lng, 9), round(lat, 9)] for lng, lat in output_polygon.exterior.coords]
            clipped = Polygon([to_local(lng, lat) for lng, lat in clipped_wgs_ring])

            # Update plot geometry
            clipped_plot = plot.copy()
            clipped_plot["geometry"] = {"type": "Polygon", "coordinates": [clipped_wgs_ring]}
            
            # Recalculate area in sqm
            clipped_area = clipped.area
            clipped_plot["area_sqm"] = round(clipped_area, 1)
            clipped_plot["area_sqft"] = round(clipped_area * 10.7639, 1)
            clipped_plot["area_sqyd"] = round(clipped_area * 1.19599, 1)
            
            clipped_plots.append(clipped_plot)
        except Exception:
            clipped_plots.append(plot)
    
    return clipped_plots


def _clip_roads_to_boundary(road_docs, target_boundary_geo):
    """Clip road geometries so they strictly stay inside the target land boundary."""
    if not road_docs or not target_boundary_geo:
        return road_docs
    try:
        target_boundary = shape(target_boundary_geo)
        if not target_boundary.is_valid or target_boundary.is_empty:
            target_boundary = target_boundary.buffer(0)
        if not target_boundary.is_valid or target_boundary.is_empty:
            return road_docs
    except Exception:
        return road_docs

    clipped_roads = []
    for r in road_docs:
        try:
            geo = r.get("geometry")
            if not geo or not geo.get("coordinates"):
                clipped_roads.append(r)
                continue
            r_geom = shape(geo)
            if not r_geom.is_valid:
                r_geom = r_geom.buffer(0)
            if r_geom.is_empty:
                continue

            # If already covered, keep as is
            if target_boundary.covers(r_geom):
                clipped_roads.append(r)
                continue

            clipped = r_geom.intersection(target_boundary)
            if clipped.is_empty or clipped.area <= 0:
                continue

            if clipped.geom_type == "MultiPolygon":
                for poly in clipped.geoms:
                    if poly.is_valid and poly.area > 1e-9:
                        clipped_roads.append({
                            **r,
                            "geometry": mapping(poly)
                        })
            elif clipped.geom_type == "Polygon":
                clipped_roads.append({
                    **r,
                    "geometry": mapping(clipped)
                })
        except Exception:
            clipped_roads.append(r)
    return clipped_roads


def _clip_greens_to_boundary(green_docs, target_boundary_geo):
    """Clip green / park geometries so they strictly stay inside the target land boundary."""
    if not green_docs or not target_boundary_geo:
        return green_docs
    try:
        target_boundary = shape(target_boundary_geo)
        if not target_boundary.is_valid or target_boundary.is_empty:
            target_boundary = target_boundary.buffer(0)
        if not target_boundary.is_valid or target_boundary.is_empty:
            return green_docs
    except Exception:
        return green_docs

    clipped_greens = []
    for g in green_docs:
        try:
            geo = g.get("geometry")
            if not geo or not geo.get("coordinates"):
                clipped_greens.append(g)
                continue
            g_geom = shape(geo)
            if not g_geom.is_valid:
                g_geom = g_geom.buffer(0)
            if g_geom.is_empty:
                continue

            if target_boundary.covers(g_geom):
                clipped_greens.append(g)
                continue

            clipped = g_geom.intersection(target_boundary)
            if clipped.is_empty or clipped.area <= 0:
                continue

            if clipped.geom_type == "MultiPolygon":
                for poly in clipped.geoms:
                    if poly.is_valid and poly.area > 1e-9:
                        clipped_greens.append({
                            **g,
                            "geometry": mapping(poly)
                        })
            elif clipped.geom_type == "Polygon":
                clipped_greens.append({
                    **g,
                    "geometry": mapping(clipped)
                })
        except Exception:
            clipped_greens.append(g)
    return clipped_greens



def _plot_boundary_coverage(plot_docs, target_boundary_geo, to_wgs, min_area_coverage=0.9):
    """Calculate the fraction of plots that have at least min_area_coverage of their area inside the boundary.
    
    Note: plot_docs are expected to already be in WGS84 coordinates.
    to_wgs parameter is kept for API compatibility but not used since plots are already in WGS84.
    """
    if not plot_docs or not target_boundary_geo:
        return None
    
    try:
        target_boundary = shape(target_boundary_geo)
        if not target_boundary.is_valid or target_boundary.is_empty:
            return None
    except Exception:
        return None
    
    # Get boundary centroid for local coordinate conversion
    center = target_boundary.centroid
    lng0, lat0 = center.x, center.y
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110574
    
    def to_local(lng, lat):
        return ((lng - lng0) * kx, (lat - lat0) * ky)
    
    # Convert target boundary to local coordinates
    try:
        target_boundary_local = Polygon([to_local(x, y) for x, y in target_boundary.exterior.coords])
        if not target_boundary_local.is_valid:
            target_boundary_local = target_boundary_local.buffer(0)
        if target_boundary_local.is_empty or target_boundary_local.area <= 0:
            return None
    except Exception:
        return None
    
    contained_count = 0
    for plot in plot_docs:
        try:
            geo = plot.get("geometry", {})
            if geo.get("type") != "Polygon" or not geo.get("coordinates"):
                continue
            
            ring = geo["coordinates"][0]
            if len(ring) < 4:
                continue
            
            # Plot coordinates are already in WGS84 - convert directly to local metric
            plot_local = Polygon([to_local(lng, lat) for lng, lat in ring])
            if not plot_local.is_valid:
                plot_local = plot_local.buffer(0)
            if plot_local.is_empty or plot_local.area <= 0:
                continue
            
            # Calculate intersection area relative to plot area
            intersection = plot_local.intersection(target_boundary_local)
            if not intersection.is_empty:
                coverage = intersection.area / plot_local.area
                if coverage >= min_area_coverage:
                    contained_count += 1
        except Exception:
            continue
    
    return contained_count / len(plot_docs) if plot_docs else None


def _plot_footprint_ratio(plot_docs, target_boundary_geo):
    """Measure how much of a land boundary is covered by the imported plots."""
    if not plot_docs or not target_boundary_geo:
        return None
    try:
        boundary = Polygon(_target_boundary_ring(target_boundary_geo))
        if not boundary.is_valid:
            boundary = boundary.buffer(0)
        if boundary.is_empty or boundary.area <= 0:
            return None
        anchor = boundary.representative_point()
        local_crs = f"+proj=aeqd +lat_0={anchor.y} +lon_0={anchor.x} +datum=WGS84 +units=m +no_defs"
        project = Transformer.from_crs("EPSG:4326", local_crs, always_xy=True).transform
        boundary_m = transform_geometry(project, boundary)
        plot_geometries = []
        for plot in plot_docs:
            geometry = shape(plot.get("geometry") or {})
            if not geometry.is_empty and geometry.area > 0:
                plot_geometries.append(transform_geometry(project, geometry))
        if not plot_geometries or boundary_m.area <= 0:
            return None
        plot_union = unary_union(plot_geometries)
        return plot_union.intersection(boundary_m).area / boundary_m.area
    except Exception:
        logger.exception("Could not calculate imported plot footprint coverage")
        return None


def _dims(mpoly):
    coords = list(mpoly.exterior.coords)[:-1]
    sides = [math.dist(coords[i], coords[(i + 1) % len(coords)]) for i in range(len(coords))]
    n = len(coords)
    rect = n == 4 and abs(sides[0] - sides[2]) < 0.6 and abs(sides[1] - sides[3]) < 0.6
    shape = "triangular" if n == 3 else "rectangular" if rect else "diagonal" if n == 4 else "polygon"
    shown = sides[:2] if rect else sides
    return shape, n, " × ".join(f"{s:.1f}m" for s in shown), sides


def _numbered_plot_docs(cells, to_wgs, colony_id, now, boundary):
    entries = [
        {"number": number, "face": face}
        for number, face in cells.items()
    ]
    entries.sort(key=lambda item: (-round(item["face"].centroid.y, 1), item["face"].centroid.x))

    center = boundary.centroid
    if -180 <= center.x <= 180 and -90 <= center.y <= 90:
        lng0, lat0 = center.x, center.y
    else:
        res = to_wgs(center.x, center.y)
        lng0, lat0 = res[0], res[1]
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110574
    for item in entries:
        metric = Polygon([
            ((to_wgs(x, y)[0] - lng0) * kx, (to_wgs(x, y)[1] - lat0) * ky)
            for x, y in item["face"].exterior.coords
        ])
        item["metric"] = metric
        item["area"] = metric.area

    prefixes = {_zone_of(item["number"]) for item in entries if _zone_of(item["number"])}
    if 2 <= len(prefixes) <= 8:
        codes = sorted(prefixes)
        zone_key = lambda item: _zone_of(item["number"]) or codes[0]
    elif len(entries) >= 12:
        cx, cy = boundary.centroid.x, boundary.centroid.y
        codes = ["A", "B", "C", "D"]
        def zone_key(item):
            point = item["face"].centroid
            if point.x < cx:
                return "A" if point.y >= cy else "C"
            return "B" if point.y >= cy else "D"
    else:
        codes = ["A"]
        zone_key = lambda item: "A"

    zone_docs = []
    zone_faces = defaultdict(list)
    for item in entries:
        item["zone_code"] = zone_key(item)
        zone_faces[item["zone_code"]].append(item["face"])
    for index, code in enumerate(codes):
        if not zone_faces.get(code):
            continue
        hull = unary_union(zone_faces[code]).convex_hull
        zone_docs.append({
            "id": f"zone-{colony_id}-{code.lower()}",
            "colony_id": colony_id,
            "code": code,
            "name": f"Zone {code}",
            "color": ZONE_COLORS[index % len(ZONE_COLORS)],
            "geometry": _geo(hull, to_wgs),
            "sort_order": index,
            "created_at": now,
        })

    plot_docs = []
    for item in entries:
        shape_name, sides, dimensions, side_lengths = _dims(item["metric"])
        area = round(item["area"], 1)
        number = item["number"]
        plot_docs.append({
            "id": f"plot-{colony_id}-{number.lower()}",
            "colony_id": colony_id,
            "zone_id": f"zone-{colony_id}-{item['zone_code'].lower()}",
            "number": number,
            "area_sqm": area,
            "area_sqft": round(area * 10.7639, 1),
            "area_sqyd": round(area * 1.19599, 1),
            "width_m": round(min(side_lengths), 2),
            "depth_m": round(max(side_lengths), 2),
            "shape": shape_name,
            "sides": sides,
            "dimensions": dimensions,
            "status_id": "available",
            "geometry": _geo(item["face"], to_wgs),
            "notes": "",
            "created_at": now,
        })
    return zone_docs, plot_docs


def _first_prop(props, keys, default=None):
    for k in keys:
        if k in props and props[k] is not None:
            return props[k]
    return default

def _point_label_calibration(ex, target_boundary=None):
    if not isinstance(target_boundary, dict):
        return None
    features = target_boundary.get("features")
    if not features or not isinstance(features, list):
        return None
    point_features = [
        f for f in features
        if isinstance(f, dict) and f.get("geometry", {}).get("type") == "Point"
    ]
    if len(point_features) < 2:
        return None

    geo_pts = []
    pdf_pts = []
    plot_texts = {}
    pdf_text_map = defaultdict(list)
    for x, y, label, _ in ex.get("texts", []):
        no = normalize_plot_no(label)
        if no:
            pdf_text_map[no].append((x, y))

    for feat in point_features:
        props = feat.get("properties") or {}
        no = normalize_plot_no(_first_prop(props, ("plot_number", "plot_no", "number", "name")))
        coords = feat.get("geometry", {}).get("coordinates")
        if no and coords and len(coords) >= 2 and no in pdf_text_map:
            pdf_cand = pdf_text_map[no]
            if pdf_cand:
                best_cand = pdf_cand[0]
                pdf_pts.append(best_cand)
                geo_pts.append((coords[0], coords[1]))
                plot_texts[no] = best_cand

    if len(pdf_pts) < 2:
        return None

    try:
        sol = _affine_from_points(pdf_pts, geo_pts)
        return {"solution": sol, "plot_texts": plot_texts}
    except Exception:
        return None


def import_file(
    data,
    filename,
    maps_link,
    colony_id,
    now,
    control_points=None,
    rotation_deg=0,
    target_boundary=None,
    extracted_pdf=None,
):
    warnings = []
    name = (filename or "").lower()
    if name.endswith(".dxf"):
        ex = _extract_dxf(data, filename=filename)
    elif name.endswith(".pdf"):
        ex = extracted_pdf or _extract_pdf(data)
        if ex.get("pdf_content", {}).get("page_count", 0) > 1:
            warnings.append(
                "This PDF contains multiple pages; plot extraction currently uses page 1 only."
            )
    elif name.endswith(".dwg") or name.endswith(".dwf"):
        ex = _extract_dxf(data, is_dwg=True, filename=filename)
    else:
        raise ImportError_("Upload a CAD (.dwg, .dxf, .dwf) or PDF layout file")
    pin = parse_maps_link(maps_link)
    if maps_link and not pin:
        warnings.append("Google Maps link could not be parsed; it was ignored")
    point_calibration = _point_label_calibration(ex, target_boundary)
    is_pdf_source = name.endswith(".pdf")
    is_cad_source = name.endswith((".dwg", ".dxf", ".dwf"))
    labeled_cells = (
        _labeled_plot_polygons(ex)
        if is_cad_source or (is_pdf_source and target_boundary)
        else None
    )
    ex["recovered_plot_count"] = len(labeled_cells or {})
    recovered_count = len({cell.wkb for cell in (labeled_cells or {}).values()}) if labeled_cells else 0
    label_numbers = sorted({
        number
        for text in ex.get("texts", [])
        if len(text) >= 3 and (number := normalize_plot_no(text[2]))
    })
    if is_pdf_source and target_boundary:
        if point_calibration and isinstance(point_calibration, dict) and "plot_texts" in point_calibration:
            pdf_texts = point_calibration["plot_texts"]
        else:
            pdf_texts = {}
            for text in ex.get("texts", []):
                label = text[2].strip() if len(text) >= 3 and text[2] else ""
                no = normalize_plot_no(label)
                if no and no not in pdf_texts:
                    pdf_texts[no] = (text[0], text[1])
        if pdf_texts:
            expected_numbers = set(pdf_texts.keys())
            recovered_numbers = set(labeled_cells or {}) if labeled_cells else set()
            missing_numbers = sorted(
                expected_numbers - recovered_numbers,
                key=lambda number: (not number.isdigit(), int(number) if number.isdigit() else number),
            )
            if labeled_cells is None:
                labeled_cells = {}
            if missing_numbers:
                warnings.append(
                    f"{len(missing_numbers)} of {len(expected_numbers)} PDF plot labels "
                    "did not have a confidently recovered parcel boundary and were not "
                    "created as plot records."
                )
    transform_source = ex
    if labeled_cells and len(labeled_cells) >= 3:
        transform_source = {
            **ex,
            "polys": [(list(cell.exterior.coords)[:-1], "", None) for cell in labeled_cells.values()],
        }
    to_wgs, mode = build_transform(
        transform_source,
        pin,
        warnings,
        control_points=control_points,
        rotation_deg=rotation_deg,
        target_boundary=target_boundary,
    )
    try:
        boundary, plots, greens, roads = classify(ex, to_wgs, warnings)
    except ImportError_:
        if labeled_cells:
            if target_boundary:
                boundary = Polygon(_target_boundary_ring(target_boundary))
            else:
                boundary = unary_union(list(labeled_cells.values())).convex_hull
            plots, greens, roads = [], [], []
        else:
            raise
    if labeled_cells and (is_pdf_source or is_cad_source):
        zone_docs, plot_docs = _numbered_plot_docs(labeled_cells, to_wgs, colony_id, now, boundary)
        warnings[:] = [
            warning for warning in warnings
            if "plots were numbered automatically" not in warning
        ]
        recovered_numbers = set(labeled_cells)
        expected_numbers = set(pdf_texts) if is_pdf_source else set(label_numbers)
        unmatched_numbers = sorted(
            expected_numbers - recovered_numbers,
            key=lambda number: (not number.isdigit(), int(number) if number.isdigit() else number),
        )
        if is_cad_source:
            warnings.append(
                f"Recovered {len(recovered_numbers)} of {len(expected_numbers)} recognized CAD plot labels "
                "as verified plot boundaries; unmatched labels were not saved as plots."
            )
        elif unmatched_numbers:
            warnings.append(
                f"Recovered {len(plot_docs)} plot parcels from PDF boundaries; "
                f"{len(unmatched_numbers)} labels remain unmatched."
            )
        else:
            warnings.append(
                f"Recovered {len(plot_docs)} numbered plot parcels from the PDF vector boundaries."
            )
        # Clip plots to boundary if target_boundary is provided
        if target_boundary:
            plot_docs = _clip_plots_to_boundary(plot_docs, target_boundary, to_wgs)
            # Check boundary coverage and warn if insufficient
            coverage = _plot_boundary_coverage(plot_docs, target_boundary, 0.85)
            if coverage is not None and coverage < 0.7:
                warnings.append(
                    f"Only {round(coverage * 100)}% of plot parcels have at least 85% of their area inside the land boundary after clipping."
                )
    elif is_cad_source:
        zone_docs, plot_docs = [], []
        if label_numbers:
            warnings.append(
                f"Found {len(label_numbers)} recognized CAD plot labels but could not confidently "
                "recover any plot boundaries; no plots were created."
            )
        else:
            warnings.append("No recognized plot labels were found in the CAD drawing; no plots were created.")
        unmatched_numbers = label_numbers
    else:
        plot_docs = None
        unmatched_numbers = []

    # sanity: compare with pin (if any)
    if pin:
        c = boundary.centroid
        lng, lat = to_wgs(c.x, c.y)
        dist = math.hypot((lng - pin["lng"]) * 111320 * math.cos(math.radians(lat)), (lat - pin["lat"]) * 110574)
        if mode != "fitted" and dist > 1500:
            warnings.append(f"Layout is {dist/1000:.1f} km from the Google Maps pin — check the file's coordinate system")

    if plot_docs is None:
        # numbering: from texts when present; otherwise reading order
        plots.sort(key=lambda it: (-round(it["face"].centroid.y, 1), it["face"].centroid.x))
        numbers, used = [], set()
        for it in plots:
            n = _plot_number(it)
            if n and n not in used:
                used.add(n)
            else:
                n = None
            numbers.append(n)
        seq = 1
        for i, n in enumerate(numbers):
            if n is None:
                while str(seq) in used:
                    seq += 1
                numbers[i] = str(seq); used.add(str(seq)); seq += 1
        if all(_plot_number(it) is None for it in plots):
            warnings.append("No plot numbers found in the drawing — plots were numbered automatically")

        # zones: from number prefixes, else quadrants
        prefixes = {_zone_of(n) for n in numbers if _zone_of(n)}
        if 2 <= len(prefixes) <= 8:
            zone_key = lambda it, n: _zone_of(n) or sorted(prefixes)[0]  # noqa: E731
            codes = sorted(prefixes)
        elif len(plots) >= 12:
            cx, cy = boundary.centroid.x, boundary.centroid.y
            zone_key = lambda it, n: ("A" if it["face"].centroid.y >= cy else "C") if it["face"].centroid.x < cx else ("B" if it["face"].centroid.y >= cy else "D")  # noqa: E731
            codes = ["A", "B", "C", "D"]
        else:
            zone_key = lambda it, n: "A"  # noqa: E731
            codes = ["A"]

        zone_docs = []
        zone_faces = defaultdict(list)
        for it, n in zip(plots, numbers):
            zone_faces[zone_key(it, n)].append(it["face"])
        for i, code in enumerate(codes):
            if not zone_faces.get(code):
                continue
            hull = unary_union(zone_faces[code]).convex_hull.buffer(0)
            zone_docs.append({"id": f"zone-{colony_id}-{code.lower()}", "colony_id": colony_id, "code": code, "name": f"Zone {code}",
                              "color": ZONE_COLORS[i % len(ZONE_COLORS)], "geometry": _geo(hull, to_wgs), "sort_order": i, "created_at": now})

        plot_docs = []
        for it, n in zip(plots, numbers):
            shape, sides, dims, side_lens = _dims(it["m"])
            area = round(it["area"], 1)
            plot_docs.append({
                "id": f"plot-{colony_id}-{n.lower()}", "colony_id": colony_id, "zone_id": f"zone-{colony_id}-{zone_key(it, n).lower()}",
                "number": n, "area_sqm": area, "area_sqft": round(area * 10.7639, 1), "area_sqyd": round(area * 1.19599, 1),
                "width_m": round(min(side_lens), 2), "depth_m": round(max(side_lens), 2), "shape": shape, "sides": sides,
                "dimensions": dims, "status_id": "available", "geometry": _geo(it["face"], to_wgs), "notes": "", "created_at": now,
            })
        
        # Clip plots to boundary if target_boundary is provided
        if target_boundary:
            plot_docs = _clip_plots_to_boundary(plot_docs, target_boundary, to_wgs)
            # Check boundary coverage and warn if insufficient
            coverage = _plot_boundary_coverage(plot_docs, target_boundary, 0.85)
            if coverage is not None and coverage < 0.7:
                warnings.append(
                    f"Only {round(coverage * 100)}% of plot parcels have at least 85% of their area inside the land boundary after clipping."
                )

    def label(it, default):
        words = [t[2] for t in it["texts"] if not PLOT_NO.match(t[2].strip())]
        return (" ".join(words)[:40] if words else default).title()

    bc = boundary.centroid
    if -180 <= bc.x <= 180 and -90 <= bc.y <= 90:
        lng, lat = bc.x, bc.y
    else:
        res = to_wgs(bc.x, bc.y)
        lng, lat = res[0], res[1]

    if target_boundary:
        final_boundary_geo = target_boundary
        t_ring = _target_boundary_ring(target_boundary)
        if len(t_ring) >= 4:
            t_poly = Polygon(t_ring)
            t_c = t_poly.centroid
            lat, lng = t_c.y, t_c.x
    else:
        final_boundary_geo = _geo(boundary, to_wgs)

    reg_metrics = dict(getattr(to_wgs, "diagnostics", None) or ex.get("_last_registration_diagnostics", {}))
    plot_footprint_ratio = _plot_footprint_ratio(plot_docs, target_boundary)
    if plot_footprint_ratio is not None:
        reg_metrics["plot_footprint_ratio"] = round(plot_footprint_ratio, 4)
        if mode == "boundary_fitted" and len(plot_docs) >= 20 and plot_footprint_ratio < 0.1:
            warnings.append(
                f"Plot parcels cover only {plot_footprint_ratio:.1%} of the land boundary. "
                "Review the extracted parcel geometry and source drawing before publishing."
            )
    if is_cad_source:
        reg_metrics.update({
            "detected_plot_label_count": len(label_numbers),
            "matched_plot_label_count": len(label_numbers) - len(unmatched_numbers),
            "interactive_plot_count": len(plot_docs),
            "unmatched_plot_numbers": unmatched_numbers,
        })

    colony_fields = {
        "layout_version": "imported",
        "import_source": {
            "filename": filename,
            "mode": mode,
            "warnings": warnings,
            "pdf_content": ex.get("pdf_content"),
            "imported_at": now,
            "plots": len(plot_docs),
            "greens": len(greens),
            "roads": len(roads),
            "registration_metrics": reg_metrics,
            "diagnostics": reg_metrics,
        },
        "maps_link": maps_link or None,
        "map_center": {"lat": round(lat, 7), "lng": round(lng, 7)},
        "boundary": final_boundary_geo,
        "greens": _clip_greens_to_boundary([{"name": label(g, "Garden"), "geometry": _geo(g["face"], to_wgs)} for g in greens], target_boundary) if target_boundary else [{"name": label(g, "Garden"), "geometry": _geo(g["face"], to_wgs)} for g in greens],
        "roads": _clip_roads_to_boundary([{"name": label(r, "Road"), "width_m": round(min(_dims(r["m"])[3]), 1) if len(r["m"].exterior.coords) <= 5 else None,
                   "geometry": _geo(r["face"], to_wgs)} for r in roads], target_boundary) if target_boundary else [{"name": label(r, "Road"), "width_m": round(min(_dims(r["m"])[3]), 1) if len(r["m"].exterior.coords) <= 5 else None,
                   "geometry": _geo(r["face"], to_wgs)} for r in roads],
        "entry_road": None, "entrance": None, "entry_centerline": None,
        "total_area_sqm": round(sum(p["area_sqm"] for p in plot_docs) + sum(g["area"] for g in greens) + sum(r["area"] for r in roads)),
    }
    colony_fields["import_source"]["plots"] = len(plot_docs)

    # Dynamic Debug Artifacts Package Generation
    try:
        debug_dir = os.environ.get(
            "GIS_DEBUG_DIR",
            os.path.join(tempfile.gettempdir(), "livemap-gis-debug", f"import_{colony_id}")
        )
        target_poly_m = ex.get("_last_target_poly_m")
        selected_pdf_b = ex.get("_last_selected_pdf_boundary")
        cand_b = ex.get("_last_candidate_boundaries", [])
        
        components_list = []
        if ex.get("lines"):
            components_list.append({
                "geometry": MultiLineString([LineString(p) for p, _, _ in ex["lines"] if len(p) >= 2]),
                "classification": "PLOT_LINEWORK",
                "line_count": len(ex["lines"]),
            })
            
        plot_val = {
            "total_plots": len(plot_docs),
            "recovered_vector_plots": recovered_count if 'recovered_count' in locals() else len(plot_docs),
            "fallback_plots": (len(plot_docs) - recovered_count) if 'recovered_count' in locals() else 0,
            "total_area_sqm": colony_fields["total_area_sqm"],
        }
        
        diagnostics_written = generate_debug_package(
            output_dir=debug_dir,
            pdf_bytes=data if (filename or "").lower().endswith(".pdf") else None,
            raw_lines=ex.get("lines"),
            raw_polys=ex.get("polys"),
            texts=ex.get("texts"),
            labels=[t for t in ex.get("texts", []) if PLOT_NO.match(str(t[2]).strip())],
            components=components_list,
            candidate_boundaries=cand_b,
            selected_boundary=selected_pdf_b,
            kml_boundary=target_boundary,
            pre_reg_plots=labeled_cells if ('labeled_cells' in locals() and labeled_cells) else None,
            reg_overlay={"target_kml_metric": target_poly_m} if target_poly_m else None,
            final_plots=plot_docs,
            registration_metrics=reg_metrics,
            plot_validation=plot_val,
        )
        if diagnostics_written:
            logger.info("GIS import diagnostic bundle written to %s", debug_dir)
    except Exception:
        logger.exception("Could not write GIS import diagnostic bundle")

    return colony_fields, zone_docs, plot_docs, warnings


def to_geojson(colony, zones, plots):
    feats = [{"type": "Feature", "properties": {"kind": "boundary", "name": colony["name"]}, "geometry": colony["boundary"]}]
    feats += [{"type": "Feature", "properties": {"kind": "green", "name": g["name"]}, "geometry": g["geometry"]} for g in colony.get("greens", [])]
    feats += [{"type": "Feature", "properties": {"kind": "road", "name": r["name"], "width_m": r.get("width_m")}, "geometry": r["geometry"]} for r in colony.get("roads", [])]
    feats += [{"type": "Feature", "properties": {"kind": "zone", "code": z["code"], "name": z["name"], "color": z["color"]}, "geometry": z["geometry"]} for z in zones]
    feats += [{"type": "Feature", "properties": {"kind": "plot", "number": p["number"], "zone_id": p["zone_id"], "status": p["status_id"],
                                                  "area_sqm": p["area_sqm"], "dimensions": p["dimensions"], "shape": p["shape"]}, "geometry": p["geometry"]} for p in plots]
    return {"type": "FeatureCollection", "features": feats}
