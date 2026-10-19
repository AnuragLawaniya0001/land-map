"""KML Extraction and Ground Control Georeferencing.

Calculates affine/similarity transformation parameters between local drawing
coordinates and geographic coordinates using ground control points or KML boundary references.
Reports residual RMS error truthfully.
"""

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, Tuple
import xml.etree.ElementTree as ET

import numpy as np
from pyproj import Transformer
from shapely.geometry import Polygon, mapping

logger = logging.getLogger("livemap.geometry.georeferencing")

_TO_MERCATOR = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
_FROM_MERCATOR = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)


class GeoreferenceAlignmentEngine:
    """Computes similarity/affine transforms between layout drawings and geographic coordinates."""

    def extract_kml_boundary(self, kml_bytes: bytes) -> Optional[Dict[str, Any]]:
        """Extracts the first valid polygon from KML data."""
        try:
            root = ET.fromstring(kml_bytes)
            for elem in root.iter():
                if elem.tag.endswith("Polygon"):
                    coord_elem = next((e for e in elem.iter() if e.tag.endswith("coordinates")), None)
                    if coord_elem is not None and coord_elem.text:
                        coords = []
                        for item in coord_elem.text.strip().split():
                            parts = item.split(",")
                            if len(parts) >= 2:
                                coords.append([float(parts[0]), float(parts[1])])
                        if len(coords) >= 4:
                            return {"type": "Polygon", "coordinates": [coords]}
        except Exception as exc:
            logger.warning("Failed to parse KML: %s", exc)
        return None

    def fit_control_points(
        self,
        src_points_xy: List[Tuple[float, float]],
        dst_points_lnglat: List[Tuple[float, float]],
    ) -> Dict[str, Any]:
        """Calculates least-squares similarity transformation and residual RMS error in meters."""
        if len(src_points_xy) < 3 or len(dst_points_lnglat) < 3:
            return {
                "success": False,
                "error": "At least 3 distinct control point pairs are required for georeferencing.",
            }

        # Project destination geographic points to metric Web Mercator (EPSG:3857)
        dst_metric = [_TO_MERCATOR.transform(lng, lat) for lng, lat in dst_points_lnglat]

        src_arr = np.array(src_points_xy)
        dst_arr = np.array(dst_metric)

        n = len(src_points_xy)
        src_mean = np.mean(src_arr, axis=0)
        dst_mean = np.mean(dst_arr, axis=0)

        src_centered = src_arr - src_mean
        dst_centered = dst_arr - dst_mean

        # Solve for scale and rotation: [x', y'] = s * R * [x, y]
        # H = src_centered^T * dst_centered
        H = np.dot(src_centered.T, dst_centered)
        U, S, Vt = np.linalg.svd(H)
        R = np.dot(Vt.T, U.T)

        # Handle reflection
        if np.linalg.det(R) < 0:
            Vt[1, :] *= -1
            R = np.dot(Vt.T, U.T)

        scale = float(np.sum(S) / np.sum(src_centered**2))
        trans_metric = dst_mean - scale * np.dot(src_mean, R)

        # Calculate residual RMS error on fitted control points
        fitted_dst = scale * np.dot(src_arr, R) + trans_metric
        residuals = np.linalg.norm(fitted_dst - dst_arr, axis=1)
        rms_error_meters = float(np.sqrt(np.mean(residuals**2)))

        angle_deg = float(math.degrees(math.atan2(R[1, 0], R[0, 0])))

        return {
            "success": True,
            "control_points_count": n,
            "rms_error_meters": round(rms_error_meters, 3),
            "estimated_scale_m_per_unit": round(scale, 5),
            "rotation_deg": round(angle_deg, 2),
            "transform_matrix": {
                "scale": scale,
                "rotation": R.tolist(),
                "translation_epsg3857": trans_metric.tolist(),
            },
        }
