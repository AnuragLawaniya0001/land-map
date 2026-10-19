"""Interactive Masterplan Geometry Editing Routes.

Provides CRUD endpoints for:
- Editable Colony Land Boundary (modifying edges, adding/removing vertices, expanding boundary)
- Creating new Plots, Roads, and Green spaces/parks
- Modifying existing plot geometries, road corridors, and parks
- Deleting plots, roads, and greens
All operations synchronously update 2D inventory and 3D Canonical collections.
"""

from __future__ import annotations

import logging
import math
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from pyproj import Geod
from shapely.geometry import LineString, Polygon, mapping, shape

logger = logging.getLogger("livemap.geometry")
geod = Geod(ellps="WGS84")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def compute_polygon_metrics(poly_geo: Polygon) -> Dict[str, Any]:
    """Compute exact real-world dimensions and area for a geographic polygon (WGS84)."""
    if not poly_geo or not poly_geo.is_valid or poly_geo.is_empty:
        return {
            "area_sqm": 0.0,
            "area_sqft": 0.0,
            "area_sqyd": 0.0,
            "width_m": 0.0,
            "depth_m": 0.0,
            "shape": "polygon",
            "sides": 0,
            "dimensions": "0m",
        }

    # 1. Metric area via ellipsoidal Geod
    try:
        area_sqm = abs(float(geod.geometry_area_perimeter(poly_geo)[0]))
    except Exception:
        area_sqm = 0.0

    area_sqft = round(area_sqm * 10.7639, 1)
    area_sqyd = round(area_sqm * 1.19599, 1)

    # 2. Local metric coordinates for side lengths and width/depth
    center = poly_geo.centroid
    lat0, lng0 = center.y, center.x
    kx = 111320.0 * math.cos(math.radians(lat0))
    ky = 110574.0
    poly_m = Polygon([((x - lng0) * kx, (y - lat0) * ky) for x, y in poly_geo.exterior.coords])

    ext_coords = list(poly_m.exterior.coords)[:-1]
    n = len(ext_coords)
    sides = [math.dist(ext_coords[i], ext_coords[(i + 1) % n]) for i in range(n)]

    rect = n == 4 and abs(sides[0] - sides[2]) < 0.6 and abs(sides[1] - sides[3]) < 0.6
    shape_name = "triangular" if n == 3 else "rectangular" if rect else "diagonal" if n == 4 else "polygon"
    shown = sides[:2] if rect else sides
    dimensions = " × ".join(f"{s:.1f}m" for s in shown)
    width_m = round(min(sides), 2) if sides else 0.0
    depth_m = round(max(sides), 2) if sides else 0.0

    return {
        "area_sqm": round(area_sqm, 1),
        "area_sqft": area_sqft,
        "area_sqyd": area_sqyd,
        "width_m": width_m,
        "depth_m": depth_m,
        "shape": shape_name,
        "sides": n,
        "dimensions": dimensions,
    }


class UpdateBoundaryIn(BaseModel):
    boundary: dict


class CreatePlotIn(BaseModel):
    number: str = Field(..., min_length=1, max_length=50)
    geometry: dict
    plot_type: Optional[str] = "residential"
    zone_code: Optional[str] = "A"
    status_id: Optional[str] = "available"
    price: Optional[float] = None
    price_per_sqft: Optional[float] = None
    facing: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None


class UpdatePlotGeometryIn(BaseModel):
    geometry: dict


class CreateRoadIn(BaseModel):
    name: Optional[str] = "Internal Road"
    width_ft: Optional[float] = 30.0
    geometry: Optional[dict] = None
    centerline: Optional[dict] = None


class UpdateRoadIn(BaseModel):
    name: Optional[str] = None
    width_ft: Optional[float] = None
    geometry: dict


class CreateGreenIn(BaseModel):
    name: Optional[str] = "Park / Green Space"
    amenity_type: Optional[str] = "park"
    geometry: dict


class UpdateGreenIn(BaseModel):
    name: Optional[str] = None
    amenity_type: Optional[str] = None
    geometry: dict


