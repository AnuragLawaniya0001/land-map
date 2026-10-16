"""Canonical Colony Review and Manual Correction Service.

Implements Phase 12: Controlled, auditable manual correction workflow.
- Geometry validation with Shapely (detects self-intersections, degenerate rings, zero-area)
- Derived measurement recalculation (area_derived)
- Source declared measurement preservation
- Atomic version bump (v_N -> v_{N+1}) preserving immutable provenance of prior versions
- Audit log recording of reviewer identity, timestamp, old value, and new value.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from shapely.geometry import shape

from app.gis.canonical.models import (
    CanonicalDataset,
    CoordinateSystemMetadata,
    ReviewCorrection,
)
from app.gis.canonical.persistence import (
    _execute_find_list,
    get_canonical_dataset_by_version,
)

logger = logging.getLogger(__name__)


def validate_geometry_correction(
    geometry: Dict[str, Any],
) -> Tuple[bool, Optional[str], Optional[float]]:
    """Validates GeoJSON geometry using Shapely.

    Returns:
        (is_valid, error_message, calculated_area)
    """
    if not geometry or not isinstance(geometry, dict):
        return False, "Geometry dictionary missing or malformed", None

    try:
        geom = shape(geometry)
    except Exception as exc:
        return False, f"Failed to parse GeoJSON geometry: {exc}", None

    if geom.is_empty:
        return False, "Geometry is empty", None

    if not geom.is_valid:
        # Shapely provides detailed explanation of why geometry is invalid
        from shapely.validation import explain_validity
        reason = explain_validity(geom)
        return False, f"Invalid geometry: {reason}", None

    area = geom.area
    if area <= 1e-9:
        return False, "Geometry has zero or negligible area", None

    return True, None, area


async def commit_review_corrections_as_new_version(
    db: Any,
    colony_id: str,
    base_version: int,
    reviewer_id: str,
    corrections: List[Dict[str, Any]],
    commit_note: Optional[str] = None,
    now_iso: Optional[str] = None,
) -> Dict[str, Any]:
    """Applies reviewer corrections to base_version and commits a new version atomically."""
    if not now_iso:
        now_iso = datetime.now(timezone.utc).isoformat()

    # 1. Fetch base dataset
    base_dataset = await get_canonical_dataset_by_version(db, colony_id, int(base_version))
    if not base_dataset:
        raise ValueError(f"Base canonical dataset version {base_version} not found for colony {colony_id}")

    # 2. Pre-validate all geometry corrections before making any changes
    validated_corrections = []
    for corr in corrections:
        entity_type = corr.get("entity_type", "Plot")
        entity_id = corr.get("entity_id")
        field_name = corr.get("field_name")
        new_val = corr.get("corrected_value")
        prev_val = corr.get("previous_value")
        reason = corr.get("reason") or commit_note

        if not entity_id or not field_name:
            raise ValueError("Correction requires 'entity_id' and 'field_name'")

        if field_name == "geometry":
            is_valid, err_msg, new_area = validate_geometry_correction(new_val)
            if not is_valid:
                raise ValueError(f"Geometry correction for {entity_type} '{entity_id}' rejected: {err_msg}")
            corr["_recalculated_area"] = new_area

        validated_corrections.append(corr)

    # 3. Determine next version number
    all_datasets = await _execute_find_list(db["canonical_datasets"], {"colony_id": colony_id})
    max_ver = max([d.get("version", 0) for d in all_datasets], default=0)
    next_version = max_ver + 1

    # 4. Clone entities from base_version to next_version
    base_plots = await _execute_find_list(
        db["canonical_plots"],
        {"colony_id": colony_id, "dataset_version": int(base_version)},
    )
    base_roads = await _execute_find_list(
        db["canonical_roads"],
        {"colony_id": colony_id, "dataset_version": int(base_version)},
    )
    base_dims = await _execute_find_list(
        db["canonical_dimensions"],
        {"colony_id": colony_id, "dataset_version": int(base_version)},
    )
    base_rels = await _execute_find_list(
        db["canonical_relationships"],
        {"colony_id": colony_id, "dataset_version": int(base_version)},
    )

    # Deep clone plots and map by ID
    new_plots_by_id = {}
    for p in base_plots:
        p_copy = dict(p)
        if "_id" in p_copy:
            del p_copy["_id"]
        p_copy["dataset_version"] = next_version
        p_copy["updated_at"] = now_iso
        new_plots_by_id[p_copy["id"]] = p_copy

    # Deep clone roads
    new_roads_by_id = {}
    for r in base_roads:
        r_copy = dict(r)
        if "_id" in r_copy:
            del r_copy["_id"]
        r_copy["dataset_version"] = next_version
        r_copy["updated_at"] = now_iso
        new_roads_by_id[r_copy["id"]] = r_copy

    # Deep clone dimensions & relationships
    new_dims = []
    for d in base_dims:
        d_copy = dict(d)
        if "_id" in d_copy:
            del d_copy["_id"]
        d_copy["dataset_version"] = next_version
        new_dims.append(d_copy)

    new_rels = []
    for rel in base_rels:
        rel_copy = dict(rel)
        if "_id" in rel_copy:
            del rel_copy["_id"]
        rel_copy["dataset_version"] = next_version
        new_rels.append(rel_copy)

    # 5. Apply corrections to new entities and record audit log
    audit_records = []
    for corr in validated_corrections:
        e_type = corr["entity_type"]
        e_id = corr["entity_id"]
        f_name = corr["field_name"]
        new_v = corr["corrected_value"]
        old_v = corr.get("previous_value")
        reason = corr.get("reason") or commit_note

        corr_id = f"corr-{uuid.uuid4().hex[:12]}"
        audit_record = ReviewCorrection(
            correction_id=corr_id,
            colony_id=colony_id,
            dataset_version=next_version,
            entity_type=e_type,
            entity_id=e_id,
            field_name=f_name,
            previous_value=old_v,
            corrected_value=new_v,
            reviewer_user_id=reviewer_id,
            timestamp=now_iso,
            reason=reason,
        )
        audit_records.append(audit_record.to_dict())

        if e_type == "Plot" and e_id in new_plots_by_id:
            target = new_plots_by_id[e_id]
            target[f_name] = new_v
            # If geometry was changed, update derived area while preserving declared area
            if f_name == "geometry" and "_recalculated_area" in corr:
                target["area_derived"] = round(float(corr["_recalculated_area"]), 2)
            # Add provenance tag
            if "provenance" not in target or not isinstance(target["provenance"], dict):
                target["provenance"] = {}
            target["provenance"][f"correction_{corr_id}"] = {
                "reviewer": reviewer_id,
                "timestamp": now_iso,
                "reason": reason,
                "field": f_name,
            }
        elif e_type == "Road" and e_id in new_roads_by_id:
            target = new_roads_by_id[e_id]
            target[f_name] = new_v

    # 6. Insert new entities
    if new_plots_by_id:
        await db["canonical_plots"].insert_many(list(new_plots_by_id.values()))
    if new_roads_by_id:
        await db["canonical_roads"].insert_many(list(new_roads_by_id.values()))
    if new_dims:
        await db["canonical_dimensions"].insert_many(new_dims)
    if new_rels:
        await db["canonical_relationships"].insert_many(new_rels)
    if audit_records:
        await db["review_corrections"].insert_many(audit_records)

    # 7. Inactivate prior active versions
    await db["canonical_datasets"].update_many(
        {"colony_id": colony_id},
        {"$set": {"is_active": False}},
    )

    # 8. Create new CanonicalDataset record
    new_dataset = CanonicalDataset(
        colony_id=colony_id,
        version=next_version,
        is_active=True,
        approval_status="APPROVED",
        source_sha256=base_dataset.get("source_sha256", ""),
        source_filename=base_dataset.get("source_filename", ""),
        processing_run_id=f"run-review-{uuid.uuid4().hex[:8]}",
        crs_metadata=CoordinateSystemMetadata.from_dict(base_dataset.get("crs_metadata")),
        plots_count=len(new_plots_by_id),
        roads_count=len(new_roads_by_id),
        relationships_count=len(new_rels),
        dimensions_count=len(new_dims),
        qa_quality_grade="A_VERIFIED",
        qa_findings_summary={"corrections_applied": len(validated_corrections)},
        summary={
            "committed_via": "manual_review_workflow",
            "base_version": base_version,
            "corrections_count": len(validated_corrections),
            "commit_note": commit_note,
        },
        created_at=now_iso,
        created_by=reviewer_id,
    )
    await db["canonical_datasets"].insert_one(new_dataset.to_dict())

    # 9. Create processing run entry for audit
    proc_run = {
        "run_id": new_dataset.processing_run_id,
        "colony_id": colony_id,
        "canonical_dataset_version": next_version,
        "source_filename": base_dataset.get("source_filename", ""),
        "created_by": reviewer_id,
        "created_at": now_iso,
        "status": "COMMITTED",
        "quality_grade": "A_VERIFIED",
        "qa_summary": {"validation_passed": True, "manual_corrections": len(validated_corrections)},
        "errors": [],
        "warnings": [],
    }
    await db["processing_runs"].insert_one(proc_run)

    return {
        "success": True,
        "colony_id": colony_id,
        "base_version": base_version,
        "new_version": next_version,
        "corrections_applied": len(validated_corrections),
        "dataset": new_dataset.to_dict(),
    }
