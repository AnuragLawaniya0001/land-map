"""Generate sample layout files for import testing (DXF lat/lng, DXF UTM lines, GeoPDF, scaled PDF)."""
import os
import sys
import ezdxf
import pymupdf
from pyproj import Transformer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import layout  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
os.makedirs(OUT, exist_ok=True)
CENTER = {"lat": 22.2196, "lng": 73.1051}   # a different field so the imported colony doesn't overlap the demo
lay = layout.build_layout()
to_ll = lambda poly: [tuple(layout._lnglat(x, y, CENTER, 0.0)) for x, y in poly]  # noqa: E731
cen = lambda poly: (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))  # noqa: E731


def dxf_latlng():
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    for name in ("BOUNDARY", "PLOTS", "GREEN", "ROADS", "TEXT"):
        doc.layers.add(name)
    msp.add_lwpolyline(to_ll(layout.BOUNDARY), close=True, dxfattribs={"layer": "BOUNDARY"})
    for i, p in enumerate(lay["plots"], start=1):
        pts = to_ll(p["poly"])
        msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "PLOTS"})
        c = cen(pts)
        msp.add_text(str(i), dxfattribs={"layer": "TEXT", "height": 0.00002}).set_placement(c)
    for g in lay["greens"]:
        pts = to_ll(g["geometry"])
        msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "GREEN"})
        msp.add_text(g["name"].upper(), dxfattribs={"layer": "TEXT", "height": 0.00002}).set_placement(cen(pts))
    doc.saveas(os.path.join(OUT, "layout_latlng.dxf"))


def dxf_utm_lines():
    tr = Transformer.from_crs("EPSG:4326", "EPSG:32643", always_xy=True)
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 6
    msp = doc.modelspace()
    def utm(poly):
        return [tr.transform(lng, lat) for lng, lat in to_ll(poly)]
    b = utm(layout.BOUNDARY)
    for i in range(len(b)):
        msp.add_line(b[i], b[(i + 1) % len(b)])
    for i, p in enumerate(lay["plots"], start=1):
        pts = utm(p["poly"])
        for k in range(len(pts)):
            msp.add_line(pts[k], pts[(k + 1) % len(pts)])
        msp.add_text(f"P-{i}" if i % 2 else str(i), dxfattribs={"height": 1.5}).set_placement(cen(pts))
    for g in lay["greens"]:
        pts = utm(g["geometry"])
        for k in range(len(pts)):
            msp.add_line(pts[k], pts[(k + 1) % len(pts)])
        msp.add_text(g["name"].upper(), dxfattribs={"height": 2}).set_placement(cen(pts))
    doc.saveas(os.path.join(OUT, "layout_utm_lines.dxf"))


def _draw_pdf(path, georef):
    # page units: 1 pt = 1 m / scale  (scale 1:500 -> 1 pt = 500 * 0.0254/72 m = 0.176 m)
    scale = 1000
    m_per_pt = 0.0254 / 72 * scale
    W, H = 700, 700
    doc = pymupdf.open()
    page = doc.new_page(width=W, height=H)
    def pt(x, y):  # local metres -> page coords (y down)
        return pymupdf.Point(W / 2 + x / m_per_pt, H / 2 - y / m_per_pt)
    def poly(pts, color, fill=None, width=0.6):
        shape = page.new_shape()
        shape.draw_polyline([pt(*p) for p in pts] + [pt(*pts[0])])
        shape.finish(color=color, fill=fill, width=width, closePath=True)
        shape.commit()
    poly(layout.BOUNDARY, (0, 0.5, 0), width=1.2)
    for g in lay["greens"]:
        poly(g["geometry"], (0.2, 0.5, 0.2), fill=(0.55, 0.8, 0.45))
        c = cen(g["geometry"])
        page.insert_text(pt(c[0] - 6, c[1]), g["name"].upper(), fontsize=4)
    for r in lay["roads"]:
        poly(r["geometry"], (0.3, 0.3, 0.3), fill=(0.35, 0.35, 0.35))
    for i, p in enumerate(lay["plots"], start=1):
        poly(p["poly"], (0, 0, 0))
        c = cen(p["poly"])
        page.insert_text(pt(c[0] - 2, c[1] - 1.5), str(i), fontsize=5)
    page.insert_text(pymupdf.Point(20, 20), "DURGA ENCLAVE - LAYOUT PLAN   SCALE 1:1000", fontsize=9)
    if georef:
        # GeoPDF: viewport covering the whole page with WGS84 corner coordinates
        x0, y0 = (-W / 2) * m_per_pt, (-H / 2) * m_per_pt
        x1, y1 = (W / 2) * m_per_pt, (H / 2) * m_per_pt
        corners = [layout._lnglat(x0, y0, CENTER, 0.0), layout._lnglat(x0, y1, CENTER, 0.0),
                   layout._lnglat(x1, y1, CENTER, 0.0), layout._lnglat(x1, y0, CENTER, 0.0)]  # LL, UL, UR, LR in geo
        gpts = " ".join(f"{lat} {lng}" for lng, lat in corners)
        mref = doc.get_new_xref()
        doc.update_object(mref, f"<< /Type /Measure /Subtype /GEO /Bounds [0 0 0 1 1 1 1 0] /GPTS [{gpts}] /LPTS [0 0 0 1 1 1 1 0] /GCS << /Type /GEOGCS /EPSG 4326 >> >>")
        vref = doc.get_new_xref()
        doc.update_object(vref, f"<< /Type /Viewport /BBox [0 0 {W} {H}] /Name (Layout) /Measure {mref} 0 R >>")
        doc.xref_set_key(page.xref, "VP", f"[{vref} 0 R]")
    doc.save(path)


if __name__ == "__main__":
    dxf_latlng()
    dxf_utm_lines()
    _draw_pdf(os.path.join(OUT, "layout_geo.pdf"), True)
    _draw_pdf(os.path.join(OUT, "layout_scaled.pdf"), False)
    print("fixtures written to", OUT, "centre", CENTER)
