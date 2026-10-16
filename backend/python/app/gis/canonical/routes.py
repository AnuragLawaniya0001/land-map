"""Canonical Colony Read & Correction API Routes.

Implements queryable endpoints under /admin/colonies/{colonyId}/canonical/...
enforcing tenant/colony ownership, authentication, pagination, and provenance queries.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, Callable, Dict, List, Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from app.gis.canonical.models import ReviewCorrection
from app.gis.canonical.persistence import (
    get_active_canonical_dataset,
    get_canonical_dataset_by_version,
    get_canonical_plot,
    get_entity_provenance,
    list_canonical_dimensions,
    list_canonical_plots,
    list_canonical_relationships,
    list_canonical_roads,
    list_canonical_versions,
    list_processing_runs,
    list_qa_findings,
    list_review_corrections,
    record_review_correction,
)
from app.storage import get_signed_url

logger = logging.getLogger("canonical.routes")


def _overlay_plot_candidates(colony_id: str, regions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    candidates = []
    for index, region in enumerate(regions):
        geometry = region.get("geometry")
        if not geometry:
            continue
        source_number = str(region.get("number") or "").strip()
        reference = source_number or f"R-{index + 1:03d}"
        candidates.append({
            "id": str(region.get("id") or f"overlay-plot-{colony_id}-{reference}"),
            "colony_id": colony_id,
            "number": reference,
            "original_number": source_number or None,
            "normalized_number": source_number or None,
            "is_generated_candidate_id": not bool(source_number),
            "geometry": geometry,
            "area_sqm": region.get("area_sqm") or 0.0,
            "status": "available",
            "semantic_validation_status": "review_required",
            "detection_source": region.get("detection_source") or "raster_vector_trace",
        })
    return candidates


def _ensure_geographic_crs(crs: Optional[dict], boundary: Optional[dict], plots: Optional[list] = None) -> Optional[dict]:
    """Dynamically ensures WGS84 CRS metadata is returned whenever boundary or plots have geographic degree coordinates."""
    has_geo = False
    if boundary and isinstance(boundary, dict):
        coords = boundary.get("coordinates")
        if coords:
            try:
                pt = coords[0]
                while isinstance(pt, (list, tuple)) and len(pt) > 0 and isinstance(pt[0], (list, tuple)):
                    pt = pt[0]
                if pt and len(pt) >= 2 and isinstance(pt[0], (int, float)) and isinstance(pt[1], (int, float)):
                    if -180 <= pt[0] <= 180 and -90 <= pt[1] <= 90 and (abs(pt[0]) > 0.1 or abs(pt[1]) > 0.1):
                        has_geo = True
            except Exception:
                pass
    if not has_geo and plots:
        try:
            p0 = plots[0] if isinstance(plots, list) and plots else None
            p_geom = (p0.get("geometry") or {}) if isinstance(p0, dict) else None
            if p_geom and isinstance(p_geom, dict):
                coords = p_geom.get("coordinates")
                if coords:
                    pt = coords[0]
                    while isinstance(pt, (list, tuple)) and len(pt) > 0 and isinstance(pt[0], (list, tuple)):
                        pt = pt[0]
                    if pt and len(pt) >= 2 and isinstance(pt[0], (int, float)) and isinstance(pt[1], (int, float)):
                        if -180 <= pt[0] <= 180 and -90 <= pt[1] <= 90 and (abs(pt[0]) > 0.1 or abs(pt[1]) > 0.1):
                            has_geo = True
        except Exception:
            pass

    if has_geo:
        base = dict(crs) if isinstance(crs, dict) else {}
        base["crs_type"] = "geographic_wgs84"
        base["epsg"] = 4326
        base["units"] = "deg"
        base["is_geographic"] = True
        base["is_georeferenced"] = True
        if not base.get("georeferencing_status") or base.get("georeferencing_status") == "unregistered":
            base["georeferencing_status"] = "authoritative_kml" if boundary else "provisional_shape_fit"
        base["geographic_verified"] = True
        return base

    if isinstance(crs, dict):
        res = dict(crs)
        if not res.get("georeferencing_status"):
            res["georeferencing_status"] = "provisional_shape_fit"
            res["geographic_verified"] = False
        return res
    return crs


class CorrectionPayload(BaseModel):
    dataset_version: int = Field(..., description="Dataset version being corrected")
    entity_type: str = Field(..., description="Entity type ('Plot', 'Road', 'DimensionAnnotation')")
    entity_id: str = Field(..., description="Target entity ID")
    field_name: str = Field(..., description="Attribute being modified")
    previous_value: Any = Field(None, description="Previous value before correction")
    corrected_value: Any = Field(..., description="New corrected value")
    reason: Optional[str] = Field(None, description="Reason for correction")


def build_canonical_router(
    db: Any,
    require_admin_dep: Any,
    owned_colony_fn: Callable[[str, Any], Any],
    now_iso_fn: Callable[[], str],
) -> APIRouter:
    router = APIRouter()

    def _get(val: Any, key: str, default: Any = None) -> Any:
        if isinstance(val, dict):
            return val.get(key, default)
        return getattr(val, key, default)

    def _pdf_overlay_out(colony: Any) -> Optional[Dict[str, Any]]:
        overlay = _get(colony, "pdf_overlay", {}) or {}
        storage_key = overlay.get("storage_key") if isinstance(overlay, dict) else None
        if not storage_key:
            return None
        source_filename = str(
            (_get(colony, "import_source", {}) or {}).get("filename") or ""
        ).lower()
        return {
            "url": get_signed_url(storage_key, 86400),
            "bounds": overlay.get("bounds"),
            "source_type": overlay.get("source_type") or (
                "cad" if source_filename.endswith((".dwg", ".dxf", ".dwf")) else "pdf"
            ),
            "fit": overlay.get("fit") or {},
        }

    @router.get("/admin/colonies/{colonyId}/canonical")
    async def get_colony_canonical(
        colonyId: str,
        version: Optional[int] = Query(None, description="Optional version number"),
        user=Depends(require_admin_dep),
    ):
        colony = await owned_colony_fn(colonyId, user)
        if version is not None:
            dataset = await get_canonical_dataset_by_version(db, colonyId, version)
        else:
            dataset = await get_active_canonical_dataset(db, colonyId)

        if not dataset:
            raise HTTPException(404, f"No canonical dataset found for colony {colonyId}")

        # Clean _id for serialization
        if "_id" in dataset:
            dataset["_id"] = str(dataset["_id"])

        return {
            "colony_id": colonyId,
            "colony_name": _get(colony, "name", ""),
            "dataset": dataset,
        }

    @router.get("/admin/colonies/{colonyId}/canonical/bundle")
    async def get_colony_canonical_bundle(
        colonyId: str,
        version: Optional[int] = Query(None, description="Optional version number"),
        user=Depends(require_admin_dep),
    ):
        """Unified high-performance endpoint returning complete canonical dataset in one request."""
        colony = await owned_colony_fn(colonyId, user)
        if version is not None:
            dataset = await get_canonical_dataset_by_version(db, colonyId, version)
        else:
            dataset = await get_active_canonical_dataset(db, colonyId)

        if not dataset:
            legacy_plots_cursor = db["plots"].find({"colony_id": colonyId})
            legacy_plots = await legacy_plots_cursor.to_list(length=1000)
            plots_out = []
            if legacy_plots:
                for lp in legacy_plots:
                    if "_id" in lp:
                        lp["_id"] = str(lp["_id"])
                plots_out = legacy_plots
            overlay_regs = (
                colony.get("pdf_overlay", {}).get("plot_regions")
                or colony.get("pdf_overlay", {}).get("regions")
                or []
            )
            if not plots_out and overlay_regs:
                plots_out = _overlay_plot_candidates(colonyId, overlay_regs)

            legacy_crs = _ensure_geographic_crs(_get(colony, "crs_metadata"), _get(colony, "boundary"), plots_out)
            return {
                "status": "ok",
                "colony_id": colonyId,
                "colony_name": _get(colony, "name", ""),
                "dataset": None,
                "boundary": _get(colony, "boundary"),
                "greens": _get(colony, "greens", []),
                "plots": plots_out,
                "roads": _get(colony, "roads", []),
                "dimensions": [],
                "qa_findings": [],
                "versions": [],
                "crs_metadata": legacy_crs,
                "pdf_overlay": _pdf_overlay_out(colony),
                "legacy_import_source": _get(colony, "import_source", {}),
                "is_legacy_only": True,
            }

        curr_ver = dataset.get("version", 1)
        if "_id" in dataset:
            dataset["_id"] = str(dataset["_id"])

        # Fetch plots, roads, dimensions, qa_findings, and versions concurrently
        plots_task = list_canonical_plots(db, colony_id=colonyId, version=curr_ver, limit=1000)
        roads_task = list_canonical_roads(db, colony_id=colonyId, version=curr_ver)
        dims_task = list_canonical_dimensions(db, colony_id=colonyId, version=curr_ver)
        qa_task = list_qa_findings(db, colony_id=colonyId, version=curr_ver)
        versions_task = list_canonical_versions(db, colonyId)

        plots_res, roads_res, dims_res, qa_res, versions_res = await asyncio.gather(
            plots_task, roads_task, dims_task, qa_task, versions_task
        )

        plots_list = plots_res.get("plots", []) if isinstance(plots_res, dict) else (plots_res if isinstance(plots_res, list) else [])
        roads_list = roads_res if isinstance(roads_res, list) else (roads_res.get("roads", []) if isinstance(roads_res, dict) else [])
        dims_list = dims_res if isinstance(dims_res, list) else (dims_res.get("dimensions", []) if isinstance(dims_res, dict) else [])
        qa_list = qa_res if isinstance(qa_res, list) else (qa_res.get("findings", []) if isinstance(qa_res, dict) else [])
        versions_list = versions_res if isinstance(versions_res, list) else (versions_res.get("versions", []) if isinstance(versions_res, dict) else [])

        for p in plots_list:
            if "_id" in p:
                p["_id"] = str(p["_id"])
            if not p.get("number"):
                p["number"] = p.get("normalized_number") or p.get("original_number") or ""
            if not p.get("area_sqm"):
                p["area_sqm"] = p.get("area_declared") or p.get("area_derived") or 0.0
            if "status" not in p:
                p["status"] = "available"
        for r in roads_list:
            if "_id" in r:
                r["_id"] = str(r["_id"])
        for d in dims_list:
            if "_id" in d:
                d["_id"] = str(d["_id"])
        for q in qa_list:
            if "_id" in q:
                q["_id"] = str(q["_id"])
        for v in versions_list:
            if "_id" in v:
                v["_id"] = str(v["_id"])

        # Fallback to legacy plots or overlay regions if canonical plots are empty
        if not plots_list:
            legacy_plots_cursor = db["plots"].find({"colony_id": colonyId})
            legacy_plots = await legacy_plots_cursor.to_list(length=1000)
            if legacy_plots:
                for lp in legacy_plots:
                    if "_id" in lp:
                        lp["_id"] = str(lp["_id"])
                plots_list = legacy_plots
            overlay_regs = (
                colony.get("pdf_overlay", {}).get("plot_regions")
                or colony.get("pdf_overlay", {}).get("regions")
                or []
            )
            if not plots_list and overlay_regs:
                plots_list = _overlay_plot_candidates(colonyId, overlay_regs)

        resolved_crs = _ensure_geographic_crs(
            dataset.get("crs_metadata") or _get(colony, "crs_metadata"),
            _get(colony, "boundary"),
            plots_list,
        )

        return {
            "status": "ok",
            "colony_id": colonyId,
            "colony_name": _get(colony, "name", ""),
            "dataset": dataset,
            "boundary": _get(colony, "boundary"),
            "greens": _get(colony, "greens", []),
            "plots": plots_list,
            "roads": roads_list,
            "dimensions": dims_list,
            "qa_findings": qa_list,
            "versions": versions_list,
            "crs_metadata": resolved_crs,
            "pdf_overlay": _pdf_overlay_out(colony),
            "legacy_import_source": _get(colony, "import_source", {}),
            "is_legacy_only": False,
        }

    @router.get("/admin/colonies/{colonyId}/canonical/versions")
    async def list_colony_versions(
        colonyId: str,
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        versions = await list_canonical_versions(db, colonyId)
        for v in versions:
            if "_id" in v:
                v["_id"] = str(v["_id"])
        return {"colony_id": colonyId, "versions": versions}

    @router.get("/admin/colonies/{colonyId}/canonical/plots")
    async def get_canonical_plots(
        colonyId: str,
        version: Optional[int] = Query(None, description="Dataset version (defaults to active)"),
        limit: int = Query(50, ge=1, le=500),
        skip: int = Query(0, ge=0),
        validation_status: Optional[str] = Query(None, description="Filter by status (verified/candidate/review_required)"),
        road_id: Optional[str] = Query(None, description="Filter by adjacent road ID"),
        plot_number: Optional[str] = Query(None, description="Filter by original plot number"),
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        res = await list_canonical_plots(
            db,
            colony_id=colonyId,
            version=version,
            limit=limit,
            skip=skip,
            validation_status=validation_status,
            road_id=road_id,
            plot_number=plot_number,
        )
        for p in res["plots"]:
            if "_id" in p:
                p["_id"] = str(p["_id"])
        return res

    @router.get("/admin/colonies/{colonyId}/canonical/plots/{plotId}")
    async def get_single_canonical_plot(
        colonyId: str,
        plotId: str,
        version: Optional[int] = Query(None, description="Dataset version (defaults to active)"),
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        plot = await get_canonical_plot(db, colonyId, plotId, version)
        if not plot:
            raise HTTPException(404, f"Canonical plot '{plotId}' not found")
        if "_id" in plot:
            plot["_id"] = str(plot["_id"])
        return plot

    @router.get("/admin/colonies/{colonyId}/canonical/roads")
    async def get_canonical_roads(
        colonyId: str,
        version: Optional[int] = Query(None, description="Dataset version (defaults to active)"),
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        roads = await list_canonical_roads(db, colonyId, version)
        for r in roads:
            if "_id" in r:
                r["_id"] = str(r["_id"])
        return {"colony_id": colonyId, "roads": roads}

    @router.get("/admin/colonies/{colonyId}/canonical/dimensions")
    async def get_canonical_dimensions(
        colonyId: str,
        version: Optional[int] = Query(None, description="Dataset version (defaults to active)"),
        target_feature_id: Optional[str] = Query(None, description="Filter by target feature ID"),
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        dims = await list_canonical_dimensions(db, colonyId, version, target_feature_id)
        for d in dims:
            if "_id" in d:
                d["_id"] = str(d["_id"])
        return {"colony_id": colonyId, "dimensions": dims}

    @router.get("/admin/colonies/{colonyId}/canonical/relationships")
    async def get_canonical_relationships(
        colonyId: str,
        version: Optional[int] = Query(None, description="Dataset version (defaults to active)"),
        entity_id: Optional[str] = Query(None, description="Filter by entity ID"),
        relationship_type: Optional[str] = Query(None, description="Filter by relationship type"),
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        rels = await list_canonical_relationships(db, colonyId, version, entity_id, relationship_type)
        for r in rels:
            if "_id" in r:
                r["_id"] = str(r["_id"])
        return {"colony_id": colonyId, "relationships": rels}

    @router.get("/admin/colonies/{colonyId}/canonical/provenance/{entityId}")
    async def get_entity_provenance_route(
        colonyId: str,
        entityId: str,
        version: Optional[int] = Query(None, description="Dataset version (defaults to active)"),
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        prov = await get_entity_provenance(db, colonyId, entityId, version)
        if not prov:
            raise HTTPException(404, f"Provenance trace for '{entityId}' not found")
        if prov.get("processing_run") and "_id" in prov["processing_run"]:
            prov["processing_run"]["_id"] = str(prov["processing_run"]["_id"])
        return prov

    @router.get("/admin/colonies/{colonyId}/canonical/qa-findings")
    async def get_canonical_qa_findings(
        colonyId: str,
        version: Optional[int] = Query(None, description="Dataset version (defaults to active)"),
        severity: Optional[str] = Query(None, description="Filter by severity (error/warning/info)"),
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        findings = await list_qa_findings(db, colonyId, version, severity)
        return {"colony_id": colonyId, "findings": findings}

    @router.get("/admin/colonies/{colonyId}/canonical/runs")
    async def get_canonical_processing_runs(
        colonyId: str,
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        runs = await list_processing_runs(db, colonyId)
        for r in runs:
            if "_id" in r:
                r["_id"] = str(r["_id"])
        return {"colony_id": colonyId, "runs": runs}

    @router.post("/admin/colonies/{colonyId}/canonical/corrections")
    async def submit_review_correction(
        colonyId: str,
        payload: CorrectionPayload,
        request: Request,
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        now = now_iso_fn()
        reviewer_id = str(_get(user, "id") or _get(user, "_id") or "admin")
        corr = ReviewCorrection(
            correction_id=f"corr-{uuid.uuid4().hex[:12]}",
            colony_id=colonyId,
            dataset_version=payload.dataset_version,
            entity_type=payload.entity_type,
            entity_id=payload.entity_id,
            field_name=payload.field_name,
            previous_value=payload.previous_value,
            corrected_value=payload.corrected_value,
            reviewer_user_id=reviewer_id,
            timestamp=now,
            reason=payload.reason,
        )
        res = await record_review_correction(db, colonyId, corr)
        return res

    @router.get("/admin/colonies/{colonyId}/canonical/corrections")
    async def get_review_corrections_route(
        colonyId: str,
        version: Optional[int] = Query(None, description="Dataset version"),
        entity_id: Optional[str] = Query(None, description="Target entity ID"),
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        corrections = await list_review_corrections(db, colonyId, version, entity_id)
        for c in corrections:
            if "_id" in c:
                c["_id"] = str(c["_id"])
        return {"colony_id": colonyId, "corrections": corrections}

    @router.post("/admin/colonies/{colonyId}/canonical/corrections/validate-geometry")
    async def validate_geometry_route(
        colonyId: str,
        payload: Dict[str, Any],
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        from app.gis.canonical.correction_service import validate_geometry_correction
        geom = payload.get("geometry")
        is_valid, err_msg, area = validate_geometry_correction(geom)
        return {
            "is_valid": is_valid,
            "error_message": err_msg,
            "calculated_area": area,
        }

    @router.post("/admin/colonies/{colonyId}/canonical/corrections/commit")
    async def commit_review_corrections_route(
        colonyId: str,
        payload: Dict[str, Any],
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        from app.gis.canonical.correction_service import commit_review_corrections_as_new_version
        base_version = payload.get("base_version")
        if base_version is None:
            raise HTTPException(400, "Missing required 'base_version'")
        corrections = payload.get("corrections", [])
        commit_note = payload.get("commit_note")
        reviewer_id = str(_get(user, "id") or _get(user, "_id") or "admin")
        now = now_iso_fn()

        try:
            res = await commit_review_corrections_as_new_version(
                db=db,
                colony_id=colonyId,
                base_version=int(base_version),
                reviewer_id=reviewer_id,
                corrections=corrections,
                commit_note=commit_note,
                now_iso=now,
            )
            return res
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    @router.patch("/admin/colonies/{colonyId}/canonical/plots/{plotId}/review-status")
    async def update_plot_review_status_route(
        colonyId: str,
        plotId: str,
        payload: Dict[str, Any],
        user=Depends(require_admin_dep),
    ):
        await owned_colony_fn(colonyId, user)
        status = payload.get("validation_status")
        if status not in ("verified", "candidate", "review_required", "conflicted"):
            raise HTTPException(400, f"Invalid status '{status}'")
        version = payload.get("version")
        if version is None:
            active = await get_active_canonical_dataset(db, colonyId)
            if not active:
                raise HTTPException(404, "No active dataset found")
            version = active["version"]

        reviewer_id = str(_get(user, "id") or _get(user, "_id") or "admin")
        now = now_iso_fn()

        corr = ReviewCorrection(
            correction_id=f"corr-{uuid.uuid4().hex[:12]}",
            colony_id=colonyId,
            dataset_version=int(version),
            entity_type="Plot",
            entity_id=plotId,
            field_name="semantic_validation_status",
            previous_value=None,
            corrected_value=status,
            reviewer_user_id=reviewer_id,
            timestamp=now,
            reason=payload.get("reason") or "Review status update",
        )
        await record_review_correction(db, colonyId, corr)
        return {"success": True, "plot_id": plotId, "status": status}

    @router.get("/admin/colonies/{colonyId}/canonical/export")
    async def export_canonical_dataset_route(
        colonyId: str,
        format: str = Query("geojson", pattern="^(geojson|csv|qa_json|dxf)$"),
        version: Optional[int] = Query(None, description="Dataset version"),
        include_review_required: bool = Query(True, description="Whether to include review-required records"),
        user=Depends(require_admin_dep),
    ):
        colony = await owned_colony_fn(colonyId, user)
        raw_name = _get(colony, "name", "colony")
        colony_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in raw_name)

        from app.gis.canonical.export_service import (
            generate_geojson_export,
            generate_csv_export,
            generate_qa_report_export,
            generate_dxf_export,
        )

        target_ver = version
        if target_ver is None:
            active = await get_active_canonical_dataset(db, colonyId)
            target_ver = active["version"] if active else 1

        if format == "geojson":
            data = await generate_geojson_export(db, colonyId, target_ver, include_review_required)
            content = json.dumps(data, indent=2)
            filename = f"{colony_name}_canonical_v{target_ver}.geojson"
            return Response(
                content=content,
                media_type="application/geo+json",
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )

        elif format == "csv":
            csv_str = await generate_csv_export(db, colonyId, target_ver, include_review_required)
            filename = f"{colony_name}_plots_v{target_ver}.csv"
            return Response(
                content=csv_str,
                media_type="text/csv",
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )

        elif format == "qa_json":
            qa_data = await generate_qa_report_export(db, colonyId, target_ver)
            content = json.dumps(qa_data, indent=2, default=str)
            filename = f"{colony_name}_qa_report_v{target_ver}.json"
            return Response(
                content=content,
                media_type="application/json",
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )

        elif format == "dxf":
            dxf_bytes = await generate_dxf_export(db, colonyId, target_ver, include_review_required)
            filename = f"{colony_name}_cad_v{target_ver}.dxf"
            return Response(
                content=dxf_bytes,
                media_type="application/dxf",
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )

        raise HTTPException(400, f"Unsupported export format '{format}'")

    return router
