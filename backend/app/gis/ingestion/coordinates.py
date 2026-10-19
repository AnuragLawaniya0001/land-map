"""Coordinate Spaces and Spatial Transformations for Multi-Page PDF-to-GIS.

Defines strict coordinate spaces and bidirectional affine transformations:
- PDF_POINTS: PyMuPDF 72-dpi user space points (origin: top-left or media box)
- RENDERED_PIXELS: Raster image pixel grid at render DPI
- LOCAL_METERS: Scaled local layout metric coordinates (meters)
- GEOGRAPHIC_WGS84: EPSG:4326 (longitude, latitude in degrees)
- PROJECTED_WEB_MERCATOR: EPSG:3857 (easting, northing in meters)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from pyproj import Transformer
from shapely.affinity import affine_transform
from shapely.geometry import Point, Polygon, LineString, mapping, shape


class CoordinateSpace(str, Enum):
    PDF_POINTS = "pdf_points"
    RENDERED_PIXELS = "rendered_pixels"
    LOCAL_METERS = "local_meters"
    GEOGRAPHIC_WGS84 = "geographic_wgs84"
    PROJECTED_WEB_MERCATOR = "projected_web_mercator"


_TO_MERCATOR = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
_FROM_MERCATOR = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)


@dataclass
class PageCoordinateTransform:
    """Rigorous coordinate transform definition for a specific page."""
    page_number: int
    width_points: float
    height_points: float
    rotation_deg: int = 0
    render_dpi: int = 150
    render_scale_factor: float = 1.0  # px per point
    meters_per_point: Optional[float] = None  # Scale ratio if calibrated
    affine_to_geo_matrix: Optional[List[float]] = None  # [a, b, d, e, xoff, yoff]

    @property
    def render_width_px(self) -> int:
        return int(round(self.width_points * self.render_scale_factor))

    @property
    def render_height_px(self) -> int:
        return int(round(self.height_points * self.render_scale_factor))

    # -------------------------------------------------------------------------
    # PDF Points <-> Rendered Pixels
    # -------------------------------------------------------------------------
    def point_to_pixel(self, x_pt: float, y_pt: float) -> Tuple[float, float]:
        """Converts PDF point coordinates to rendered pixel coordinates."""
        return (x_pt * self.render_scale_factor, y_pt * self.render_scale_factor)

    def pixel_to_point(self, x_px: float, y_px: float) -> Tuple[float, float]:
        """Converts rendered pixel coordinates back to PDF point coordinates."""
        scale = max(self.render_scale_factor, 1e-6)
        return (x_px / scale, y_px / scale)

    def bbox_pixel_to_point(self, bbox_px: List[float]) -> List[float]:
        """Converts [x1, y1, x2, y2] from pixels to PDF points."""
        scale = max(self.render_scale_factor, 1e-6)
        return [
            round(bbox_px[0] / scale, 3),
            round(bbox_px[1] / scale, 3),
            round(bbox_px[2] / scale, 3),
            round(bbox_px[3] / scale, 3),
        ]

    def bbox_point_to_pixel(self, bbox_pt: List[float]) -> List[int]:
        """Converts [x1, y1, x2, y2] from PDF points to integer pixels."""
        return [
            int(round(bbox_pt[0] * self.render_scale_factor)),
            int(round(bbox_pt[1] * self.render_scale_factor)),
            int(round(bbox_pt[2] * self.render_scale_factor)),
            int(round(bbox_pt[3] * self.render_scale_factor)),
        ]

    # -------------------------------------------------------------------------
    # PDF Points <-> Local Meters
    # -------------------------------------------------------------------------
    def point_to_local_meters(self, x_pt: float, y_pt: float) -> Tuple[float, float]:
        scale = self.meters_per_point or (0.3048 / 10.0)  # default estimate
        # Flip Y so meters coordinate is Y-up standard Cartesian
        return (x_pt * scale, (self.height_points - y_pt) * scale)

    def local_meters_to_point(self, x_m: float, y_m: float) -> Tuple[float, float]:
        scale = max(self.meters_per_point or (0.3048 / 10.0), 1e-6)
        return (x_m / scale, self.height_points - (y_m / scale))

    # -------------------------------------------------------------------------
    # Geometry Transformations
    # -------------------------------------------------------------------------
    def transform_geometry(
        self,
        geom: Any,
        from_space: CoordinateSpace,
        to_space: CoordinateSpace,
    ) -> Any:
        """Transforms a Shapely geometry across coordinate spaces."""
        if from_space == to_space or geom is None:
            return geom

        sh_geom = shape(geom) if isinstance(geom, dict) else geom

        if from_space == CoordinateSpace.RENDERED_PIXELS and to_space == CoordinateSpace.PDF_POINTS:
            s = 1.0 / max(self.render_scale_factor, 1e-6)
            # Affine: x' = s*x, y' = s*y
            return affine_transform(sh_geom, [s, 0, 0, s, 0, 0])

        if from_space == CoordinateSpace.PDF_POINTS and to_space == CoordinateSpace.RENDERED_PIXELS:
            s = self.render_scale_factor
            return affine_transform(sh_geom, [s, 0, 0, s, 0, 0])

        if from_space == CoordinateSpace.PDF_POINTS and to_space == CoordinateSpace.LOCAL_METERS:
            s = self.meters_per_point or 0.05
            # Flip Y: y' = -s*y + s*H
            return affine_transform(sh_geom, [s, 0, 0, -s, 0, s * self.height_points])

        if from_space == CoordinateSpace.LOCAL_METERS and to_space == CoordinateSpace.PDF_POINTS:
            s = 1.0 / max(self.meters_per_point or 0.05, 1e-6)
            return affine_transform(sh_geom, [s, 0, 0, -s, 0, self.height_points])

        return sh_geom

    def to_dict(self) -> Dict[str, Any]:
        return {
            "page_number": self.page_number,
            "width_points": self.width_points,
            "height_points": self.height_points,
            "rotation_deg": self.rotation_deg,
            "render_dpi": self.render_dpi,
            "render_scale_factor": self.render_scale_factor,
            "render_size_px": [self.render_width_px, self.render_height_px],
            "meters_per_point": self.meters_per_point,
            "has_geo_alignment": self.affine_to_geo_matrix is not None,
        }
