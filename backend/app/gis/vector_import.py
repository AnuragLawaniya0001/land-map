"""Convert polygon GIS vectors (GeoJSON, GeoPackage, and KML) to import previews."""

import json
import math
import re
import sqlite3
import struct
import xml.etree.ElementTree as ET

from pyproj import CRS, Geod, Transformer
from shapely import from_wkb
from shapely.geometry import MultiPolygon, Point, mapping, shape
from shapely.ops import transform, unary_union


class VectorImportError(ValueError):
    """Raised when an input vector cannot be converted into a GIS preview."""


_BOUNDARY = re.compile(r"\b(boundary|site|compound|extent|layout)\b", re.I)
_PLOT = re.compile(r"\b(plot|parcel|lot)\b", re.I)
_ZONE = re.compile(r"\b(zone|sector|block)\b", re.I)
_GREEN = re.compile(r"\b(green|park|garden|landscape|open.space|amenity)\b", re.I)
_ROAD = re.compile(r"\b(road|street|lane|path|access)\b", re.I)
_ZONE_COLORS = ["#35c7b4", "#f06b5f", "#f2b84b", "#55a8ff", "#b787f5", "#7bd389", "#ff9f68", "#6fd3e9"]
_GEOD = Geod(ellps="WGS84")


def _polygonal(geometry):
    if geometry is None or geometry.is_empty:
        return None
    if geometry.geom_type not in ("Polygon", "MultiPolygon"):
        return None
    if not geometry.is_valid:
        geometry = geometry.buffer(0)
    if geometry.is_empty or geometry.geom_type not in ("Polygon", "MultiPolygon"):
        return None
    return geometry


