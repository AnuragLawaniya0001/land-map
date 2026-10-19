"""Canonical Colony Data Model.

Defines the durable, versioned, queryable canonical entities, spatial geometries,
semantic relationships, processing runs, review corrections, and provenance records.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple, Union

from app.gis.canonical.crs import CoordinateSystemMetadata, validate_and_normalize_geometry
from app.gis.qa.models import QAFinding, QASeverity, QualityGrade


class CanonicalEntityType(str, Enum):
    COLONY_PROJECT = "ColonyProject"
    SOURCE_DOCUMENT = "SourceDocument"
    SOURCE_PAGE = "SourcePage"
    SITE_BOUNDARY = "SiteBoundary"
    PLOT = "Plot"
    ROAD = "Road"
    PARK = "Park"
    OPEN_SPACE = "OpenSpace"
    BUILDING = "Building"
    GEOMETRY_EDGE = "GeometryEdge"
    TEXT_LABEL = "TextLabel"
    DIMENSION_ANNOTATION = "DimensionAnnotation"
    JUNCTION = "Junction"
    LEGEND_ENTRY = "LegendEntry"
    SEMANTIC_RELATIONSHIP = "SemanticRelationship"
    QA_FINDING = "QAFinding"
    PROCESSING_RUN = "ProcessingRun"
    REVIEW_CORRECTION = "ReviewCorrection"


class CanonicalRelationshipType(str, Enum):
    LABEL_BELONGS_TO_FEATURE = "label_belongs_to_feature"
    DIMENSION_MEASURES_EDGE = "dimension_measures_edge"
    DIMENSION_MEASURES_FEATURE = "dimension_measures_feature"
    PLOT_ADJACENT_TO_PLOT = "plot_adjacent_to_plot"
    PLOT_ADJACENT_TO_ROAD = "plot_adjacent_to_road"
    EDGE_SHARED_BY_FEATURES = "edge_shared_by_features"
    FEATURE_INSIDE_SITE_BOUNDARY = "feature_inside_site_boundary"
    FEATURE_DERIVED_FROM_SOURCE = "feature_derived_from_source"
    TEXT_EXPLAINS_FEATURE = "text_explains_feature"
    ENTITY_CONFLICTS_WITH_ENTITY = "entity_conflicts_with_entity"


@dataclass
class CanonicalGeometryEdge:
    id: str
    parent_feature_id: str
    parent_feature_type: str  # "Plot", "Road", "SiteBoundary", etc.
    geometry: Dict[str, Any]  # GeoJSON LineString
    measured_length_m: Optional[float] = None
    shared_with_feature_ids: List[str] = field(default_factory=list)
    road_frontage_classification: Optional[str] = None  # "frontage", "rear", "side", "interior"
    source_line_references: List[str] = field(default_factory=list)
    geometry_valid: bool = True
    provenance: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "parent_feature_id": self.parent_feature_id,
            "parent_feature_type": self.parent_feature_type,
            "geometry": self.geometry,
            "measured_length_m": self.measured_length_m,
            "shared_with_feature_ids": list(self.shared_with_feature_ids),
            "road_frontage_classification": self.road_frontage_classification,
            "source_line_references": list(self.source_line_references),
            "geometry_valid": self.geometry_valid,
            "provenance": self.provenance,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> CanonicalGeometryEdge:
        return cls(
            id=data["id"],
            parent_feature_id=data["parent_feature_id"],
            parent_feature_type=data.get("parent_feature_type", "Plot"),
            geometry=data.get("geometry") or {},
            measured_length_m=data.get("measured_length_m"),
            shared_with_feature_ids=data.get("shared_with_feature_ids") or [],
            road_frontage_classification=data.get("road_frontage_classification"),
            source_line_references=data.get("source_line_references") or [],
            geometry_valid=data.get("geometry_valid", True),
            provenance=data.get("provenance") or {},
        )


@dataclass
class CanonicalPlot:
    id: str
    colony_id: str
    dataset_version: int
    original_number: str  # Original printed plot number preserved exactly
    normalized_number: Optional[str]  # Normalized plot number, only if unambiguous
    geometry: Dict[str, Any]  # Active GeoJSON Polygon/MultiPolygon
    original_geometry: Optional[Dict[str, Any]] = None  # Unmodified geometry before repair/transform
    crs_metadata: CoordinateSystemMetadata = field(default_factory=CoordinateSystemMetadata)
    
    # Source-declared measurements (explicitly printed or associated via dimensions)
    frontage_declared: Optional[float] = None
    depth_declared: Optional[float] = None
    side_declared: Dict[str, float] = field(default_factory=dict)
    area_declared: Optional[float] = None
    declared_units: Optional[str] = None

    # Geometry-derived measurements (calculated strictly from spatial geometry)
    frontage_derived: Optional[float] = None
    depth_derived: Optional[float] = None
    side_derived: Dict[str, float] = field(default_factory=dict)
    area_derived: Optional[float] = None

    # Topological relationships
    adjacent_road_ids: List[str] = field(default_factory=list)
    neighboring_plot_ids: List[str] = field(default_factory=list)
    edges: List[CanonicalGeometryEdge] = field(default_factory=list)

    # Validation and QA
    geometry_valid: bool = True
    semantic_validation_status: str = "review_required"
    confidence_signals: Dict[str, float] = field(default_factory=dict)
    unresolved_warnings: List[str] = field(default_factory=list)

    # Document and pipeline provenance
    source_document_id: Optional[str] = None
    source_page: int = 1
    provenance: Dict[str, Any] = field(default_factory=dict)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "colony_id": self.colony_id,
            "dataset_version": self.dataset_version,
            "number": self.normalized_number or self.original_number,
            "original_number": self.original_number,
            "normalized_number": self.normalized_number,
            "geometry": self.geometry,
            "original_geometry": self.original_geometry,
            "crs_metadata": self.crs_metadata.to_dict(),
            "frontage_declared": self.frontage_declared,
            "depth_declared": self.depth_declared,
            "side_declared": self.side_declared,
            "area_declared": self.area_declared,
            "declared_units": self.declared_units,
            "frontage_derived": self.frontage_derived,
            "depth_derived": self.depth_derived,
            "side_derived": self.side_derived,
            "area_derived": self.area_derived,
            "area_sqm": self.area_declared or self.area_derived,
            "status": "available",
            "adjacent_road_ids": list(self.adjacent_road_ids),
            "neighboring_plot_ids": list(self.neighboring_plot_ids),
            "edges": [e.to_dict() for e in self.edges],
            "geometry_valid": self.geometry_valid,
            "semantic_validation_status": self.semantic_validation_status,
            "confidence_signals": self.confidence_signals,
            "unresolved_warnings": list(self.unresolved_warnings),
            "source_document_id": self.source_document_id,
            "source_page": self.source_page,
            "provenance": self.provenance,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> CanonicalPlot:
        return cls(
            id=data["id"],
            colony_id=data["colony_id"],
            dataset_version=int(data.get("dataset_version", 1)),
            original_number=data.get("original_number") or data.get("number") or "",
            normalized_number=data.get("normalized_number"),
            geometry=data.get("geometry") or {},
            original_geometry=data.get("original_geometry"),
            crs_metadata=CoordinateSystemMetadata.from_dict(data.get("crs_metadata")),
            frontage_declared=data.get("frontage_declared"),
            depth_declared=data.get("depth_declared"),
            side_declared=data.get("side_declared") or {},
            area_declared=data.get("area_declared"),
            declared_units=data.get("declared_units"),
            frontage_derived=data.get("frontage_derived"),
            depth_derived=data.get("depth_derived"),
            side_derived=data.get("side_derived") or {},
            area_derived=data.get("area_derived"),
            adjacent_road_ids=data.get("adjacent_road_ids") or [],
            neighboring_plot_ids=data.get("neighboring_plot_ids") or [],
            edges=[CanonicalGeometryEdge.from_dict(e) for e in (data.get("edges") or [])],
            geometry_valid=data.get("geometry_valid", True),
            semantic_validation_status=data.get("semantic_validation_status", "review_required"),
            confidence_signals=data.get("confidence_signals") or {},
            unresolved_warnings=data.get("unresolved_warnings") or [],
            source_document_id=data.get("source_document_id"),
            source_page=int(data.get("source_page", 1)),
            provenance=data.get("provenance") or {},
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
        )


@dataclass
class CanonicalRoad:
    id: str
    colony_id: str
    dataset_version: int
    source_label: str  # Source label (e.g., "ROAD 30' WIDE", "30 FEET ROAD")
    geometry: Dict[str, Any]  # Corridor geometry (Polygon or LineString)
    original_geometry: Optional[Dict[str, Any]] = None
    crs_metadata: CoordinateSystemMetadata = field(default_factory=CoordinateSystemMetadata)
    declared_width_m: Optional[float] = None
    derived_width_m: Optional[float] = None
    declared_width_raw: Optional[str] = None
    adjacent_plot_ids: List[str] = field(default_factory=list)
    frontage_relationships: List[str] = field(default_factory=list)
    source_evidence: List[str] = field(default_factory=list)
    validation_status: str = "review_required"
    provenance: Dict[str, Any] = field(default_factory=dict)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "colony_id": self.colony_id,
            "dataset_version": self.dataset_version,
            "source_label": self.source_label,
            "geometry": self.geometry,
            "original_geometry": self.original_geometry,
            "crs_metadata": self.crs_metadata.to_dict(),
            "declared_width_m": self.declared_width_m,
            "derived_width_m": self.derived_width_m,
            "declared_width_raw": self.declared_width_raw,
            "adjacent_plot_ids": list(self.adjacent_plot_ids),
            "frontage_relationships": list(self.frontage_relationships),
            "source_evidence": list(self.source_evidence),
            "validation_status": self.validation_status,
            "provenance": self.provenance,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> CanonicalRoad:
        return cls(
            id=data["id"],
            colony_id=data["colony_id"],
            dataset_version=int(data.get("dataset_version", 1)),
            source_label=data.get("source_label") or data.get("name") or "",
            geometry=data.get("geometry") or {},
            original_geometry=data.get("original_geometry"),
            crs_metadata=CoordinateSystemMetadata.from_dict(data.get("crs_metadata")),
            declared_width_m=data.get("declared_width_m"),
            derived_width_m=data.get("derived_width_m"),
            declared_width_raw=data.get("declared_width_raw"),
            adjacent_plot_ids=data.get("adjacent_plot_ids") or [],
            frontage_relationships=data.get("frontage_relationships") or [],
            source_evidence=data.get("source_evidence") or [],
            validation_status=data.get("validation_status", "review_required"),
            provenance=data.get("provenance") or {},
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
        )


@dataclass
class CanonicalDimensionAnnotation:
    id: str
    colony_id: str
    dataset_version: int
    original_text: str  # Raw unedited text e.g. "40'-0\""
    parsed_value: Optional[float]  # 40.0
    original_unit: Optional[str]  # "ft"
    normalized_value_m: Optional[float]  # 12.192
    normalized_unit: Optional[str] = None
    measurement_category: str = "unknown_measurement"  # "plot_frontage", "plot_depth", "road_width"
    dimension_line_id: Optional[str] = None
    extension_line_ids: List[str] = field(default_factory=list)
    candidate_target_edges: List[str] = field(default_factory=list)
    candidate_target_features: List[str] = field(default_factory=list)
    selected_target_id: Optional[str] = None
    selected_target_type: Optional[str] = None  # "edge", "feature"
    association_status: str = "unresolved"  # "verified", "candidate", "review_required", "conflicted", "rejected"
    confidence: float = 0.0
    qa_issues: List[Dict[str, Any]] = field(default_factory=list)
    source_page: int = 1
    evidence: List[str] = field(default_factory=list)
    provenance: Dict[str, Any] = field(default_factory=dict)
    created_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "colony_id": self.colony_id,
            "dataset_version": self.dataset_version,
            "original_text": self.original_text,
            "parsed_value": self.parsed_value,
            "original_unit": self.original_unit,
            "normalized_value_m": self.normalized_value_m,
            "normalized_unit": self.normalized_unit,
            "measurement_category": self.measurement_category,
            "dimension_line_id": self.dimension_line_id,
            "extension_line_ids": list(self.extension_line_ids),
            "candidate_target_edges": list(self.candidate_target_edges),
            "candidate_target_features": list(self.candidate_target_features),
            "selected_target_id": self.selected_target_id,
            "selected_target_type": self.selected_target_type,
            "association_status": self.association_status,
            "confidence": self.confidence,
            "qa_issues": list(self.qa_issues),
            "source_page": self.source_page,
            "evidence": list(self.evidence),
            "provenance": self.provenance,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> CanonicalDimensionAnnotation:
        return cls(
            id=data["id"],
            colony_id=data["colony_id"],
            dataset_version=int(data.get("dataset_version", 1)),
            original_text=data.get("original_text") or "",
            parsed_value=data.get("parsed_value"),
            original_unit=data.get("original_unit"),
            normalized_value_m=data.get("normalized_value_m"),
            normalized_unit=data.get("normalized_unit"),
            measurement_category=data.get("measurement_category", "unknown_measurement"),
            dimension_line_id=data.get("dimension_line_id"),
            extension_line_ids=data.get("extension_line_ids") or [],
            candidate_target_edges=data.get("candidate_target_edges") or [],
            candidate_target_features=data.get("candidate_target_features") or [],
            selected_target_id=data.get("selected_target_id"),
            selected_target_type=data.get("selected_target_type"),
            association_status=data.get("association_status", "unresolved"),
            confidence=float(data.get("confidence", 0.0)),
            qa_issues=data.get("qa_issues") or [],
            source_page=int(data.get("source_page", 1)),
            evidence=data.get("evidence") or [],
            provenance=data.get("provenance") or {},
            created_at=data.get("created_at"),
        )


@dataclass
class CanonicalSemanticRelationship:
    id: str
    colony_id: str
    dataset_version: int
    relationship_type: str  # from CanonicalRelationshipType
    source_entity_id: str
    target_entity_id: str
    source_evidence: List[str] = field(default_factory=list)
    validation_status: str = "review_required"
    confidence: float = 0.0
    properties: Dict[str, Any] = field(default_factory=dict)
    provenance: Dict[str, Any] = field(default_factory=dict)
    created_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "colony_id": self.colony_id,
            "dataset_version": self.dataset_version,
            "relationship_type": self.relationship_type,
            "source_entity_id": self.source_entity_id,
            "target_entity_id": self.target_entity_id,
            "source_evidence": list(self.source_evidence),
            "validation_status": self.validation_status,
            "confidence": self.confidence,
            "properties": self.properties,
            "provenance": self.provenance,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> CanonicalSemanticRelationship:
        return cls(
            id=data["id"],
            colony_id=data["colony_id"],
            dataset_version=int(data.get("dataset_version", 1)),
            relationship_type=data["relationship_type"],
            source_entity_id=data["source_entity_id"],
            target_entity_id=data["target_entity_id"],
            source_evidence=data.get("source_evidence") or [],
            validation_status=data.get("validation_status", "review_required"),
            confidence=float(data.get("confidence", 0.0)),
            properties=data.get("properties") or {},
            provenance=data.get("provenance") or {},
            created_at=data.get("created_at"),
        )


@dataclass
class ProcessingRun:
    run_id: str
    colony_id: str
    source_document_name: str
    source_sha256: str
    source_page_count: int = 1
    pipeline_version: str = "2.0.0"
    config_version: str = "v1"
    status: str = "COMPLETED"  # "STARTED", "COMPLETED", "FAILED", "COMMITTED"
    qa_summary: Dict[str, Any] = field(default_factory=dict)
    quality_grade: str = "A_VERIFIED"
    retry_recovery_history: List[Dict[str, Any]] = field(default_factory=list)
    canonical_dataset_version: int = 1
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "colony_id": self.colony_id,
            "source_document_name": self.source_document_name,
            "source_sha256": self.source_sha256,
            "source_page_count": self.source_page_count,
            "pipeline_version": self.pipeline_version,
            "config_version": self.config_version,
            "status": self.status,
            "qa_summary": self.qa_summary,
            "quality_grade": self.quality_grade,
            "retry_recovery_history": self.retry_recovery_history,
            "canonical_dataset_version": self.canonical_dataset_version,
            "errors": list(self.errors),
            "warnings": list(self.warnings),
            "metadata": self.metadata,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> ProcessingRun:
        return cls(
            run_id=data["run_id"],
            colony_id=data["colony_id"],
            source_document_name=data.get("source_document_name") or "",
            source_sha256=data.get("source_sha256") or "",
            source_page_count=int(data.get("source_page_count", 1)),
            pipeline_version=data.get("pipeline_version", "2.0.0"),
            config_version=data.get("config_version", "v1"),
            status=data.get("status", "COMPLETED"),
            qa_summary=data.get("qa_summary") or {},
            quality_grade=data.get("quality_grade", "A_VERIFIED"),
            retry_recovery_history=data.get("retry_recovery_history") or [],
            canonical_dataset_version=int(data.get("canonical_dataset_version", 1)),
            errors=data.get("errors") or [],
            warnings=data.get("warnings") or [],
            metadata=data.get("metadata") or {},
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
        )


@dataclass
class ReviewCorrection:
    correction_id: str
    colony_id: str
    dataset_version: int
    entity_type: str  # "Plot", "Road", "DimensionAnnotation"
    entity_id: str
    field_name: str
    previous_value: Any
    corrected_value: Any
    reviewer_user_id: str
    timestamp: str
    reason: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "correction_id": self.correction_id,
            "colony_id": self.colony_id,
            "dataset_version": self.dataset_version,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "field_name": self.field_name,
            "previous_value": self.previous_value,
            "corrected_value": self.corrected_value,
            "reviewer_user_id": self.reviewer_user_id,
            "timestamp": self.timestamp,
            "reason": self.reason,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> ReviewCorrection:
        return cls(
            correction_id=data["correction_id"],
            colony_id=data["colony_id"],
            dataset_version=int(data.get("dataset_version", 1)),
            entity_type=data["entity_type"],
            entity_id=data["entity_id"],
            field_name=data["field_name"],
            previous_value=data.get("previous_value"),
            corrected_value=data.get("corrected_value"),
            reviewer_user_id=data.get("reviewer_user_id") or "admin",
            timestamp=data["timestamp"],
            reason=data.get("reason"),
        )


@dataclass
class CanonicalDataset:
    colony_id: str
    version: int
    is_active: bool
    approval_status: str  # "APPROVED", "REVIEW_REQUIRED", "DRAFT", "REJECTED"
    source_sha256: str
    source_filename: str
    processing_run_id: str
    crs_metadata: CoordinateSystemMetadata = field(default_factory=CoordinateSystemMetadata)
    plots_count: int = 0
    roads_count: int = 0
    relationships_count: int = 0
    dimensions_count: int = 0
    qa_quality_grade: str = "C_REVIEW_NEEDED"
    qa_findings_summary: Dict[str, int] = field(default_factory=dict)
    summary: Dict[str, Any] = field(default_factory=dict)
    created_at: Optional[str] = None
    created_by: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "colony_id": self.colony_id,
            "version": self.version,
            "is_active": self.is_active,
            "approval_status": self.approval_status,
            "source_sha256": self.source_sha256,
            "source_filename": self.source_filename,
            "processing_run_id": self.processing_run_id,
            "crs_metadata": self.crs_metadata.to_dict(),
            "plots_count": self.plots_count,
            "roads_count": self.roads_count,
            "relationships_count": self.relationships_count,
            "dimensions_count": self.dimensions_count,
            "qa_quality_grade": self.qa_quality_grade,
            "qa_findings_summary": self.qa_findings_summary,
            "summary": self.summary,
            "created_at": self.created_at,
            "created_by": self.created_by,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> CanonicalDataset:
        return cls(
            colony_id=data["colony_id"],
            version=int(data.get("version", 1)),
            is_active=bool(data.get("is_active", False)),
            approval_status=data.get("approval_status", "APPROVED"),
            source_sha256=data.get("source_sha256") or "",
            source_filename=data.get("source_filename") or "",
            processing_run_id=data.get("processing_run_id") or "",
            crs_metadata=CoordinateSystemMetadata.from_dict(data.get("crs_metadata")),
            plots_count=int(data.get("plots_count", 0)),
            roads_count=int(data.get("roads_count", 0)),
            relationships_count=int(data.get("relationships_count", 0)),
            dimensions_count=int(data.get("dimensions_count", 0)),
            qa_quality_grade=data.get("qa_quality_grade", "C_REVIEW_NEEDED"),
            qa_findings_summary=data.get("qa_findings_summary") or {},
            summary=data.get("summary") or {},
            created_at=data.get("created_at"),
            created_by=data.get("created_by"),
        )
