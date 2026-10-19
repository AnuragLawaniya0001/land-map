"""Unified Evidence Schema for Multi-Model GIS Pipeline.

Defines typed evidence records for all extraction and model stages, ensuring
provenance, coordinate space clarity, confidence metrics, and traceability
without dropping source-level data.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class EvidenceSourceType(str, Enum):
    NATIVE_VECTOR = "native_vector"
    NATIVE_TEXT = "native_text"
    OCR_DETECTION = "ocr_detection"
    SEGFORMER_MASK = "segformer_mask"
    MASK2FORMER_INSTANCE = "mask2former_instance"
    SAM2_REFINEMENT = "sam2_refinement"
    GROUNDING_DINO_BOX = "grounding_dino_box"
    VLM_INTERPRETATION = "vlm_interpretation"
    RASTER_TRACE = "raster_trace"
    USER_REVIEW_CORRECTION = "user_review_correction"


class CoordinateSpaceEnum(str, Enum):
    PDF_POINTS = "pdf_points"
    RENDERED_PIXELS = "rendered_pixels"
    LOCAL_METERS = "local_meters"
    GEOGRAPHIC_WGS84 = "geographic_wgs84"


class StageExecutionStatus(str, Enum):
    SUCCESS = "success"
    PARTIAL = "partial"
    SKIPPED = "skipped"
    FAILED = "failed"


class EvidenceItem(BaseModel):
    evidence_id: str = Field(..., description="Unique deterministic evidence ID")
    document_id: str = Field(..., description="Source document ID or job ID")
    page_number: int = Field(1, description="1-indexed source PDF page")
    source_type: EvidenceSourceType = Field(..., description="Model, engine, or native extractor")
    coordinate_space: CoordinateSpaceEnum = Field(CoordinateSpaceEnum.PDF_POINTS)
    raw_content: Optional[str] = Field(None, description="Raw text or source representation")
    normalized_content: Optional[str] = Field(None, description="Cleaned/normalized text or label")
    geometry_geojson: Optional[Dict[str, Any]] = Field(None, description="GeoJSON geometry in page points")
    bbox_page_pt: Optional[List[float]] = Field(None, description="Bounding box [x1, y1, x2, y2] in points")
    model_name: str = Field(..., description="Engine/model name that generated evidence")
    model_version: Optional[str] = Field(None)
    confidence: float = Field(1.0, ge=0.0, le=1.0)
    calibrated_quality: float = Field(1.0, ge=0.0, le=1.0)
    source_artifact_ref: Optional[str] = Field(None, description="Path or key to image/mask crop artifact")
    related_evidence_ids: List[str] = Field(default_factory=list)
    processing_metadata: Dict[str, Any] = Field(default_factory=dict)
    stage_status: StageExecutionStatus = Field(StageExecutionStatus.SUCCESS)
    uncertainty_reason: Optional[str] = Field(None)


class FusedCandidateRegion(BaseModel):
    candidate_id: str = Field(..., description="Unique candidate region ID")
    entity_type: str = Field("plot", description="plot, road, park, water, amenity, boundary")
    primary_label: Optional[str] = Field(None, description="Associated plot number or road name")
    geometry_geojson: Dict[str, Any] = Field(..., description="Reconstructed boundary polygon")
    confidence: float = Field(0.8, ge=0.0, le=1.0)
    validation_status: str = Field("candidate", description="verified, candidate, review_required, conflicted")
    contributing_evidence_ids: List[str] = Field(default_factory=list)
    model_agreements: Dict[str, bool] = Field(default_factory=dict)
    disagreement_notes: List[str] = Field(default_factory=list)
    source_page: int = Field(1)
    dimensions: Dict[str, Any] = Field(default_factory=dict)


class UnifiedEvidenceCollection(BaseModel):
    document_id: str
    page_count: int
    items: List[EvidenceItem] = Field(default_factory=list)
    fused_regions: List[FusedCandidateRegion] = Field(default_factory=list)
    disagreements: List[Dict[str, Any]] = Field(default_factory=list)
    execution_summary: Dict[str, Any] = Field(default_factory=dict)