def _inside_anchor(geometry):
    """Return a point guaranteed to lie inside the polygon when possible.

    Shapely centroid can fall outside concave or irregular polygons. For map
    placement and fit anchors, use a representative point that lies inside the
    actual boundary whenever the geometry allows it.
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


def _properties(feature):
    return dict(feature.get("properties") or {})


def _marker(properties):
    return " ".join(
        str(properties.get(key) or "")
        for key in ("feature_type", "boundary_type", "role", "kind", "type", "class", "layer", "name")
    )


def _first(properties, keys, default=None):
    for key in keys:
        value = properties.get(key)
        if value is not None and str(value).strip():
            return value
    return default


def _geojson_features(data):
    try:
        value = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VectorImportError(f"Invalid GeoJSON: {exc}") from exc
    if value.get("type") == "FeatureCollection":
        features = value.get("features") or []
    elif value.get("type") == "Feature":
        features = [value]
    elif value.get("type") in ("Polygon", "MultiPolygon"):
        features = [{"type": "Feature", "properties": {}, "geometry": value}]
    else:
        raise VectorImportError("GeoJSON must be a Feature, FeatureCollection, Polygon, or MultiPolygon")
    crs = value.get("crs")
    crs_name = None
    if isinstance(crs, dict):
        props = crs.get("properties") or {}
        crs_name = props.get("name") or props.get("href")
    return features, _source_crs(crs_name)


def _source_crs(value):
    if not value:
        return CRS.from_epsg(4326)
    text = str(value)
    match = re.search(r"EPSG(?::|::|/)(\d+)$", text, re.I)
    if match:
        return CRS.from_epsg(int(match.group(1)))
    try:
        return CRS.from_user_input(text)
    except Exception as exc:
        raise VectorImportError(f"Unsupported source coordinate reference system: {text}") from exc


def _gpkg_features(data):
    """Read GeoPackage vector tables and standard GeoPackage WKB blobs."""
    try:
        connection = sqlite3.connect(":memory:")
        connection.deserialize(data)
    except (sqlite3.Error, AttributeError) as exc:
        raise VectorImportError(f"Invalid or unsupported GeoPackage: {exc}") from exc
    try:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        if "gpkg_geometry_columns" not in tables or "gpkg_contents" not in tables:
            raise VectorImportError("GeoPackage is missing required geometry metadata tables")
        rows = connection.execute(
            "SELECT table_name, column_name, srs_id FROM gpkg_geometry_columns"
        ).fetchall()
        if not rows:
            raise VectorImportError("GeoPackage contains no geometry layers")
        features = []
        source_crs = None
        for table_name, geometry_column, srs_id in rows:
            if table_name not in tables:
                continue
            table = '"' + table_name.replace('"', '""') + '"'
            columns = [row[1] for row in connection.execute(f"PRAGMA table_info({table})")]
            for row in connection.execute(f"SELECT * FROM {table}"):
                record = dict(zip(columns, row))
                blob = record.pop(geometry_column, None)
                geometry = _gpkg_geometry(blob) if blob else None
                if geometry is None:
                    continue
                props = {key: value for key, value in record.items() if key != "fid"}
                features.append({"type": "Feature", "properties": props, "geometry": mapping(geometry)})
            if source_crs is None:
                source_crs = CRS.from_epsg(int(srs_id))
        return features, source_crs or CRS.from_epsg(4326)
    except sqlite3.Error as exc:
        raise VectorImportError(f"Could not read GeoPackage layer: {exc}") from exc
    finally:
        connection.close()


def _gpkg_geometry(blob):
    if len(blob) < 8 or blob[:2] != b"GP":
        raise VectorImportError("GeoPackage geometry has an invalid binary header")
    flags = blob[3]
    byte_order = "<" if flags & 1 else ">"
    envelope_indicator = (flags >> 1) & 7
    envelope_sizes = {0: 0, 1: 4, 2: 6, 3: 6, 4: 8}
    if envelope_indicator not in envelope_sizes:
        raise VectorImportError("GeoPackage geometry uses an unsupported envelope")
    wkb_offset = 8 + envelope_sizes[envelope_indicator] * 8
    if len(blob) <= wkb_offset:
        raise VectorImportError("GeoPackage geometry contains no WKB payload")
    srs_id = struct.unpack(byte_order + "i", blob[4:8])[0]
    # Strip the GeoPackage header; Shapely handles standard and extended WKB.
    del srs_id
    try:
        return from_wkb(blob[wkb_offset:])
    except Exception as exc:
        raise VectorImportError(f"Could not decode GeoPackage geometry: {exc}") from exc


def _parse_kml_coordinates(text):
    raw_pairs = []
    if not text:
        return []
    for token in text.strip().split():
        parts = token.split(",")
        if len(parts) >= 2:
            try:
                val1, val2 = float(parts[0]), float(parts[1])
                raw_pairs.append((val1, val2))
            except ValueError:
                continue
    if not raw_pairs:
        return []

    # Detect if pairs are (lat, lng) or (lng, lat) for Indian / Asian geographic bounds
    first_v1, first_v2 = raw_pairs[0]
    is_swapped = False
    if (6.0 <= first_v1 <= 38.0) and (68.0 <= first_v2 <= 98.0):
        # v1 is Latitude, v2 is Longitude; swap so output is [lng, lat]
        is_swapped = True
    elif (6.0 <= first_v2 <= 38.0) and (68.0 <= first_v1 <= 98.0):
        # v1 is Longitude, v2 is Latitude; already [lng, lat]
        is_swapped = False

    coords = []
    for v1, v2 in raw_pairs:
        lng, lat = (v2, v1) if is_swapped else (v1, v2)
        if -180.0 <= lng <= 180.0 and -90.0 <= lat <= 90.0:
            coords.append([lng, lat])

    if len(coords) >= 3 and coords[0] != coords[-1]:
        coords.append(coords[0])
    return coords


def _kml_features(data):
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise VectorImportError(f"Invalid KML structure: {exc}") from exc
    features = []
    placemarks = [elem for elem in root.iter() if elem.tag.rsplit("}", 1)[-1] == "Placemark"]
    if not placemarks:
        placemarks = [root]

    for placemark in placemarks:
        properties = {}
        for child in placemark:
            tag = child.tag.rsplit("}", 1)[-1]
            if tag == "name" and child.text:
                properties["name"] = child.text.strip()
            elif tag == "description" and child.text:
                properties["description"] = child.text.strip()
            elif tag == "ExtendedData":
                for data_node in child.iter():
                    if data_node.tag.rsplit("}", 1)[-1] == "Data" and data_node.get("name"):
                        value = next(
                            (part.text for part in data_node if part.tag.rsplit("}", 1)[-1] == "value"),
                            None,
                        )
                        if value is not None:
                            properties[data_node.get("name")] = value.strip()
        polygons = [elem for elem in placemark.iter() if isinstance(elem.tag, str) and elem.tag.rsplit("}", 1)[-1] == "Polygon"]
        for polygon in polygons:
            outer_ring = None
            inner_rings = []
            for child in polygon.iter():
                tag = child.tag.rsplit("}", 1)[-1] if isinstance(child.tag, str) else ""
                if tag == "outerBoundaryIs":
                    coords_elem = next((e for e in child.iter() if isinstance(e.tag, str) and e.tag.rsplit("}", 1)[-1] == "coordinates"), None)
                    if coords_elem is not None:
                        txt = "".join(coords_elem.itertext())
                        if txt.strip():
                            outer_ring = _parse_kml_coordinates(txt)
                elif tag == "innerBoundaryIs":
                    coords_elem = next((e for e in child.iter() if isinstance(e.tag, str) and e.tag.rsplit("}", 1)[-1] == "coordinates"), None)
                    if coords_elem is not None:
                        txt = "".join(coords_elem.itertext())
                        if txt.strip():
                            iring = _parse_kml_coordinates(txt)
                            if len(iring) >= 4:
                                inner_rings.append(iring)

            if not outer_ring:
                coords_elem = next((e for e in polygon.iter() if isinstance(e.tag, str) and e.tag.rsplit("}", 1)[-1] == "coordinates"), None)
                if coords_elem is not None:
                    txt = "".join(coords_elem.itertext())
                    if txt.strip():
                        outer_ring = _parse_kml_coordinates(txt)

            if outer_ring and len(outer_ring) >= 4:
                rings = [outer_ring] + inner_rings
                features.append({
                    "type": "Feature",
                    "properties": dict(properties),
                    "geometry": {"type": "Polygon", "coordinates": rings},
                })
    if not features:
        raise VectorImportError("KML contains no valid polygon geometry")
    return features, CRS.from_epsg(4326)


def read_vector(data, filename):
    extension = str(filename).lower().rsplit(".", 1)[-1]
    if extension in ("geojson", "json"):
        return _geojson_features(data)
    if extension == "gpkg":
        return _gpkg_features(data)
    if extension == "kml":
        return _kml_features(data)
    raise VectorImportError(f"Unsupported vector format: .{extension}")


def _geo(geometry):
    value = mapping(geometry)
    return {
        "type": value["type"],
        "coordinates": _round_coords(value["coordinates"]),
    }


def _round_coords(value):
    if isinstance(value, (tuple, list)):
        if value and isinstance(value[0], (int, float)):
            return [round(float(coordinate), 7) for coordinate in value]
        return [_round_coords(item) for item in value]
    return value


def _metric_geometry(geometry):
    center = _inside_anchor(geometry)
    if center is None:
        center = geometry.centroid
    local_crs = CRS.from_proj4(
        f"+proj=aeqd +lat_0={center.y} +lon_0={center.x} +datum=WGS84 +units=m +no_defs"
    )
    project = Transformer.from_crs(CRS.from_epsg(4326), local_crs, always_xy=True).transform
    return transform(project, geometry)


def _plot_dimensions(geometry):
    metric = _metric_geometry(geometry)
    polygon = max(metric.geoms, key=lambda item: item.area) if isinstance(metric, MultiPolygon) else metric
    coords = list(polygon.exterior.coords)[:-1]
    sides = [math.dist(coords[index], coords[(index + 1) % len(coords)]) for index in range(len(coords))]
    count = len(coords)
    rectangular = count == 4 and abs(sides[0] - sides[2]) < 0.6 and abs(sides[1] - sides[3]) < 0.6
    shape_name = "triangular" if count == 3 else "rectangular" if rectangular else "diagonal" if count == 4 else "polygon"
    shown = sides[:2] if rectangular else sides
    return metric.area, shape_name, count, " × ".join(f"{side:.1f}m" for side in shown), sides


def _area_sqm(geometry):
    area, _ = _GEOD.geometry_area_perimeter(geometry)
    return abs(area)


def _zone_code(properties, number):
    code = _first(properties, ("zone_code", "zone", "sector", "block"))
    if code is not None:
        return str(code).strip().upper()
    match = re.match(r"^([A-Z]{1,2})[-/]?\d", str(number or ""), re.I)
    return match.group(1).upper() if match else "A"


_INTERNAL_WORDS = re.compile(r"\b(plot|p[-_]?\d+|lot|khasra|survey\s*no|internal|block|sector)\b", re.I)


def extract_boundary(data, filename):
    boundary_geo, _ = extract_boundary_diagnostics(data, filename)
    return boundary_geo


def extract_pdf_boundary(data, filename):
    """Select an unambiguous outer boundary for fitting a single PDF layout."""
    boundary_geo, diagnostics = extract_boundary_diagnostics(data, filename)
    if boundary_geo is None:
        raise VectorImportError("The KML contains no valid polygon boundary.")
    if diagnostics.get("selected_boundary_was_invalid"):
        raise VectorImportError(
            "The selected KML land boundary is topologically invalid. Repair its self-intersections or ring structure before fitting a PDF."
        )
    candidate_count = diagnostics.get("candidate_boundaries_count", 0)
    score_margin = diagnostics.get("score_margin")
    if candidate_count > 1 and score_margin is not None and score_margin < 5:
        raise VectorImportError(
            "The KML contains multiple plausible land boundaries. Mark the intended outer boundary with a clear boundary/site name, or remove unrelated polygons, then retry the PDF overlay import."
        )
    return boundary_geo, diagnostics


def extract_boundary_diagnostics(data, filename):
    features, source_crs = read_vector(data, filename)
    transform_to_wgs = Transformer.from_crs(source_crs, 4326, always_xy=True).transform
    candidates = []
    
    for idx, feature in enumerate(features):
        raw_geom = feature.get("geometry") or {}
        source_geometry = shape(raw_geom)
        source_was_invalid = not source_geometry.is_valid
        geom = _polygonal(source_geometry)
        if geom is None:
            continue
        props = _properties(feature)
        converted = _polygonal(transform(transform_to_wgs, geom))
        if converted is None or converted.area <= 0:
            continue
        candidates.append({
            "idx": idx,
            "feature": feature,
            "properties": props,
            "marker": _marker(props),
            "geom": converted,
            "area": converted.area,
            "was_invalid": source_was_invalid,
        })
        
    if not candidates:
        return None, {"error": "No valid polygon candidates found"}
        
    max_area = max(c["area"] for c in candidates)
    
    # 5-Tier dynamic scoring
    for c in candidates:
        geom = c["geom"]
        marker = c["marker"]
        
        # 1. Metadata Score
        meta_score = 0.0
        if _BOUNDARY.search(marker):
            meta_score += 120.0
        if _INTERNAL_WORDS.search(marker):
            meta_score -= 60.0
            
        # 2. Spatial Enclosure Score (counts other candidate polygons enclosed)
        enclosed_count = 0
        for other in candidates:
            if other["idx"] != c["idx"]:
                if geom.buffer(1e-7).contains(other["geom"].representative_point()):
                    enclosed_count += 1
        c["enclosed_count"] = enclosed_count
        enclosure_score = enclosed_count * 15.0
        
        # 3. Area Magnitude Score
        area_score = (c["area"] / max(max_area, 1e-12)) * 25.0
        
        # 4. Geometric Plausibility (aspect ratio penalty if excessively thin)
        bounds = geom.bounds
        span_x = max(bounds[2] - bounds[0], 1e-9)
        span_y = max(bounds[3] - bounds[1], 1e-9)
        aspect = max(span_x, span_y) / min(span_x, span_y)
        plausibility_penalty = -25.0 if aspect > 30.0 else 0.0
        
        total_score = meta_score + enclosure_score + area_score + plausibility_penalty
        c["score"] = total_score
        c["meta_score"] = meta_score
        c["enclosure_score"] = enclosure_score
        c["area_score"] = area_score

    candidates.sort(key=lambda c: c["score"], reverse=True)
    selected = candidates[0]
    
    # Compute confidence
    if len(candidates) == 1:
        confidence = 0.95
        score_margin = None
    else:
        diff = selected["score"] - candidates[1]["score"]
        score_margin = round(float(diff), 3)
        confidence = min(0.99, max(0.50, 0.50 + diff / 100.0))
        
    poly_geom = selected["geom"]
    vertex_count = len(poly_geom.exterior.coords) if hasattr(poly_geom, "exterior") else sum(len(p.exterior.coords) for p in poly_geom.geoms)
    area_sqm = _area_sqm(poly_geom)
    
    diagnostics = {
        "placemark_count": len(features),
        "polygon_count": len(candidates),
        "candidate_boundaries_count": len(candidates),
        "selected_boundary_idx": selected["idx"],
        "selected_marker": selected["marker"],
        "selected_boundary_was_invalid": bool(selected["was_invalid"]),
        "score_margin": score_margin,
        "confidence_score": round(confidence, 3),
        "enclosed_features_count": selected["enclosed_count"],
        "area_sqm": round(area_sqm, 2),
        "vertex_count": vertex_count,
        "bounds": [round(v, 7) for v in poly_geom.bounds],
    }
    
    return _geo(poly_geom), diagnostics


def import_vector(data, filename, colony_id, now, maps_link=None, existing_boundary=None):
    """Return (colony_fields, zone_docs, plot_docs, warnings) for polygon vectors."""
    features, source_crs = read_vector(data, filename)
    transformer = Transformer.from_crs(source_crs, 4326, always_xy=True).transform
    warnings = []
    converted = []
    for feature in features:
        if not isinstance(feature, dict) or not feature.get("geometry"):
            continue
        geometry = _polygonal(shape(feature["geometry"]))
        if geometry is None:
            continue
        geometry = _polygonal(transform(transformer, geometry))
        if geometry is None:
            continue
        converted.append((_properties(feature), geometry))
    if not converted:
        raise VectorImportError("No Polygon or MultiPolygon features were found in the vector file")

    boundary_marked = [
        geometry for properties, geometry in converted
        if _BOUNDARY.search(_marker(properties))
    ]
    if existing_boundary:
        boundary = _polygonal(shape(existing_boundary))
        if boundary is None:
            raise VectorImportError("The target colony boundary is not a valid Polygon or MultiPolygon")
    elif boundary_marked:
        boundary = max(boundary_marked, key=lambda geometry: geometry.area)
    else:
        boundary = max((geometry for _, geometry in converted), key=lambda geometry: geometry.area)
        warnings.append("No boundary feature was tagged; the largest polygon was used as the colony boundary.")
    if not boundary.is_valid or boundary.area <= 0:
        raise VectorImportError("The GIS boundary feature is empty or invalid")

    plots, greens, roads, explicit_zones = [], [], [], []
    is_kml_file = str(filename).lower().endswith(".kml")
    if not is_kml_file:
        for properties, geometry in converted:
            marker = _marker(properties)
            if geometry.equals(boundary):
                continue
            if _GREEN.search(marker):
                greens.append((properties, geometry))
            elif _ROAD.search(marker):
                roads.append((properties, geometry))
            elif _ZONE.search(marker):
                explicit_zones.append((properties, geometry))
            elif _PLOT.search(marker) or _first(properties, ("plot_number", "plot_no", "plot", "number")) is not None:
                plots.append((properties, geometry))
            elif geometry is not boundary and not _BOUNDARY.search(marker):
                plots.append((properties, geometry))
        if not boundary_marked and not existing_boundary and plots:
            plots = [(props, geom) for props, geom in plots if not geom.equals(boundary)]

    numbered = []
    used = set()
    for index, (properties, geometry) in enumerate(plots, 1):
        number = _first(properties, ("plot_number", "plot_no", "plot", "number", "name"), str(index))
        number = str(number).strip()
        if not number or number in used:
            warnings.append(f"Duplicate or empty plot number {number or '(empty)'} was renamed.")
            suffix = index
            number = number or str(index)
            while number in used:
                number = f"{number}-{suffix}"
        used.add(number)
        numbered.append((properties, geometry, number, _zone_code(properties, number)))

    zone_codes = sorted({item[3] for item in numbered})
    zone_docs = []
    zone_id_by_code = {}
    explicit_by_code = {}
    for properties, geometry in explicit_zones:
        code = str(_first(properties, ("zone_code", "code", "zone", "name"), f"Z{len(explicit_by_code) + 1}")).strip().upper()
        explicit_by_code.setdefault(code, []).append(geometry)
    for index, code in enumerate(sorted(set(zone_codes) | set(explicit_by_code))):
        zone_id = f"zone-{colony_id}-{re.sub(r'[^a-z0-9_-]+', '-', code.lower()).strip('-') or index}"
        zone_id_by_code[code] = zone_id
        grouped = explicit_by_code.get(code) or [geometry for _, geometry, _, zone in numbered if zone == code]
        zone_geometry = unary_union(grouped).convex_hull
        zone_props = next((props for props, _ in explicit_zones if str(_first(props, ("zone_code", "code", "zone", "name"), "")).strip().upper() == code), {})
        zone_docs.append({
            "id": zone_id,
            "colony_id": str(colony_id),
            "code": code,
            "name": str(_first(zone_props, ("name", "zone_name"), f"Zone {code}")),
            "color": _first(zone_props, ("color",), _ZONE_COLORS[index % len(_ZONE_COLORS)]),
            "geometry": _geo(zone_geometry),
            "sort_order": index,
            "created_at": now,
        })

    plot_docs = []
    for properties, geometry, number, code in numbered:
        area, shape_name, side_count, dimensions, side_lengths = _plot_dimensions(geometry)
        area = round(area, 1)
        plot_docs.append({
            "id": str(_first(properties, ("id", "plot_id"), f"plot-{colony_id}-{number.lower()}")),
            "colony_id": str(colony_id),
            "zone_id": str(_first(properties, ("zone_id",), zone_id_by_code.get(code, zone_id_by_code.get("A")))),
            "number": number,
            "area_sqm": area,
            "area_sqft": round(area * 10.7639, 1),
            "area_sqyd": round(area * 1.19599, 1),
            "width_m": round(min(side_lengths), 2) if side_lengths else 0,
            "depth_m": round(max(side_lengths), 2) if side_lengths else 0,
            "shape": shape_name,
            "sides": side_count,
            "dimensions": dimensions,
            "status_id": "available",
            "geometry": _geo(geometry),
            "notes": str(_first(properties, ("notes", "description"), "")),
            "created_at": now,
        })

    def named_features(items, fallback, road=False):
        result = []
        for properties, geometry in items:
            item = {"name": str(_first(properties, ("name", "label", "title"), fallback)), "geometry": _geo(geometry)}
            if road:
                metric = _metric_geometry(geometry)
                polygon = max(metric.geoms, key=lambda part: part.area) if isinstance(metric, MultiPolygon) else metric
                sides = [math.dist(a, b) for a, b in zip(list(polygon.exterior.coords), list(polygon.exterior.coords)[1:])]
                item["width_m"] = round(min(sides), 1) if sides and len(sides) <= 5 else None
            result.append(item)
        return result

    center = _inside_anchor(boundary) or boundary.centroid
    fields = {
        "layout_version": "imported",
        "import_source": {
            "filename": filename,
            "mode": "qgis",
            "warnings": warnings,
            "imported_at": now,
            "plots": len(plot_docs),
            "greens": len(greens),
            "roads": len(roads),
        },
        "maps_link": maps_link or None,
        "map_center": {"lat": round(center.y, 7), "lng": round(center.x, 7)},
        "boundary": _geo(boundary),
        "greens": named_features(greens, "Garden"),
        "roads": named_features(roads, "Road", road=True),
        "entry_road": None,
        "entrance": None,
        "entry_centerline": None,
        "total_area_sqm": round(
            sum(plot["area_sqm"] for plot in plot_docs)
            + sum(_area_sqm(geometry) for _, geometry in greens)
            + sum(_area_sqm(geometry) for _, geometry in roads),
            1,
        ),
    }
    return fields, zone_docs, plot_docs, warnings


def import_kml_boundary(data, filename, colony_id, now, existing_boundary=None, maps_link=None):
    """Build a boundary-only preview from KML polygons; plots remain empty."""
    _kml_features(data)
    boundary = existing_boundary or extract_boundary(data, filename)
    if not boundary:
        raise VectorImportError("KML contains no usable colony boundary polygon")
    geometry = _polygonal(shape(boundary))
    if geometry is None:
        raise VectorImportError("KML boundary is not a valid Polygon or MultiPolygon")
    centroid = geometry.centroid
    fields = {
        "layout_version": "imported",
        "import_source": {
            "filename": filename,
            "mode": "kml_boundary",
            "warnings": [],
            "imported_at": now,
            "plots": 0,
            "greens": 0,
            "roads": 0,
        },
        "maps_link": maps_link or None,
        "map_center": {"lat": round(centroid.y, 7), "lng": round(centroid.x, 7)},
        "boundary": _geo(geometry),
        "greens": [],
        "roads": [],
        "entry_road": None,
        "entrance": None,
        "entry_centerline": None,
        "total_area_sqm": round(_area_sqm(geometry), 1),
    }
    warnings = ["KML boundary imported without plot features; add plot polygons before validation and commit."]
    fields["import_source"]["warnings"] = warnings
    return fields, [], [], warnings
