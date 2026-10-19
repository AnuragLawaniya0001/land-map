"""Semantic Drawing Model: Entities, Relationships, and Canonical Schema.

Defines the core data structures for spatial understanding and measurement association
in colony engineering drawings, preserving evidence, candidate alternatives, confidence
signals, and validation states.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple, Union


class EntityType(str, Enum):
    DOCUMENT_PAGE = "DocumentPage"
    DRAWING_REGION = "DrawingRegion"
    PLOT = "Plot"
    ROAD = "Road"
    PARK = "Park"
    OPEN_SPACE = "OpenSpace"
    BOUNDARY = "Boundary"
    EDGE = "Edge"
    JUNCTION = "Junction"
    TEXT_LABEL = "TextLabel"
    DIMENSION_ANNOTATION = "DimensionAnnotation"
    DIMENSION_LINE = "DimensionLine"
    EXTENSION_LINE = "ExtensionLine"
    ARROWHEAD = "Arrowhead"
    LEGEND_ENTRY = "LegendEntry"
    SYMBOL = "Symbol"
    UNKNOWN_FEATURE = "UnknownFeature"


class RelationshipType(str, Enum):
    LABEL_BELONGS_TO_FEATURE = "label_belongs_to_feature"
    DIMENSION_MEASURES_EDGE = "dimension_measures_edge"
    DIMENSION_MEASURES_FEATURE = "dimension_measures_feature"
    EDGE_BELONGS_TO_POLYGON = "edge_belongs_to_polygon"
    PLOT_ADJACENT_TO_PLOT = "plot_adjacent_to_plot"
    PLOT_ADJACENT_TO_ROAD = "plot_adjacent_to_road"
    FEATURE_INSIDE_BOUNDARY = "feature_inside_boundary"
    FEATURE_PART_OF_BLOCK = "feature_part_of_block"
    TEXT_EXPLAINS_FEATURE = "text_explains_feature"
    ANNOTATION_APPLIES_TO_MULTIPLE_FEATURES = "annotation_applies_to_multiple_features"
    ENTITY_CONFLICTS_WITH_ENTITY = "entity_conflicts_with_entity"


class MeasurementType(str, Enum):
    PLOT_FRONTAGE = "plot_frontage"
    PLOT_DEPTH = "plot_depth"
    PLOT_SIDE_LENGTH = "plot_side_length"
    ROAD_WIDTH = "road_width"
    BOUNDARY_LENGTH = "boundary_length"
    BLOCK_LENGTH = "block_length"
    OVERALL_SITE_DIMENSION = "overall_site_dimension"
    AREA = "area"
    RADIUS = "radius"
    ANGLE = "angle"
    SETBACK = "setback"
    UNKNOWN_MEASUREMENT = "unknown_measurement"


class ValidationStatus(str, Enum):
    VERIFIED = "verified"
    CANDIDATE = "candidate"
    REVIEW_REQUIRED = "review_required"
    CONFLICTED = "conflicted"
    REJECTED = "rejected"
    UNRESOLVED = "unresolved"


class AdjacencyType(str, Enum):
    SHARED_BOUNDARY = "shared_boundary"
    PROXIMITY = "proximity"
    UNCERTAIN_INFERENCE = "uncertain_inference"


class TextSource(str, Enum):
    NATIVE_PDF = "native_pdf"
    CAD_TEXT = "cad_text"
    OCR_HIGH = "ocr_high"
    OCR_LOW = "ocr_low"
    VLM = "vlm"
    USER_INPUT = "user_input"


@dataclass
class ConfidenceSignals:
    text_recognition: float = 1.0
    entity_classification: float = 1.0
    label_to_feature: float = 1.0
    dimension_to_edge: float = 1.0
    geometry_validity: float = 1.0
    geographic_alignment: float = 1.0

    def to_dict(self) -> Dict[str, float]:
        return {
            "text_recognition": round(self.text_recognition, 3),
            "entity_classification": round(self.entity_classification, 3),
            "label_to_feature": round(self.label_to_feature, 3),
            "dimension_to_edge": round(self.dimension_to_edge, 3),
            "geometry_validity": round(self.geometry_validity, 3),
            "geographic_alignment": round(self.geographic_alignment, 3),
        }

    @property
    def aggregate(self) -> float:
        """Geometric-like balanced score."""
        scores = [
            self.text_recognition,
            self.entity_classification,
            self.label_to_feature,
            self.dimension_to_edge,
            self.geometry_validity,
            self.geographic_alignment,
        ]
        return round(sum(scores) / len(scores), 3)


@dataclass
class QAIssue:
    issue_id: str
    issue_type: str
    severity: str  # "info", "low", "medium", "high", "critical"
    message: str
    entity_ids: List[str] = field(default_factory=list)
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "issue_id": self.issue_id,
            "issue_type": self.issue_type,
            "severity": self.severity,
            "message": self.message,
            "entity_ids": self.entity_ids,
            "details": self.details,
        }


@dataclass
class CanonicalRelationship:
    """Canonical relationship schema exactly matching Requirement Section 9."""
    entity_id: str
    entity_type: str
    raw_text: str
    parsed_value: Optional[float]
    unit: Optional[str]
    measurement_type: str
    source_page: int = 1
    dimension_line_id: Optional[str] = None
    candidate_target_edges: List[str] = field(default_factory=list)
    candidate_target_features: List[str] = field(default_factory=list)
    association_status: str = ValidationStatus.UNRESOLVED.value
    evidence: List[str] = field(default_factory=list)
    qa_issues: List[Dict[str, Any]] = field(default_factory=list)
    confidence_signals: Optional[Dict[str, float]] = None
    candidate_alternatives: List[Dict[str, Any]] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        res = {
            "entity_id": self.entity_id,
            "entity_type": self.entity_type,
            "raw_text": self.raw_text,
            "parsed_value": self.parsed_value,
            "unit": self.unit,
            "measurement_type": self.measurement_type,
            "source_page": self.source_page,
            "dimension_line_id": self.dimension_line_id,
            "candidate_target_edges": list(self.candidate_target_edges),
            "candidate_target_features": list(self.candidate_target_features),
            "association_status": self.association_status,
            "evidence": list(self.evidence),
            "qa_issues": list(self.qa_issues),
        }
        if self.confidence_signals:
            res["confidence_signals"] = self.confidence_signals
        if self.candidate_alternatives:
            res["candidate_alternatives"] = self.candidate_alternatives
        if self.metadata:
            res["metadata"] = self.metadata
        return res


@dataclass
class Entity:
    entity_id: str
    entity_type: EntityType
    geometry: Any  # Shapely geometry or GeoJSON-like dict or bbox
    properties: Dict[str, Any] = field(default_factory=dict)
    source_page: int = 1
    confidence: float = 1.0
    validation_status: ValidationStatus = ValidationStatus.CANDIDATE

    def to_dict(self) -> Dict[str, Any]:
        geom = None
        if hasattr(self.geometry, "__geo_interface__"):
            geom = self.geometry.__geo_interface__
        elif isinstance(self.geometry, dict):
            geom = self.geometry
        return {
            "entity_id": self.entity_id,
            "entity_type": self.entity_type.value,
            "geometry": geom,
            "properties": self.properties,
            "source_page": self.source_page,
            "confidence": self.confidence,
            "validation_status": self.validation_status.value,
        }


@dataclass
class Relationship:
    relationship_id: str
    relationship_type: RelationshipType
    source_entity_id: str
    target_entity_id: str
    validation_status: ValidationStatus = ValidationStatus.CANDIDATE
    confidence_signals: ConfidenceSignals = field(default_factory=ConfidenceSignals)
    evidence: List[str] = field(default_factory=list)
    candidate_alternatives: List[Dict[str, Any]] = field(default_factory=list)
    properties: Dict[str, Any] = field(default_factory=dict)
    qa_issues: List[QAIssue] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "relationship_id": self.relationship_id,
            "relationship_type": self.relationship_type.value,
            "source_entity_id": self.source_entity_id,
            "target_entity_id": self.target_entity_id,
            "validation_status": self.validation_status.value,
            "confidence_signals": self.confidence_signals.to_dict(),
            "evidence": list(self.evidence),
            "candidate_alternatives": list(self.candidate_alternatives),
            "properties": self.properties,
            "qa_issues": [issue.to_dict() for issue in self.qa_issues],
        }


@dataclass
class SemanticDrawingGraph:
    """Graph of entities and relationships representing the drawing understanding model."""
    entities: Dict[str, Entity] = field(default_factory=dict)
    relationships: Dict[str, Relationship] = field(default_factory=dict)
    canonical_relationships: List[CanonicalRelationship] = field(default_factory=list)
    qa_issues: List[QAIssue] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def add_entity(self, entity: Entity) -> None:
        self.entities[entity.entity_id] = entity

    def get_entity(self, entity_id: str) -> Optional[Entity]:
        return self.entities.get(entity_id)

    def add_relationship(self, relationship: Relationship) -> None:
        self.relationships[relationship.relationship_id] = relationship

    def add_qa_issue(self, issue: QAIssue) -> None:
        self.qa_issues.append(issue)

    def find_relationships(
        self,
        rel_type: Optional[RelationshipType] = None,
        source_id: Optional[str] = None,
        target_id: Optional[str] = None,
    ) -> List[Relationship]:
        results = []
        for rel in self.relationships.values():
            if rel_type and rel.relationship_type != rel_type:
                continue
            if source_id and rel.source_entity_id != source_id:
                continue
            if target_id and rel.target_entity_id != target_id:
                continue
            results.append(rel)
        return results

    def to_dict(self) -> Dict[str, Any]:
        return {
            "entity_count": len(self.entities),
            "relationship_count": len(self.relationships),
            "canonical_relationship_count": len(self.canonical_relationships),
            "qa_issue_count": len(self.qa_issues),
            "entities": {eid: e.to_dict() for eid, e in self.entities.items()},
            "relationships": [r.to_dict() for r in self.relationships.values()],
            "canonical_relationships": [cr.to_dict() for cr in self.canonical_relationships],
            "qa_issues": [issue.to_dict() for issue in self.qa_issues],
            "metadata": self.metadata,
        }
