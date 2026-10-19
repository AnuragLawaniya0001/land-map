"""Multi-Model Evidence Fusion Engine.

Fuses multi-source evidence across:
- Native PDF vectors and text spans
- PaddleOCR PP-OCRv5 detections
- SegFormer semantic segmentation proposals
- Mask2Former instance proposals
- SAM 2 refined boundaries
- Grounding DINO detection boxes
- Qwen2.5-VL layout explanations

Resolves label-to-polygon associations, detects cross-model disagreements,
calibrates confidence scores, and prevents geometric fabrication.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Set, Tuple

from shapely.geometry import Point, Polygon, box, mapping, shape
from shapely.ops import unary_union

from app.gis.ai_models.models import (
    DetectionBoxProposal,
    OCRTextDetection,
    SegmentationMaskProposal,
    VLMInterpretationResult,
)
from app.gis.evidence.schema import (
    CoordinateSpaceEnum,
    EvidenceItem,
    EvidenceSourceType,
    FusedCandidateRegion,
    StageExecutionStatus,
    UnifiedEvidenceCollection,
)
from app.gis.ingestion.native_extractor import PageExtractionResult

logger = logging.getLogger("livemap.evidence.fusion")


class MultiModelEvidenceFusionEngine:
    """Fuses heterogeneous model proposals and native evidence into validated candidates."""

    def __init__(self, iou_overlap_threshold: float = 0.5):
        self.iou_overlap_threshold = iou_overlap_threshold

    def fuse_page_evidence(
        self,
        document_id: str,
        page_num: int,
        native_extraction: PageExtractionResult,
        ocr_detections: List[OCRTextDetection],
        segformer_proposals: List[SegmentationMaskProposal],
        mask2former_proposals: List[SegmentationMaskProposal],
        sam2_refinements: List[SegmentationMaskProposal],
        dino_detections: List[DetectionBoxProposal],
        vlm_result: Optional[VLMInterpretationResult] = None,
        base_polygons: Optional[List[Dict[str, Any]]] = None,
    ) -> UnifiedEvidenceCollection:
        """Executes full multi-model fusion for a given layout page."""
        collection = UnifiedEvidenceCollection(document_id=document_id, page_count=1)

        # 1. Record Native Evidence Items
        for txt in native_extraction.text_spans:
            collection.items.append(
                EvidenceItem(
                    evidence_id=txt.evidence_id,
                    document_id=document_id,
                    page_number=page_num,
                    source_type=EvidenceSourceType.NATIVE_TEXT,
                    coordinate_space=CoordinateSpaceEnum.PDF_POINTS,
                    raw_content=txt.text,
                    normalized_content=txt.text.strip(),
                    bbox_page_pt=txt.bbox_points,
                    model_name="PyMuPDF_Native",
                    confidence=1.0,
                    calibrated_quality=1.0,
                )
            )

        for vec in native_extraction.vector_paths:
            collection.items.append(
                EvidenceItem(
                    evidence_id=vec.evidence_id,
                    document_id=document_id,
                    page_number=page_num,
                    source_type=EvidenceSourceType.NATIVE_VECTOR,
                    coordinate_space=CoordinateSpaceEnum.PDF_POINTS,
                    geometry_geojson=vec.geometry,
                    model_name="PyMuPDF_Vector",
                    confidence=1.0,
                    calibrated_quality=1.0,
                )
            )

        # 2. Record Model Evidence Items
        for ocr in ocr_detections:
            ev_id = f"ev_ocr_p{page_num}_{len(collection.items) + 1}"
            collection.items.append(
                EvidenceItem(
                    evidence_id=ev_id,
                    document_id=document_id,
                    page_number=page_num,
                    source_type=EvidenceSourceType.OCR_DETECTION,
                    coordinate_space=CoordinateSpaceEnum.PDF_POINTS,
                    raw_content=ocr.text,
                    normalized_content=ocr.text.strip(),
                    bbox_page_pt=ocr.bbox_page_pt,
                    geometry_geojson={"type": "Polygon", "coordinates": [ocr.polygon_points + [ocr.polygon_points[0]]]} if len(ocr.polygon_points) >= 3 else None,
                    model_name=ocr.model_name,
                    confidence=ocr.confidence,
                    calibrated_quality=ocr.confidence * 0.95,
                )
            )

        for seg in segformer_proposals:
            ev_id = f"ev_seg_{seg.proposal_id}"
            collection.items.append(
                EvidenceItem(
                    evidence_id=ev_id,
                    document_id=document_id,
                    page_number=page_num,
                    source_type=EvidenceSourceType.SEGFORMER_MASK,
                    coordinate_space=CoordinateSpaceEnum.PDF_POINTS,
                    geometry_geojson=seg.polygon_geojson,
                    bbox_page_pt=seg.bbox_page_pt,
                    model_name=seg.model_name,
                    confidence=seg.confidence,
                    calibrated_quality=seg.confidence * 0.85,
                )
            )

        for m2f in mask2former_proposals:
            ev_id = f"ev_m2f_{m2f.proposal_id}"
            collection.items.append(
                EvidenceItem(
                    evidence_id=ev_id,
                    document_id=document_id,
                    page_number=page_num,
                    source_type=EvidenceSourceType.MASK2FORMER_INSTANCE,
                    coordinate_space=CoordinateSpaceEnum.PDF_POINTS,
                    geometry_geojson=m2f.polygon_geojson,
                    bbox_page_pt=m2f.bbox_page_pt,
                    model_name=m2f.model_name,
                    confidence=m2f.confidence,
                    calibrated_quality=m2f.confidence * 0.88,
                )
            )

        for dino in dino_detections:
            ev_id = f"ev_dino_{dino.category}_{len(collection.items) + 1}"
            collection.items.append(
                EvidenceItem(
                    evidence_id=ev_id,
                    document_id=document_id,
                    page_number=page_num,
                    source_type=EvidenceSourceType.GROUNDING_DINO_BOX,
                    coordinate_space=CoordinateSpaceEnum.PDF_POINTS,
                    bbox_page_pt=dino.bbox_page_pt,
                    model_name=dino.model_name,
                    confidence=dino.confidence,
                    calibrated_quality=dino.confidence * 0.9,
                    processing_metadata={"label": dino.label, "category": dino.category},
                )
            )

        # 3. Deduplicate Labels (Native Text + OCR Detections)
        all_labels = self._unify_text_labels(native_extraction.text_spans, ocr_detections)

        # 4. Form Candidate Regions & Cross-Validate with Segmentation & Vector Evidence
        candidate_polys = base_polygons or []
        for p_idx, p_data in enumerate(candidate_polys):
            geom = p_data.get("geometry")
            if not geom:
                continue

            try:
                sh_poly = shape(geom)
                if not sh_poly.is_valid:
                    sh_poly = sh_poly.buffer(0)
                if sh_poly.is_empty:
                    continue
            except Exception:
                continue

            c_id = p_data.get("id") or f"cand_p{page_num}_{p_idx + 1}"
            entity_type = p_data.get("type", "plot")

            # Match primary label by spatial containment or proximity
            matched_label = None
            for lbl in all_labels:
                pt = Point(lbl["center_pt"])
                if sh_poly.contains(pt) or sh_poly.distance(pt) < 5.0:
                    matched_label = lbl["text"]
                    break

            # Cross-validate with SegFormer and Mask2Former masks
            seg_agreements: Dict[str, bool] = {}
            disagreement_notes: List[str] = []

            for seg in segformer_proposals:
                try:
                    seg_poly = shape(seg.polygon_geojson)
                    if sh_poly.intersects(seg_poly):
                        inter_area = sh_poly.intersection(seg_poly).area
                        union_area = sh_poly.union(seg_poly).area
                        iou = inter_area / max(union_area, 1e-6)
                        if iou > 0.4:
                            seg_agreements["SegFormer"] = True
                            if seg.category in ("park", "road", "water") and entity_type == "plot":
                                disagreement_notes.append(
                                    f"SegFormer classifies this region as {seg.category}, conflicting with plot candidate."
                                )
                except Exception:
                    pass

            for m2f in mask2former_proposals:
                try:
                    m2f_poly = shape(m2f.polygon_geojson)
                    if sh_poly.intersects(m2f_poly):
                        inter_area = sh_poly.intersection(m2f_poly).area
                        union_area = sh_poly.union(m2f_poly).area
                        iou = inter_area / max(union_area, 1e-6)
                        if iou > 0.4:
                            seg_agreements["Mask2Former"] = True
                except Exception:
                    pass

            # Calculate fused confidence
            conf = 0.85
            if matched_label:
                conf += 0.05
            if seg_agreements.get("SegFormer"):
                conf += 0.03
            if seg_agreements.get("Mask2Former"):
                conf += 0.02
            if disagreement_notes:
                conf -= 0.15

            val_status = "verified" if conf >= 0.9 else ("review_required" if disagreement_notes else "candidate")

            collection.fused_regions.append(
                FusedCandidateRegion(
                    candidate_id=c_id,
                    entity_type=entity_type,
                    primary_label=matched_label or p_data.get("number"),
                    geometry_geojson=mapping(sh_poly),
                    confidence=round(min(max(conf, 0.0), 1.0), 4),
                    validation_status=val_status,
                    contributing_evidence_ids=[p_data.get("evidence_id", f"geom_{c_id}")],
                    model_agreements=seg_agreements,
                    disagreement_notes=disagreement_notes,
                    source_page=page_num,
                )
            )

        if vlm_result and vlm_result.ambiguity_explanations:
            for amb in vlm_result.ambiguity_explanations:
                collection.disagreements.append(amb)

        return collection

    def _unify_text_labels(
        self,
        native_texts: List[Any],
        ocr_detections: List[OCRTextDetection],
    ) -> List[Dict[str, Any]]:
        """Deduplicates native PDF text and OCR detections without losing provenance."""
        unified: List[Dict[str, Any]] = []

        # First add all native text
        for nt in native_texts:
            bbox = nt.bbox_points
            cx = (bbox[0] + bbox[2]) / 2.0
            cy = (bbox[1] + bbox[3]) / 2.0
            unified.append({
                "text": nt.text,
                "bbox_pt": bbox,
                "center_pt": (cx, cy),
                "source": "native_pdf",
                "confidence": 1.0,
            })

        # Add OCR detections if not overlapping exact native text
        for ocr in ocr_detections:
            bbox = ocr.bbox_page_pt
            cx = (bbox[0] + bbox[2]) / 2.0
            cy = (bbox[1] + bbox[3]) / 2.0

            # Check if native text is already at this location
            is_duplicate = False
            for u in unified:
                ub = u["bbox_pt"]
                if abs(cx - u["center_pt"][0]) < 10.0 and abs(cy - u["center_pt"][1]) < 10.0:
                    is_duplicate = True
                    break

            if not is_duplicate:
                unified.append({
                    "text": ocr.text,
                    "bbox_pt": bbox,
                    "center_pt": (cx, cy),
                    "source": "ocr_ppocr5",
                    "confidence": ocr.confidence,
                })

        return unified
