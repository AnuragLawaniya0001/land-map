"""Geometry Reconstruction Engine for Layout Plans.

Performs robust vector linework polygonization, adaptive snapping,
and semantic entity reconstruction for:
- Individual parcel/plot polygons and irregular lots
- Road surfaces, centerlines, and junctions
- Parks, green open spaces, water bodies
- Community amenities, utility areas, and boundary envelopes
"""

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np
from shapely.geometry import (
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
    box,
    mapping,
    shape,
)
from shapely.ops import linemerge, polygonize, unary_union

from app.gis.ai_models.models import OCRTextDetection
from app.gis.ingestion.coordinates import PageCoordinateTransform

logger = logging.getLogger("livemap.geometry.reconstruction")


class GeometryReconstructionEngine:
    """Engine reconstructing canonical GIS entities from vector linework and evidence."""

    def __init__(
        self,
        base_snap_tolerance_pt: float = 1.5,
        min_plot_area_pt: float = 200.0,
        max_plot_area_pt: float = 200000.0,
    ):
        self.base_snap_tolerance_pt = base_snap_tolerance_pt
        self.min_plot_area_pt = min_plot_area_pt
        self.max_plot_area_pt = max_plot_area_pt

    def reconstruct_layout_entities(
        self,
        vector_segments: List[Tuple[Tuple[float, float], Tuple[float, float]]],
        labels: List[Dict[str, Any]],
        color_masks: Optional[Dict[str, Any]] = None,
        transform: Optional[PageCoordinateTransform] = None,
        site_boundary: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Reconstructs all colony features: plots, roads, centerlines, parks, amenities, and site boundary."""
        # 1. Normalize and snap vector linework
        snapped_lines = self._snap_endpoints(vector_segments, tolerance=self.base_snap_tolerance_pt)

        # 2. Polygonize linework into closed rings
        polygons = self._polygonize_lines(snapped_lines)

        # 3. Associate labels and classify entities
        plots: List[Dict[str, Any]] = []
        roads: List[Dict[str, Any]] = []
        parks: List[Dict[str, Any]] = []
        amenities: List[Dict[str, Any]] = []
        unassigned: List[Dict[str, Any]] = []

        # Track used labels
        used_labels: Set[str] = set()

        for poly_idx, poly in enumerate(polygons):
            area = poly.area
            if area < self.min_plot_area_pt:
                continue

            poly_geom = mapping(poly)
            # Find best matching label
            matched_label, label_score = self._find_best_label(poly, labels, used_labels)

            is_road = False
            is_park = False
            is_amenity = False

            if matched_label:
                lbl_text = matched_label["text"].upper()
                if any(w in lbl_text for w in ["ROAD", "STREET", "LANE", "WAY", "MARG", "AVENUE"]):
                    is_road = True
                elif any(w in lbl_text for w in ["PARK", "GARDEN", "GREEN", "COP", "OPEN"]):
                    is_park = True
                elif any(w in lbl_text for w in ["COMMUNITY", "SCHOOL", "CLUB", "TEMPLE", "UTILITY", "SUBSTATION"]):
                    is_amenity = True

            # Aspect ratio check for roads (very elongated polygons are typically road corridors)
            minx, miny, maxx, maxy = poly.bounds
            width = maxx - minx
            height = maxy - miny
            aspect = max(width, height) / max(min(width, height), 1e-3)
            if aspect > 7.0 and area > 1000.0:
                is_road = True

            feature_dict = {
                "id": f"rec_feat_{poly_idx + 1}",
                "geometry": poly_geom,
                "area_points": round(area, 2),
                "bounds": [round(b, 2) for b in poly.bounds],
            }

            if matched_label:
                feature_dict["number"] = matched_label["text"]
                feature_dict["label_confidence"] = matched_label.get("confidence", 0.9)
                feature_dict["label_center"] = matched_label["center_pt"]
                used_labels.add(matched_label["text"])

            if is_road:
                roads.append(feature_dict)
            elif is_park:
                parks.append(feature_dict)
            elif is_amenity:
                amenities.append(feature_dict)
            elif matched_label:
                # Plots have numbers
                plots.append(feature_dict)
            else:
                unassigned.append(feature_dict)

        # 4. Generate Road Centerlines
        road_centerlines = self._generate_road_centerlines(roads)

        # 5. Extract Outer Boundary if not provided
        boundary_geom = site_boundary
        if not boundary_geom and polygons:
            try:
                union_all = unary_union(polygons)
                if isinstance(union_all, MultiPolygon):
                    union_all = max(union_all.geoms, key=lambda p: p.area)
                boundary_geom = mapping(union_all.convex_hull)
            except Exception:
                pass

        return {
            "plots": plots,
            "roads": roads,
            "road_centerlines": road_centerlines,
            "parks": parks,
            "amenities": amenities,
            "unassigned_regions": unassigned,
            "site_boundary": boundary_geom,
            "linework_segment_count": len(vector_segments),
            "polygon_candidate_count": len(polygons),
        }

    def _snap_endpoints(
        self,
        segments: List[Tuple[Tuple[float, float], Tuple[float, float]]],
        tolerance: float = 1.5,
    ) -> List[LineString]:
        """Snaps line segment endpoints within tolerance to close micro-gaps."""
        lines = []
        endpoints: List[Tuple[float, float]] = []

        for p1, p2 in segments:
            lines.append(((p1[0], p1[1]), (p2[0], p2[1])))
            endpoints.append(p1)
            endpoints.append(p2)

        if not endpoints:
            return []

        # Snap endpoints that are within tolerance
        snapped_lines = []
        for (x1, y1), (x2, y2) in lines:
            # Check against other endpoints
            sp1 = self._snap_point((x1, y1), endpoints, tolerance)
            sp2 = self._snap_point((x2, y2), endpoints, tolerance)
            if sp1 != sp2:
                snapped_lines.append(LineString([sp1, sp2]))

        return snapped_lines

    def _snap_point(self, pt: Tuple[float, float], all_pts: List[Tuple[float, float]], tol: float) -> Tuple[float, float]:
        for candidate in all_pts:
            if candidate != pt:
                dist = math.hypot(pt[0] - candidate[0], pt[1] - candidate[1])
                if 0.0 < dist <= tol:
                    return candidate
        return pt

    def _polygonize_lines(self, lines: List[LineString]) -> List[Polygon]:
        """Runs Shapely polygonize over unified linework."""
        if not lines:
            return []
        try:
            merged = unary_union(lines)
            polys = list(polygonize(merged))
            # Filter valid polygons
            valid_polys = []
            for p in polys:
                if p.is_valid and not p.is_empty and p.area > 10.0:
                    valid_polys.append(p)
            return valid_polys
        except Exception as exc:
            logger.warning("Linework polygonization error: %s", exc)
            return []

    def _find_best_label(
        self,
        poly: Polygon,
        labels: List[Dict[str, Any]],
        used_labels: Set[str],
    ) -> Tuple[Optional[Dict[str, Any]], float]:
        """Finds the label located inside or closest to the interior of the polygon."""
        best_label = None
        best_score = -1.0

        for lbl in labels:
            text = lbl["text"]
            if text in used_labels:
                continue

            cx, cy = lbl["center_pt"]
            pt = Point(cx, cy)

            if poly.contains(pt):
                dist_to_center = pt.distance(poly.centroid)
                score = 1.0 / (1.0 + dist_to_center * 0.05)
                if score > best_score:
                    best_score = score
                    best_label = lbl
            elif poly.distance(pt) < 4.0:
                score = 0.5
                if score > best_score:
                    best_score = score
                    best_label = lbl

        return best_label, best_score

    def _generate_road_centerlines(self, roads: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Generates road centerlines by extracting medial axes of road polygons."""
        centerlines = []
        for idx, r in enumerate(roads):
            try:
                poly = shape(r["geometry"])
                # Approximate centerline from longest axis of minimum rotated rectangle
                mrr = poly.minimum_rotated_rectangle
                coords = list(mrr.exterior.coords)[:-1]
                if len(coords) == 4:
                    e1_len = math.hypot(coords[1][0] - coords[0][0], coords[1][1] - coords[0][1])
                    e2_len = math.hypot(coords[2][0] - coords[1][0], coords[2][1] - coords[1][1])
                    if e1_len >= e2_len:
                        p1 = ((coords[0][0] + coords[3][0]) / 2.0, (coords[0][1] + coords[3][1]) / 2.0)
                        p2 = ((coords[1][0] + coords[2][0]) / 2.0, (coords[1][1] + coords[2][1]) / 2.0)
                    else:
                        p1 = ((coords[0][0] + coords[1][0]) / 2.0, (coords[0][1] + coords[1][1]) / 2.0)
                        p2 = ((coords[3][0] + coords[2][0]) / 2.0, (coords[3][1] + coords[2][1]) / 2.0)
                    centerlines.append({
                        "id": f"road_cl_{idx + 1}",
                        "road_id": r["id"],
                        "geometry": mapping(LineString([p1, p2])),
                    })
            except Exception:
                pass
        return centerlines
