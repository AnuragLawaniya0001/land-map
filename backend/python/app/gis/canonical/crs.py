"""Coordinate Reference System (CRS) and Geometry Standards.

Ensures strict separation between local drawing coordinates, projected metric
coordinates, and geographic coordinates (WGS84). Preserves transformation
provenance, original geometry, coordinate precision, and topological validity.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import math
from typing import Any, Dict, List, Optional, Tuple, Union

from shapely.geometry import shape, mapping, Polygon, MultiPolygon, LineString, Point
from shapely.validation import make_valid


class CRSType(str, Enum):
    LOCAL_DRAWING = "local_drawing"
    PROJECTED_METRIC = "projected_metric"
    GEOGRAPHIC_WGS84 = "geographic_wgs84"


@dataclass
class CoordinateSystemMetadata:
    crs_type: CRSType = CRSType.LOCAL_DRAWING
    units: str = "px"  # "px", "points", "m", "deg"
    scale_ratio: Optional[float] = None  # meters per drawing unit
    origin: Optional[Tuple[float, float]] = None
    rotation_deg: Optional[float] = None
    affine_matrix: Optional[List[float]] = None  # [a, b, c, d, xoff, yoff]
    is_georeferenced: bool = False
    scale_uncertain: bool = True
    precision_digits: int = 4
    notes: Optional[str] = None
    # Georeferencing provenance & verification fields
    epsg: Optional[int] = None  # EPSG code (4326 for WGS84)
    geographic_verified: Optional[bool] = None  # True only when surveyed GCPs confirm placement
    georeferencing_status: str = "unregistered"  # unregistered | provisional_shape_fit | verified

    def to_dict(self) -> Dict[str, Any]:
        # Derive EPSG from CRS type when not explicitly set
        epsg = self.epsg
        if epsg is None and self.crs_type == CRSType.GEOGRAPHIC_WGS84:
            epsg = 4326
        # Derive georeferencing_status from is_georeferenced when not explicitly set
        geo_status = self.georeferencing_status
        if geo_status == "unregistered" and self.is_georeferenced:
            geo_status = "provisional_shape_fit"
        return {
            "crs_type": self.crs_type.value if isinstance(self.crs_type, CRSType) else str(self.crs_type),
            "units": self.units,
            "scale_ratio": self.scale_ratio,
            "origin": list(self.origin) if self.origin else None,
            "rotation_deg": self.rotation_deg,
            "affine_matrix": list(self.affine_matrix) if self.affine_matrix else None,
            "is_georeferenced": self.is_georeferenced,
            "scale_uncertain": self.scale_uncertain,
            "precision_digits": self.precision_digits,
            "notes": self.notes,
            "epsg": epsg,
            "geographic_verified": self.geographic_verified if self.geographic_verified is not None else False,
            "georeferencing_status": geo_status,
        }

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> CoordinateSystemMetadata:
        if not data:
            return cls()
        crs_val = data.get("crs_type", CRSType.LOCAL_DRAWING.value)
        try:
            crs_type = CRSType(crs_val)
        except ValueError:
            crs_type = CRSType.LOCAL_DRAWING
        return cls(
            crs_type=crs_type,
            units=data.get("units", "px"),
            scale_ratio=data.get("scale_ratio"),
            origin=tuple(data["origin"]) if data.get("origin") else None,
            rotation_deg=data.get("rotation_deg"),
            affine_matrix=list(data["affine_matrix"]) if data.get("affine_matrix") else None,
            is_georeferenced=bool(data.get("is_georeferenced", False)),
            scale_uncertain=bool(data.get("scale_uncertain", True)),
            precision_digits=int(data.get("precision_digits", 4)),
            notes=data.get("notes"),
            epsg=data.get("epsg"),
            geographic_verified=data.get("geographic_verified"),
            georeferencing_status=data.get("georeferencing_status", "unregistered"),
        )


def validate_and_normalize_geometry(
    geom_input: Any,
    precision: int = 4,
    ensure_polygon: bool = False,
) -> Tuple[Optional[Dict[str, Any]], bool, Optional[str]]:
    """Validates geometry, repairs non-simple polygons, and normalizes GeoJSON.
    
    Returns:
        (geojson_dict, is_valid, repair_note)
    """
    if geom_input is None:
        return None, False, "Geometry is null"

    try:
        if hasattr(geom_input, "__geo_interface__"):
            sh_geom = shape(geom_input.__geo_interface__)
        elif isinstance(geom_input, dict):
            sh_geom = shape(geom_input)
        else:
            sh_geom = geom_input
    except Exception as exc:
        return None, False, f"Failed to parse geometry: {exc}"

    if sh_geom.is_empty:
        return None, False, "Geometry is empty"

    is_valid = sh_geom.is_valid
    repair_note = None

    if not is_valid:
        try:
            repaired = make_valid(sh_geom)
            if not repaired.is_empty:
                sh_geom = repaired
                is_valid = True
                repair_note = "Geometry repaired via make_valid"
            else:
                return None, False, "Geometry became empty upon make_valid repair"
        except Exception as exc:
            return None, False, f"Geometry validation repair failed: {exc}"

    if ensure_polygon and not isinstance(sh_geom, (Polygon, MultiPolygon)):
        return None, False, f"Expected Polygon or MultiPolygon, got {sh_geom.geom_type}"

    # Verify polygon closure
    if isinstance(sh_geom, Polygon):
        exterior = sh_geom.exterior.coords
        if len(exterior) < 4:
            return None, False, "Polygon exterior has fewer than 4 coordinates"
    elif isinstance(sh_geom, MultiPolygon):
        for poly in sh_geom.geoms:
            if len(poly.exterior.coords) < 4:
                return None, False, "MultiPolygon sub-polygon has fewer than 4 coordinates"

    geojson = mapping(sh_geom)
    effective_precision = precision
    if effective_precision == 4:
        # Check if geometry coordinates are in geographic WGS84 degree range (|c| <= 180 and > 0.1)
        bounds = sh_geom.bounds
        if abs(bounds[0]) <= 180 and abs(bounds[1]) <= 90 and (abs(bounds[0]) > 0.1 or abs(bounds[1]) > 0.1):
            effective_precision = 8
    rounded_geojson = round_coordinates(geojson, effective_precision)
    return rounded_geojson, is_valid, repair_note


def round_coordinates(geom_dict: Dict[str, Any], precision: int) -> Dict[str, Any]:
    """Rounds coordinates in GeoJSON dictionary recursively according to precision policy."""
    if not isinstance(geom_dict, dict) or "coordinates" not in geom_dict:
        return geom_dict

    def _round_seq(coords: Any) -> Any:
        if isinstance(coords, (list, tuple)):
            if len(coords) > 0 and isinstance(coords[0], (int, float)):
                return [round(float(c), precision) for c in coords]
            return [_round_seq(c) for c in coords]
        if isinstance(coords, (int, float)):
            return round(float(coords), precision)
        return coords

    result = dict(geom_dict)
    result["coordinates"] = _round_seq(geom_dict["coordinates"])
    return result