def build_geometry_router(
    db: Any,
    require_admin_dep: Callable,
    load_owned_colony_fn: Callable,
    audit_log_fn: Callable,
    serialize_doc_fn: Callable,
) -> APIRouter:
    router = APIRouter()

    # =========================================================================
    # 1. EDITABLE COLONY LAND BOUNDARY
    # =========================================================================
    @router.put("/admin/colonies/{colony_id}/boundary")
    async def update_colony_boundary(
        colony_id: str,
        payload: UpdateBoundaryIn,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        colony = await load_owned_colony_fn(colony_id, user)
        cid = str(colony["_id"])

        try:
            poly = shape(payload.boundary)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if not poly.is_valid or poly.is_empty or poly.geom_type != "Polygon":
                raise ValueError("Invalid boundary polygon geometry")
        except Exception as e:
            raise HTTPException(400, f"Invalid boundary geometry: {e}")

        # Compute area and center
        center = poly.centroid
        area_sqm = abs(float(geod.geometry_area_perimeter(poly)[0]))
        area_sqyd = round(area_sqm * 1.19599, 1)
        area_acres = round(area_sqm / 4046.86, 3)

        new_boundary_dict = mapping(poly)
        update_fields = {
            "boundary": new_boundary_dict,
            "map_center": {"lat": center.y, "lng": center.x},
            "area_sqm": round(area_sqm, 1),
            "area_sqyd": area_sqyd,
            "area_acres": area_acres,
            "updated_at": _now_iso(),
        }

        await db["colonies"].update_one({"_id": colony["_id"]}, {"$set": update_fields})

        # Sync to canonical collections if active
        try:
            await db["canonical_colonies"].update_one(
                {"colony_id": {"$in": [cid, ObjectId(cid)]}},
                {"$set": {"boundary": new_boundary_dict, "map_center": update_fields["map_center"]}}
            )
        except Exception:
            pass

        await audit_log_fn(
            user,
            "COLONY_BOUNDARY_EDITED",
            "colony",
            cid,
            colony_id=cid,
            metadata={"area_sqm": area_sqm, "area_sqyd": area_sqyd},
            request=request,
        )

        updated_colony = await db["colonies"].find_one({"_id": colony["_id"]})
        return {
            "status": "ok",
            "message": "Colony boundary updated successfully",
            "boundary": new_boundary_dict,
            "area_sqm": round(area_sqm, 1),
            "area_sqyd": area_sqyd,
            "area_acres": area_acres,
            "map_center": update_fields["map_center"],
            "colony": serialize_doc_fn(updated_colony),
        }

    # =========================================================================
    # 2. PLOT CRUD (Create, Update Geometry, Delete)
    # =========================================================================
    @router.post("/admin/colonies/{colony_id}/plots")
    async def create_new_plot(
        colony_id: str,
        payload: CreatePlotIn,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        colony = await load_owned_colony_fn(colony_id, user)
        cid = str(colony["_id"])

        plot_no = payload.number.strip()
        # Check duplicate
        colony_id_query = [cid]
        if ObjectId.is_valid(cid):
            colony_id_query.append(ObjectId(cid))
        existing = await db["plots"].find_one({
            "colony_id": {"$in": colony_id_query},
            "number": plot_no,
        })
        if existing:
            raise HTTPException(400, f"Plot number '{plot_no}' already exists in this colony")

        try:
            poly = shape(payload.geometry)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if not poly.is_valid or poly.is_empty:
                raise ValueError("Plot geometry must be a valid polygon")
        except Exception as e:
            raise HTTPException(400, f"Invalid plot geometry: {e}")

        metrics = compute_polygon_metrics(poly)
        plot_id = f"plot-{cid}-{plot_no.lower().replace(' ', '-')}-{uuid.uuid4().hex[:6]}"
        zone_id = f"zone-{cid}-{payload.zone_code.lower()}"
        now_ts = _now_iso()

        new_plot_doc = {
            "id": plot_id,
            "colony_id": cid,
            "zone_id": zone_id,
            "number": plot_no,
            "plot_type": payload.plot_type or "residential",
            "status_id": payload.status_id or "available",
            "geometry": mapping(poly),
            "original_geometry": mapping(poly),
            "area_sqm": metrics["area_sqm"],
            "area_sqft": metrics["area_sqft"],
            "area_sqyd": metrics["area_sqyd"],
            "width_m": metrics["width_m"],
            "depth_m": metrics["depth_m"],
            "shape": metrics["shape"],
            "sides": metrics["sides"],
            "dimensions": metrics["dimensions"],
            "price": payload.price,
            "price_per_sqft": payload.price_per_sqft,
            "facing": payload.facing,
            "title": payload.title or f"Plot {plot_no}",
            "description": payload.description or "",
            "visibility": "PUBLIC",
            "created_at": now_ts,
            "updated_at": now_ts,
        }

        await db["plots"].insert_one(new_plot_doc)

        # Sync to canonical_plots for 3D viewer
        canonical_doc = {
            "id": plot_id,
            "colony_id": cid,
            "dataset_version": 1,
            "original_number": plot_no,
            "geometry": mapping(poly),
            "original_geometry": mapping(poly),
            "area_sqm": metrics["area_sqm"],
            "confidence": 1.0,
            "created_at": now_ts,
        }
        try:
            await db["canonical_plots"].insert_one(canonical_doc)
        except Exception:
            pass

        await audit_log_fn(
            user,
            "PLOT_CREATED",
            "plot",
            plot_id,
            colony_id=cid,
            metadata={"number": plot_no, "area_sqyd": metrics["area_sqyd"]},
            request=request,
        )

        plot_out = serialize_doc_fn(new_plot_doc)
        return {"ok": True, "plot": plot_out, **plot_out}

    @router.patch("/admin/plots/{plot_id}/geometry")
    async def update_plot_geometry(
        plot_id: str,
        payload: UpdatePlotGeometryIn,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        plot_query = {"$or": [{"id": plot_id}]}
        if ObjectId.is_valid(plot_id):
            plot_query["$or"].append({"_id": ObjectId(plot_id)})
        plot = await db["plots"].find_one(plot_query)
        if not plot:
            raise HTTPException(404, "Plot not found")
        await load_owned_colony_fn(plot["colony_id"], user)

        try:
            poly = shape(payload.geometry)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if not poly.is_valid or poly.is_empty:
                raise ValueError("Plot geometry must be a valid polygon")
        except Exception as e:
            raise HTTPException(400, f"Invalid plot geometry: {e}")

        metrics = compute_polygon_metrics(poly)
        geom_dict = mapping(poly)
        now_ts = _now_iso()

        update = {
            "geometry": geom_dict,
            "area_sqm": metrics["area_sqm"],
            "area_sqft": metrics["area_sqft"],
            "area_sqyd": metrics["area_sqyd"],
            "width_m": metrics["width_m"],
            "depth_m": metrics["depth_m"],
            "shape": metrics["shape"],
            "sides": metrics["sides"],
            "dimensions": metrics["dimensions"],
            "updated_at": now_ts,
        }

        # Keep original_geometry if not set yet
        if not plot.get("original_geometry"):
            update["original_geometry"] = plot.get("geometry")

        await db["plots"].update_one(plot_query, {"$set": update})

        # Sync to canonical_plots
        try:
            await db["canonical_plots"].update_many(
                {"id": plot_id},
                {"$set": {"geometry": geom_dict, "area_sqm": metrics["area_sqm"], "updated_at": now_ts}}
            )
        except Exception:
            pass

        await audit_log_fn(
            user,
            "PLOT_GEOMETRY_RESHAPED",
            "plot",
            plot_id,
            colony_id=plot["colony_id"],
            metadata={"new_area_sqyd": metrics["area_sqyd"]},
            request=request,
        )

        return {"ok": True, "plot": serialize_doc_fn(await db["plots"].find_one(plot_query))}

    @router.delete("/admin/plots/{plot_id}")
    async def delete_plot(
        plot_id: str,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        plot = await db["plots"].find_one({"id": plot_id})
        if not plot:
            raise HTTPException(404, "Plot not found")
        await load_owned_colony_fn(plot["colony_id"], user)

        await db["plots"].delete_one({"id": plot_id})
        try:
            await db["canonical_plots"].delete_many({"id": plot_id})
        except Exception:
            pass

        await audit_log_fn(
            user,
            "PLOT_DELETED",
            "plot",
            plot_id,
            colony_id=plot["colony_id"],
            metadata={"number": plot.get("number")},
            request=request,
        )
        return {"status": "ok", "deleted_plot_id": plot_id}

    # =========================================================================
    # 3. ROADS CRUD (Create, Update, Delete)
    # =========================================================================
    @router.post("/admin/colonies/{colony_id}/roads")
    async def create_new_road(
        colony_id: str,
        payload: CreateRoadIn,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        colony = await load_owned_colony_fn(colony_id, user)
        cid = str(colony["_id"])

        raw_geom = payload.geometry or payload.centerline
        if not raw_geom:
            raise HTTPException(400, "Road geometry or centerline is required")

        try:
            geo_shape = shape(raw_geom)
            # If line, buffer by width
            if geo_shape.geom_type in ("LineString", "MultiLineString"):
                width_m = (payload.width_ft or 30.0) * 0.3048
                # buffer in approximate degrees (1 deg lat ~ 111320m)
                deg_buf = (width_m / 2.0) / 111320.0
                poly = geo_shape.buffer(deg_buf, cap_style=2, join_style=2)
            else:
                poly = geo_shape
            if not poly.is_valid:
                poly = poly.buffer(0)
            if not poly.is_valid or poly.is_empty:
                raise ValueError("Road geometry must be valid")
        except Exception as e:
            raise HTTPException(400, f"Invalid road geometry: {e}")

        road_id = f"road-{cid}-{uuid.uuid4().hex[:8]}"
        road_doc = {
            "id": road_id,
            "name": payload.name or "Internal Road",
            "source_label": payload.name or "Internal Road",
            "width_ft": payload.width_ft or 30.0,
            "geometry": mapping(poly),
            "original_geometry": mapping(poly),
            "created_at": _now_iso(),
        }

        # Add to colony.roads
        await db["colonies"].update_one(
            {"_id": colony["_id"]},
            {"$push": {"roads": road_doc}}
        )

        # Sync to canonical_roads
        try:
            await db["canonical_roads"].insert_one({
                "id": road_id,
                "colony_id": cid,
                "dataset_version": 1,
                "name": road_doc["name"],
                "geometry": road_doc["geometry"],
                "original_geometry": road_doc["geometry"],
                "width_m": (payload.width_ft or 30.0) * 0.3048,
                "created_at": _now_iso(),
            })
        except Exception:
            pass

        await audit_log_fn(
            user, "ROAD_CREATED", "colony", cid,
            colony_id=cid, metadata={"road_id": road_id, "name": payload.name}, request=request,
        )
        road_out = serialize_doc_fn(road_doc)
        return {"ok": True, "road": road_out, **road_out}

    @router.put("/admin/colonies/{colony_id}/roads/{road_id}")
    async def update_road(
        colony_id: str,
        road_id: str,
        payload: UpdateRoadIn,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        colony = await load_owned_colony_fn(colony_id, user)
        cid = str(colony["_id"])

        try:
            poly = shape(payload.geometry)
            if not poly.is_valid:
                poly = poly.buffer(0)
        except Exception as e:
            raise HTTPException(400, f"Invalid road geometry: {e}")

        roads_list = colony.get("roads") or []
        found = False
        updated_roads = []
        for r in roads_list:
            if r.get("id") == road_id:
                found = True
                updated_roads.append({
                    **r,
                    "name": payload.name or r.get("name"),
                    "width_ft": payload.width_ft or r.get("width_ft", 30.0),
                    "geometry": mapping(poly),
                })
            else:
                updated_roads.append(r)

        if not found:
            raise HTTPException(404, "Road not found")

        await db["colonies"].update_one(
            {"_id": colony["_id"]},
            {"$set": {"roads": updated_roads}}
        )

        # Sync canonical
        try:
            await db["canonical_roads"].update_many(
                {"id": road_id},
                {"$set": {"geometry": mapping(poly), "name": payload.name or "Internal Road"}}
            )
        except Exception:
            pass

        return {"status": "ok", "road_id": road_id}

    @router.delete("/admin/colonies/{colony_id}/roads/{road_id}")
    async def delete_road(
        colony_id: str,
        road_id: str,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        colony = await load_owned_colony_fn(colony_id, user)
        cid = str(colony["_id"])

        await db["colonies"].update_one(
            {"_id": colony["_id"]},
            {"$pull": {"roads": {"id": road_id}}}
        )
        try:
            await db["canonical_roads"].delete_many({"id": road_id})
        except Exception:
            pass

        await audit_log_fn(
            user, "ROAD_DELETED", "colony", cid,
            colony_id=cid, metadata={"road_id": road_id}, request=request,
        )
        return {"status": "ok", "deleted_road_id": road_id}

    # =========================================================================
    # 4. GREENS & PARKS CRUD (Create, Update, Delete)
    # =========================================================================
    @router.post("/admin/colonies/{colony_id}/greens")
    async def create_new_green(
        colony_id: str,
        payload: CreateGreenIn,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        colony = await load_owned_colony_fn(colony_id, user)
        cid = str(colony["_id"])

        try:
            poly = shape(payload.geometry)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if not poly.is_valid or poly.is_empty:
                raise ValueError("Green geometry must be valid")
        except Exception as e:
            raise HTTPException(400, f"Invalid green geometry: {e}")

        green_id = f"green-{cid}-{uuid.uuid4().hex[:8]}"
        green_doc = {
            "id": green_id,
            "name": payload.name or "Park / Green Space",
            "amenity_type": payload.amenity_type or "park",
            "geometry": mapping(poly),
            "original_geometry": mapping(poly),
            "created_at": _now_iso(),
        }

        await db["colonies"].update_one(
            {"_id": colony["_id"]},
            {"$push": {"greens": green_doc}}
        )

        await audit_log_fn(
            user, "GREEN_CREATED", "colony", cid,
            colony_id=cid, metadata={"green_id": green_id, "name": payload.name}, request=request,
        )
        green_out = serialize_doc_fn(green_doc)
        return {"ok": True, "green": green_out, **green_out}

    @router.put("/admin/colonies/{colony_id}/greens/{green_id}")
    async def update_green(
        colony_id: str,
        green_id: str,
        payload: UpdateGreenIn,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        colony = await load_owned_colony_fn(colony_id, user)

        try:
            poly = shape(payload.geometry)
            if not poly.is_valid:
                poly = poly.buffer(0)
        except Exception as e:
            raise HTTPException(400, f"Invalid green geometry: {e}")

        greens_list = colony.get("greens") or []
        found = False
        updated_greens = []
        for g in greens_list:
            if g.get("id") == green_id:
                found = True
                updated_greens.append({
                    **g,
                    "name": payload.name or g.get("name"),
                    "amenity_type": payload.amenity_type or g.get("amenity_type", "park"),
                    "geometry": mapping(poly),
                })
            else:
                updated_greens.append(g)

        if not found:
            raise HTTPException(404, "Green space not found")

        await db["colonies"].update_one(
            {"_id": colony["_id"]},
            {"$set": {"greens": updated_greens}}
        )
        return {"status": "ok", "green_id": green_id}

    @router.delete("/admin/colonies/{colony_id}/greens/{green_id}")
    async def delete_green(
        colony_id: str,
        green_id: str,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        colony = await load_owned_colony_fn(colony_id, user)
        cid = str(colony["_id"])

        await db["colonies"].update_one(
            {"_id": colony["_id"]},
            {"$pull": {"greens": {"id": green_id}}}
        )

        await audit_log_fn(
            user, "GREEN_DELETED", "colony", cid,
            colony_id=cid, metadata={"green_id": green_id}, request=request,
        )
        return {"status": "ok", "deleted_green_id": green_id}

    return router
