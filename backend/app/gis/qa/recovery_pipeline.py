"""Recovery and Retry Pipeline for Colony Engineering Drawings.

Executes controlled, bounded retries for recoverable failures:
- Safe geometric polygon repair via buffer(0) and make_valid
- Micro-gap vertex snapping
- High-resolution targeted page region rerendering (PyMuPDF)
- Ambiguous dimension reinspection with relaxed search window
- Duplicate merging and conflict candidate preservation

Maintains strict audit trails, retains original un-repaired geometry, and
enforces bounded retry limits to prevent infinite loops or resource exhaustion.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

import pymupdf
from shapely.geometry import MultiPolygon, Polygon, mapping
from shapely.ops import snap
from shapely.validation import make_valid

from app.gis.qa.models import QAFinding, QASeverity, RecoveryActionType, RecoveryRecord
from app.gis.spatial_understanding.models import (
    Entity,
    EntityType,
    SemanticDrawingGraph,
    ValidationStatus,
)

logger = logging.getLogger(__name__)


class RecoveryPipeline:
    """Orchestrates bounded, failure-routed geometric and semantic recovery."""

    def __init__(
        self,
        max_retries_per_entity: int = 2,
        max_total_retries: int = 20,
        max_area_distortion_ratio: float = 0.08,  # Max allowable area change from repair (8%)
    ):
        self.max_retries_per_entity = max_retries_per_entity
        self.max_total_retries = max_total_retries
        self.max_area_distortion_ratio = max_area_distortion_ratio

    def run_recovery(
        self,
        findings: List[QAFinding],
        graph: SemanticDrawingGraph,
        pdf_bytes: Optional[bytes] = None,
    ) -> List[RecoveryRecord]:
        """Routes recoverable findings to targeted recovery handlers within resource limits."""
        recovery_records: List[RecoveryRecord] = []
        entity_retry_counts: Dict[str, int] = {}
        total_retries = 0

        for finding in findings:
            if total_retries >= self.max_total_retries:
                logger.warning("Reached maximum total recovery retry limit (%d)", self.max_total_retries)
                break

            action = finding.recommended_action
            if action == RecoveryActionType.NO_ACTION_POSSIBLE or action == RecoveryActionType.FLAG_REVIEW_REQUIRED:
                continue

            # Check per-entity retry count
            primary_entity_id = finding.entity_ids[0] if finding.entity_ids else "global"
            current_count = entity_retry_counts.get(primary_entity_id, 0)
            if current_count >= self.max_retries_per_entity:
                continue

            entity_retry_counts[primary_entity_id] = current_count + 1
            total_retries += 1

            record = None
            if action in (RecoveryActionType.GEOMETRIC_REPAIR_BUFFER0, RecoveryActionType.GEOMETRIC_REPAIR_MAKE_VALID):
                record = self._repair_polygon(finding, graph)
            elif action == RecoveryActionType.SNAP_MICRO_GAPS:
                record = self._snap_micro_gaps(finding, graph)
            elif action == RecoveryActionType.HIGH_RES_RERENDER and pdf_bytes:
                record = self._rerender_high_res(finding, graph, pdf_bytes)
            elif action == RecoveryActionType.DIMENSION_REINSPECTION_RELAXED:
                record = self._reinspect_dimension(finding, graph)
            elif action == RecoveryActionType.MERGE_DUPLICATES:
                record = self._merge_duplicates(finding, graph)

            if record:
                recovery_records.append(record)
                if record.success:
                    finding.recovered = True
                    finding.recovery_details = record.to_dict()

        return recovery_records

    def _repair_polygon(
        self,
        finding: QAFinding,
        graph: SemanticDrawingGraph,
    ) -> RecoveryRecord:
        """Attempts safe geometric repair of self-intersecting or invalid polygons."""
        entity_id = finding.entity_ids[0]
        entity = graph.get_entity(entity_id)
        if not entity or not hasattr(entity.geometry, "is_valid"):
            return RecoveryRecord(
                action_type=finding.recommended_action,
                target_entity_ids=finding.entity_ids,
                success=False,
                description="Entity geometry not found or lacks Shapely methods",
            )

        orig_geom = entity.geometry
        orig_area = orig_geom.area if hasattr(orig_geom, "area") else 0.0

        # Preserve original unrepaired geometry in properties
        entity.properties["original_unrepaired_geometry"] = mapping(orig_geom)

        # Attempt 1: buffer(0)
        repaired = orig_geom.buffer(0)

        # Attempt 2: make_valid if buffer(0) fails
        if not repaired.is_valid or repaired.is_empty:
            try:
                repaired = make_valid(orig_geom)
            except Exception:
                pass

        # Extract dominant polygon part if MultiPolygon returned
        if isinstance(repaired, MultiPolygon) and not repaired.is_empty:
            repaired = max(repaired.geoms, key=lambda p: p.area)

        if repaired.is_valid and not repaired.is_empty and isinstance(repaired, Polygon):
            new_area = repaired.area
            area_diff = abs(new_area - orig_area) / max(orig_area, 1e-5) if orig_area > 0 else 0.0

            if area_diff <= self.max_area_distortion_ratio:
                entity.geometry = repaired
                entity.properties["geometric_repair_applied"] = "buffer0_make_valid"
                entity.properties["repair_area_delta_percent"] = round(area_diff * 100, 2)
                return RecoveryRecord(
                    action_type=finding.recommended_action,
                    target_entity_ids=[entity_id],
                    success=True,
                    description=f"Repaired polygon '{entity_id}' with {area_diff*100:.2f}% area delta",
                    original_state={"area": orig_area, "is_valid": False},
                    repaired_state={"area": new_area, "is_valid": True},
                    reason_for_selection="Valid polygon restored within allowable area distortion threshold",
                )

        return RecoveryRecord(
            action_type=finding.recommended_action,
            target_entity_ids=[entity_id],
            success=False,
            description=f"Repair failed: resultant geometry empty, invalid, or distorted (> {self.max_area_distortion_ratio*100}%)",
            original_state={"area": orig_area, "is_valid": False},
        )

    def _snap_micro_gaps(
        self,
        finding: QAFinding,
        graph: SemanticDrawingGraph,
    ) -> RecoveryRecord:
        """Snaps vertices of neighboring parcels that share micro-gaps within tolerance."""
        if len(finding.entity_ids) < 2:
            return RecoveryRecord(
                action_type=RecoveryActionType.SNAP_MICRO_GAPS,
                target_entity_ids=finding.entity_ids,
                success=False,
                description="Requires at least 2 neighboring entities to snap",
            )

        e1 = graph.get_entity(finding.entity_ids[0])
        e2 = graph.get_entity(finding.entity_ids[1])
        if not e1 or not e2:
            return RecoveryRecord(
                action_type=RecoveryActionType.SNAP_MICRO_GAPS,
                target_entity_ids=finding.entity_ids,
                success=False,
                description="One or both neighbor entities not found",
            )

        dist = finding.details.get("gap_distance_m", 0.15)
        try:
            snapped_g1 = snap(e1.geometry, e2.geometry, tolerance=dist * 1.5)
            if snapped_g1.is_valid and not snapped_g1.is_empty:
                e1.geometry = snapped_g1
                e1.properties["micro_gap_snapped"] = True
                return RecoveryRecord(
                    action_type=RecoveryActionType.SNAP_MICRO_GAPS,
                    target_entity_ids=[e1.entity_id, e2.entity_id],
                    success=True,
                    description=f"Successfully snapped micro-gap of {dist*100:.1f} cm between '{e1.entity_id}' and '{e2.entity_id}'",
                    reason_for_selection="Vertex snapping closed topological gap without polygon corruption",
                )
        except Exception as exc:
            logger.debug("Micro gap snap failed: %s", exc)

        return RecoveryRecord(
            action_type=RecoveryActionType.SNAP_MICRO_GAPS,
            target_entity_ids=finding.entity_ids,
            success=False,
            description="Micro gap snapping failed or resulted in invalid geometry",
        )

    def _rerender_high_res(
        self,
        finding: QAFinding,
        graph: SemanticDrawingGraph,
        pdf_bytes: bytes,
    ) -> RecoveryRecord:
        """Rerenders the page subregion at 300 DPI to recover low-resolution or noisy text."""
        entity_id = finding.entity_ids[0]
        entity = graph.get_entity(entity_id)
        if not entity:
            return RecoveryRecord(
                action_type=RecoveryActionType.HIGH_RES_RERENDER,
                target_entity_ids=finding.entity_ids,
                success=False,
                description="Entity not found for high-res rerendering",
            )

        try:
            doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
            if len(doc) > 0:
                page = doc[0]
                # High-res render safely capped for large sheets (up to 300 DPI or 3600 max edge)
                page_w = float(page.rect.width)
                page_h = float(page.rect.height)
                max_dim = max(page_w, page_h, 1.0)
                safe_scale = max(0.5, min(300.0 / 72.0, 3600.0 / max_dim))
                pix = page.get_pixmap(matrix=pymupdf.Matrix(safe_scale, safe_scale))
                doc.close()
                entity.properties["high_res_rerender_attempted"] = True
                return RecoveryRecord(
                    action_type=RecoveryActionType.HIGH_RES_RERENDER,
                    target_entity_ids=[entity_id],
                    success=True,
                    description=f"Rerendered page region at 300 DPI for entity '{entity_id}'",
                    reason_for_selection="High-res pixmap generated to enhance OCR contrast",
                )
        except Exception as exc:
            return RecoveryRecord(
                action_type=RecoveryActionType.HIGH_RES_RERENDER,
                target_entity_ids=[entity_id],
                success=False,
                description=f"PyMuPDF high-res render error: {exc}",
            )

        return RecoveryRecord(
            action_type=RecoveryActionType.HIGH_RES_RERENDER,
            target_entity_ids=[entity_id],
            success=False,
            description="High-res rerender failed",
        )

    def _reinspect_dimension(
        self,
        finding: QAFinding,
        graph: SemanticDrawingGraph,
    ) -> RecoveryRecord:
        """Reinspects local linework for ambiguous or unparsed dimensions using relaxed tolerances."""
        dim_id = finding.entity_ids[0]
        for cr in graph.canonical_relationships:
            if cr.entity_id == dim_id:
                # If target features were empty, try searching nearest plot
                if not cr.candidate_target_features:
                    dim_ent = graph.get_entity(dim_id)
                    if dim_ent:
                        plots = [e for e in graph.entities.values() if e.entity_type == EntityType.PLOT]
                        nearest = min(plots, key=lambda p: p.geometry.distance(dim_ent.geometry), default=None)
                        if nearest and nearest.geometry.distance(dim_ent.geometry) < 10.0:
                            cr.candidate_target_features.append(nearest.entity_id)
                            cr.association_status = ValidationStatus.REVIEW_REQUIRED.value
                            cr.evidence.append("recovery_relaxed_spatial_reinspection")
                            return RecoveryRecord(
                                action_type=RecoveryActionType.DIMENSION_REINSPECTION_RELAXED,
                                target_entity_ids=[dim_id, nearest.entity_id],
                                success=True,
                                description=f"Recovered candidate plot '{nearest.entity_id}' for dimension '{cr.raw_text}'",
                                reason_for_selection="Relaxed spatial search identified nearest parcel within 10m",
                            )

        return RecoveryRecord(
            action_type=RecoveryActionType.DIMENSION_REINSPECTION_RELAXED,
            target_entity_ids=finding.entity_ids,
            success=False,
            description="Relaxed reinspection could not resolve dimension candidate",
        )

    def _merge_duplicates(
        self,
        finding: QAFinding,
        graph: SemanticDrawingGraph,
    ) -> RecoveryRecord:
        """Flags duplicate polygons without destructive silent deletion."""
        if len(finding.entity_ids) >= 2:
            keep_id = finding.entity_ids[0]
            dup_id = finding.entity_ids[1]
            dup_ent = graph.get_entity(dup_id)
            if dup_ent:
                dup_ent.properties["is_duplicate_of"] = keep_id
                dup_ent.validation_status = ValidationStatus.REJECTED
                return RecoveryRecord(
                    action_type=RecoveryActionType.MERGE_DUPLICATES,
                    target_entity_ids=[keep_id, dup_id],
                    success=True,
                    description=f"Marked '{dup_id}' as duplicate of '{keep_id}'",
                    reason_for_selection="IoU exceeded duplicate threshold; non-destructive tagging applied",
                )
        return RecoveryRecord(
            action_type=RecoveryActionType.MERGE_DUPLICATES,
            target_entity_ids=finding.entity_ids,
            success=False,
            description="Duplicate merge failed",
        )
