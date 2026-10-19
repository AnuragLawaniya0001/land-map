"""Dynamic generation of comprehensive GIS import debug artifacts.

Exports 14 standardized diagnostic artifacts for any KML + PDF mapping execution:
  01_original_pdf.png
  02_normalized_pdf_geometry.png
  03_detected_text_labels.geojson
  04_label_clusters.geojson
  05_vector_components.geojson
  06_component_classification.geojson
  07_candidate_pdf_boundaries.geojson
  08_selected_pdf_boundary.geojson
  09_kml_boundary.geojson
  10_pre_registration_plots.geojson
  11_registration_overlay.geojson
  12_final_plots.geojson
  13_registration_metrics.json
  14_plot_validation.json
"""

import json
import logging
import os
import pymupdf
from shapely.geometry import mapping, Point, LineString, Polygon, MultiPolygon

logger = logging.getLogger(__name__)


def _safe_dump_json(obj, filepath):
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, default=str)


def generate_debug_package(
    output_dir: str,
    pdf_bytes: bytes = None,
    raw_lines: list = None,
    raw_polys: list = None,
    texts: list = None,
    labels: list = None,
    label_clusters: list = None,
    components: list = None,
    candidate_boundaries: list = None,
    selected_boundary = None,
    kml_boundary = None,
    pre_reg_plots: dict = None,
    reg_overlay: dict = None,
    final_plots: list = None,
    registration_metrics: dict = None,
    plot_validation: dict = None,
) -> bool:
    """Dynamically export the 14 debug artifacts into output_dir."""
    try:
        os.makedirs(output_dir, exist_ok=True)

        # 01_original_pdf.png
        if pdf_bytes:
            try:
                doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
                if len(doc) > 0:
                    page_w = float(page.rect.width)
                    page_h = float(page.rect.height)
                    max_dim = max(page_w, page_h, 1.0)
                    safe_scale = max(0.2, min(150.0 / 72.0, 2000.0 / max_dim))
                    pix = page.get_pixmap(matrix=pymupdf.Matrix(safe_scale, safe_scale))
                    pix.save(os.path.join(output_dir, "01_original_pdf.png"))
            except Exception:
                pass

        # 02_normalized_pdf_geometry.png
        if raw_lines is not None or raw_polys is not None:
            try:
                import matplotlib
                matplotlib.use("Agg")
                import matplotlib.pyplot as plt

                fig, ax = plt.subplots(figsize=(10, 10))
                ax.set_facecolor("#1e293b")
                fig.patch.set_facecolor("#0f172a")

                if raw_lines:
                    for l in raw_lines:
                        pts = l[0] if isinstance(l, (list, tuple)) and len(l) >= 1 and isinstance(l[0], list) else l
                        if len(pts) >= 2:
                            xs, ys = zip(*pts[:2])
                            ax.plot(xs, ys, color="#94a3b8", linewidth=0.5, alpha=0.7)

                if raw_polys:
                    for p in raw_polys:
                        pts = p[0] if isinstance(p, (list, tuple)) and len(p) >= 1 and isinstance(p[0], list) else p
                        if len(pts) >= 3:
                            xs, ys = zip(*(list(pts) + [pts[0]]))
                            ax.plot(xs, ys, color="#38bdf8", linewidth=0.8, alpha=0.9)

                if labels:
                    for lbl in labels:
                        x, y, txt = lbl[0], lbl[1], lbl[2]
                        ax.scatter([x], [y], color="#f43f5e", s=6, zorder=5)

                ax.set_title("Normalized PDF Drawing Geometry", color="#f8fafc", fontsize=12)
                ax.axis("off")
                fig.tight_layout()
                fig.savefig(os.path.join(output_dir, "02_normalized_pdf_geometry.png"), dpi=150)
                plt.close(fig)
            except Exception:
                pass

        # 03_detected_text_labels.geojson
        features_03 = []
        if texts:
            for t in texts:
                x, y, txt = t[0], t[1], str(t[2]).strip()
                features_03.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [x, y]},
                    "properties": {"text": txt},
                })
        _safe_dump_json({"type": "FeatureCollection", "features": features_03}, os.path.join(output_dir, "03_detected_text_labels.geojson"))

        # 04_label_clusters.geojson
        features_04 = []
        if label_clusters:
            for idx, cluster_geom in enumerate(label_clusters):
                features_04.append({
                    "type": "Feature",
                    "geometry": mapping(cluster_geom),
                    "properties": {"cluster_id": idx},
                })
        _safe_dump_json({"type": "FeatureCollection", "features": features_04}, os.path.join(output_dir, "04_label_clusters.geojson"))

        # 05_vector_components.geojson
        features_05 = []
        if components:
            for idx, comp in enumerate(components):
                geom = comp.get("geometry")
                if geom:
                    features_05.append({
                        "type": "Feature",
                        "geometry": mapping(geom),
                        "properties": {
                            "component_id": idx,
                            "line_count": comp.get("line_count", 0),
                            "area": comp.get("area", 0.0),
                        },
                    })
        _safe_dump_json({"type": "FeatureCollection", "features": features_05}, os.path.join(output_dir, "05_vector_components.geojson"))

        # 06_component_classification.geojson
        features_06 = []
        if components:
            for idx, comp in enumerate(components):
                geom = comp.get("geometry")
                if geom:
                    features_06.append({
                        "type": "Feature",
                        "geometry": mapping(geom),
                        "properties": {
                            "component_id": idx,
                            "classification": comp.get("classification", "UNKNOWN"),
                            "confidence": comp.get("confidence", 0.8),
                        },
                    })
        _safe_dump_json({"type": "FeatureCollection", "features": features_06}, os.path.join(output_dir, "06_component_classification.geojson"))

        # 07_candidate_pdf_boundaries.geojson
        features_07 = []
        if candidate_boundaries:
            for idx, cand in enumerate(candidate_boundaries):
                geom = cand.get("geometry")
                if geom:
                    features_07.append({
                        "type": "Feature",
                        "geometry": mapping(geom),
                        "properties": {
                            "candidate_name": cand.get("name", f"Candidate {idx}"),
                            "score": cand.get("score", 0.0),
                            "area": cand.get("area", 0.0),
                            "label_coverage": cand.get("label_coverage", 0.0),
                        },
                    })
        _safe_dump_json({"type": "FeatureCollection", "features": features_07}, os.path.join(output_dir, "07_candidate_pdf_boundaries.geojson"))

        # 08_selected_pdf_boundary.geojson
        feat_08 = {}
        if selected_boundary:
            feat_08 = {
                "type": "Feature",
                "geometry": mapping(selected_boundary) if hasattr(selected_boundary, "exterior") else selected_boundary,
                "properties": {"name": "G_pdf", "role": "inferred_colony_boundary"},
            }
        _safe_dump_json(feat_08, os.path.join(output_dir, "08_selected_pdf_boundary.geojson"))

        # 09_kml_boundary.geojson
        feat_09 = {}
        if kml_boundary:
            feat_09 = {
                "type": "Feature",
                "geometry": mapping(kml_boundary) if hasattr(kml_boundary, "exterior") else kml_boundary,
                "properties": {"name": "G_kml", "role": "authoritative_land_boundary"},
            }
        _safe_dump_json(feat_09, os.path.join(output_dir, "09_kml_boundary.geojson"))

        # 10_pre_registration_plots.geojson
        features_10 = []
        if pre_reg_plots:
            for no, poly in pre_reg_plots.items():
                features_10.append({
                    "type": "Feature",
                    "geometry": mapping(poly) if hasattr(poly, "exterior") else poly,
                    "properties": {"plot_number": no, "space": "pdf_cartesian"},
                })
        _safe_dump_json({"type": "FeatureCollection", "features": features_10}, os.path.join(output_dir, "10_pre_registration_plots.geojson"))

        # 11_registration_overlay.geojson
        features_11 = []
        if reg_overlay:
            for name, geom in reg_overlay.items():
                if geom:
                    features_11.append({
                        "type": "Feature",
                        "geometry": mapping(geom) if hasattr(geom, "exterior") else geom,
                        "properties": {"layer": name, "space": "metric_meters"},
                    })
        _safe_dump_json({"type": "FeatureCollection", "features": features_11}, os.path.join(output_dir, "11_registration_overlay.geojson"))

        # 12_final_plots.geojson
        features_12 = []
        if final_plots:
            for p in final_plots:
                geo = p.get("geometry")
                features_12.append({
                    "type": "Feature",
                    "geometry": geo,
                    "properties": {
                        "number": p.get("number"),
                        "area_sqm": p.get("area_sqm"),
                        "source": p.get("source", "vector"),
                        "confidence": p.get("confidence", 0.95),
                    },
                })
        _safe_dump_json({"type": "FeatureCollection", "features": features_12}, os.path.join(output_dir, "12_final_plots.geojson"))

        # 13_registration_metrics.json
        _safe_dump_json(registration_metrics or {}, os.path.join(output_dir, "13_registration_metrics.json"))

        # 14_plot_validation.json
        _safe_dump_json(plot_validation or {}, os.path.join(output_dir, "14_plot_validation.json"))

    except Exception:
        logger.exception("GIS debug artifact generation failed")
        return False
    return True
