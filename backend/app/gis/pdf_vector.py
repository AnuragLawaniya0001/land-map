"""
Vector PDF plot extraction using PyMuPDF vector paths.
For vector PDFs with high line count, this is more accurate than OpenCV raster extraction.
"""

import fitz
from shapely.geometry import Polygon, Point


def extract_vector_plots(doc, pdf_scale=2.0):
    """Extract plot rectangles from vector PDF paths + associate text labels.
    
    Args:
        doc: PyMuPDF document
        pdf_scale: Scale factor for coordinates (default 2.0 for high-res)
    
    Returns:
        List of dicts with 'pts', 'area_px', 'number' keys
    """
    page = doc[0]
    
    # 1. Extract all text items with positions
    text_items = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                t = span["text"].strip()
                if t and t.isdigit():  # Only plot numbers
                    x0, y0, x1, y1 = span["bbox"]
                    cx = ((x0 + x1) / 2) * pdf_scale
                    cy = ((y0 + y1) / 2) * pdf_scale
                    text_items.append({"text": t, "cx": cx, "cy": cy})
    
    print(f"[VECTOR] Found {len(text_items)} numeric text labels")
    
    # 2. Extract vector rectangles (plots)
    plots = []
    drawings = page.get_drawings()
    
    for d in drawings:
        for item in d["items"]:
            pts = None
            if item[0] == "re":  # rectangle
                r = item[1]
                pts = [(r.x0 * pdf_scale, r.y0 * pdf_scale),
                       (r.x1 * pdf_scale, r.y0 * pdf_scale),
                       (r.x1 * pdf_scale, r.y1 * pdf_scale),
                       (r.x0 * pdf_scale, r.y1 * pdf_scale)]
            elif item[0] == "qu":  # quad
                pts = [(p.x * pdf_scale, p.y * pdf_scale) for p in item[1]]
            
            if not pts:
                continue
            
            # Validate as polygon
            try:
                poly = Polygon(pts)
                if poly.is_empty or poly.area < 500:
                    continue
                # Aspect ratio check — reject thin slivers
                minx, miny, maxx, maxy = poly.bounds
                w, h = maxx - minx, maxy - miny
                if w < 5 or h < 5:
                    continue
                aspect = max(w, h) / min(w, h)
                if aspect > 10:  # Too thin (walls/borders, not plots)
                    continue
            except Exception:
                continue
            
            # Match nearest text label
            cx, cy = poly.centroid.x, poly.centroid.y
            best_label = None
            best_dist = 100 * pdf_scale  # Max distance
            for t in text_items:
                d2 = ((t["cx"] - cx) ** 2 + (t["cy"] - cy) ** 2) ** 0.5
                if d2 < best_dist:
                    best_dist = d2
                    best_label = t["text"]
            
            plots.append({
                "pts": pts,
                "area_px": poly.area,
                "number": best_label,  # ← Real plot number!
            })
    
    print(f"[VECTOR] Extracted {len(plots)} valid plots")
    return plots
