"""Comprehensive Test Suite for Spatial Understanding and Measurement Association.

Tests all 15 mandatory scenarios specified in Section 10:
1. Plot number inside a polygon
2. Plot number outside its polygon
3. Two neighboring plots with close labels
4. Dimension line spanning one plot
5. Dimension line spanning multiple plots
6. Road width annotation
7. Dimension line crossing unrelated geometry
8. Irregular and corner plots
9. Imperial and metric units
10. Ambiguous feet-inch notation
11. Area label versus length label
12. Dimension conflicting with polygon-derived measurements
13. Missing arrowheads or extension lines
14. Low-resolution OCR
15. VLM and OCR disagreement
"""

import math
import pytest
from shapely.geometry import box, LineString, Point, Polygon

from app.gis.spatial_understanding.engine import SpatialUnderstandingEngine
from app.gis.spatial_understanding.models import (
    CanonicalRelationship,
    EntityType,
    MeasurementType,
    RelationshipType,
    ValidationStatus,
)
from app.gis.spatial_understanding.unit_parser import (
    parse_measurement_text,
    ParsedMeasurement,
)


@pytest.fixture
def engine():
    return SpatialUnderstandingEngine()


# -----------------------------------------------------------------------------
# Scenario 1: Plot number inside a polygon
# -----------------------------------------------------------------------------
def test_scenario_1_plot_number_inside_polygon(engine):
    plots = [
        {"id": "plot_1", "geometry": box(10, 10, 30, 30)},
    ]
    texts = [
        {"id": "text_1", "text": "P-1", "geometry": Point(20, 20), "source": "native_pdf"},
    ]
    graph = engine.process_drawing(plots=plots, text_elements=texts)

    rels = graph.find_relationships(rel_type=RelationshipType.LABEL_BELONGS_TO_FEATURE)
    assert len(rels) == 1
    rel = rels[0]
    assert rel.source_entity_id == "text_1"
    assert rel.target_entity_id == "plot_1"
    assert rel.validation_status == ValidationStatus.VERIFIED
    assert "point_in_polygon_containment" in rel.evidence
    assert rel.confidence_signals.label_to_feature >= 0.7


# -----------------------------------------------------------------------------
# Scenario 2: Plot number outside its polygon
# -----------------------------------------------------------------------------
def test_scenario_2_plot_number_outside_polygon(engine):
    plots = [
        {"id": "plot_2", "geometry": box(10, 10, 30, 30)},
    ]
    # Label placed at (8, 20), outside the polygon boundary
    texts = [
        {"id": "text_2", "text": "P-2", "geometry": Point(8, 20), "source": "native_pdf"},
    ]
    graph = engine.process_drawing(plots=plots, text_elements=texts)

    rels = graph.find_relationships(rel_type=RelationshipType.LABEL_BELONGS_TO_FEATURE)
    assert len(rels) == 1
    rel = rels[0]
    # Must NOT force a verified decision when outside!
    assert rel.validation_status == ValidationStatus.REVIEW_REQUIRED
    assert "label_outside_polygon" in rel.evidence
    # QA issue must be generated
    qa_types = [issue.issue_type for issue in graph.qa_issues]
    assert "label_outside_polygon" in qa_types


# -----------------------------------------------------------------------------
# Scenario 3: Two neighboring plots with close labels
# -----------------------------------------------------------------------------
def test_scenario_3_two_neighboring_plots_close_labels(engine):
    # Two plots sharing boundary at x = 20
    plots = [
        {"id": "plot_A", "geometry": box(0, 0, 20, 20)},
        {"id": "plot_B", "geometry": box(20, 0, 40, 20)},
    ]
    # Text on dividing border line (ambiguous position)
    texts = [
        {
            "id": "text_ambig",
            "text": "P-5",
            "geometry": Point(20.05, 10.0),
            "bbox": [19.0, 9.0, 21.1, 11.0],
            "source": "native_pdf",
        },
    ]
    graph = engine.process_drawing(plots=plots, text_elements=texts)

    rels = graph.find_relationships(rel_type=RelationshipType.LABEL_BELONGS_TO_FEATURE)
    assert len(rels) == 1
    rel = rels[0]
    # When overlapping or close between two plots, candidates are preserved and marked review_required
    assert rel.validation_status == ValidationStatus.REVIEW_REQUIRED
    assert len(rel.candidate_alternatives) >= 2
    cand_ids = [c["plot_id"] for c in rel.candidate_alternatives]
    assert "plot_A" in cand_ids and "plot_B" in cand_ids


# -----------------------------------------------------------------------------
# Scenario 4: Dimension line spanning one plot
# -----------------------------------------------------------------------------
def test_scenario_4_dimension_spanning_one_plot(engine):
    # Plot from x=0 to x=30, y=0 to y=40 bordering road along y=0
    roads = [
        {"id": "road_main", "geometry": box(-10, -10, 50, 0), "name": "9M WIDE ROAD"},
    ]
    plots = [
        {"id": "plot_single", "geometry": box(0, 0, 30, 40)},
    ]
    # Dimension line measuring frontage (length = 30)
    lines = [
        {
            "id": "dim_line_1",
            "geometry": LineString([(0, -2), (30, -2)]),
            "kind": "dim_line",
        },
        {
            "id": "ext_line_1",
            "geometry": LineString([(0, -2), (0, 0)]),
            "kind": "ext_line",
        },
        {
            "id": "ext_line_2",
            "geometry": LineString([(30, -2), (30, 0)]),
            "kind": "ext_line",
        },
        {
            "id": "arrow_1",
            "geometry": Point(0, -2),
            "kind": "arrowhead",
        },
        {
            "id": "arrow_2",
            "geometry": Point(30, -2),
            "kind": "arrowhead",
        },
    ]
    dim_annotations = [
        {
            "id": "dim_ann_1",
            "raw_text": "30'-0\"",
            "geometry": Point(15, -2),
            "dimension_line_id": "dim_line_1",
        },
    ]

    graph = engine.process_drawing(
        plots=plots,
        roads=roads,
        lines=lines,
        dimension_annotations=dim_annotations,
    )

    canonical_list = graph.canonical_relationships
    assert len(canonical_list) == 1
    cr = canonical_list[0]
    assert cr.raw_text == "30'-0\""
    assert cr.parsed_value == 30.0
    assert cr.unit == "ft"
    assert cr.measurement_type == MeasurementType.PLOT_FRONTAGE.value
    assert cr.association_status == ValidationStatus.VERIFIED.value
    assert "plot_single" in cr.candidate_target_features
    assert "dimension_line_alignment" in cr.evidence


# -----------------------------------------------------------------------------
# Scenario 5: Dimension line spanning multiple plots
# -----------------------------------------------------------------------------
def test_scenario_5_dimension_spanning_multiple_plots(engine):
    # 3 plots along the road: Plot 1 (0 to 20), Plot 2 (20 to 40), Plot 3 (40 to 60)
    roads = [
        {"id": "road_1", "geometry": box(-10, -10, 70, 0)},
    ]
    plots = [
        {"id": "plot_1", "geometry": box(0, 0, 20, 30)},
        {"id": "plot_2", "geometry": box(20, 0, 40, 30)},
        {"id": "plot_3", "geometry": box(40, 0, 60, 30)},
    ]
    # Combined block dimension of 60m across all 3 plots
    lines = [
        {
            "id": "block_dim_line",
            "geometry": LineString([(0, -3), (60, -3)]),
            "kind": "dim_line",
        },
    ]
    dim_annotations = [
        {
            "id": "dim_block",
            "raw_text": "60.00 MTR",
            "geometry": Point(30, -3),
            "dimension_line_id": "block_dim_line",
        },
    ]

    graph = engine.process_drawing(
        plots=plots,
        roads=roads,
        lines=lines,
        dimension_annotations=dim_annotations,
    )

    cr = graph.canonical_relationships[0]
    assert cr.measurement_type == MeasurementType.BLOCK_LENGTH.value
    # Must NOT be assigned to just one plot!
    assert len(cr.candidate_target_features) == 3
    assert set(cr.candidate_target_features) == {"plot_1", "plot_2", "plot_3"}
    assert cr.association_status == ValidationStatus.VERIFIED.value
    assert "multi_plot_span" in cr.evidence


# -----------------------------------------------------------------------------
# Scenario 6: Road width annotation
# -----------------------------------------------------------------------------
def test_scenario_6_road_width_annotation(engine):
    roads = [
        {"id": "road_spine", "geometry": box(-50, -4.5, 50, 4.5), "name": "9 MT. WIDE ROAD"},
    ]
    plots = [
        {"id": "plot_side", "geometry": box(0, 4.5, 20, 25)},
    ]
    dim_annotations = [
        {
            "id": "dim_road",
            "raw_text": "9 MT. WIDE ROAD",
            "geometry": Point(0, 0),
        },
    ]

    graph = engine.process_drawing(
        plots=plots,
        roads=roads,
        dimension_annotations=dim_annotations,
    )

    cr = graph.canonical_relationships[0]
    assert cr.measurement_type == MeasurementType.ROAD_WIDTH.value
    assert cr.parsed_value == 9.0
    assert cr.unit == "m"
    assert "road_spine" in cr.candidate_target_features
    assert cr.association_status == ValidationStatus.VERIFIED.value


# -----------------------------------------------------------------------------
# Scenario 7: Dimension line crossing unrelated geometry
# -----------------------------------------------------------------------------
def test_scenario_7_dimension_crossing_unrelated_geometry(engine):
    plots = [
        {"id": "plot_victim", "geometry": box(10, 10, 30, 30)},
    ]
    # Dimension line slashes diagonally through the plot without matching any edge
    lines = [
        {
            "id": "dim_cross",
            "geometry": LineString([(5, 5), (35, 35)]),
            "kind": "dim_line",
        },
    ]
    dim_annotations = [
        {
            "id": "dim_bad",
            "raw_text": "42.4 m",
            "geometry": Point(20, 20),
            "dimension_line_id": "dim_cross",
        },
    ]

    graph = engine.process_drawing(
        plots=plots,
        lines=lines,
        dimension_annotations=dim_annotations,
    )

    cr = graph.canonical_relationships[0]
    assert cr.association_status == ValidationStatus.CONFLICTED.value
    qa_types = [issue["issue_type"] for issue in cr.qa_issues]
    assert "dimension_crosses_unrelated_geometry" in qa_types


# -----------------------------------------------------------------------------
# Scenario 8: Irregular and corner plots
# -----------------------------------------------------------------------------
def test_scenario_8_irregular_and_corner_plots(engine):
    # Corner plot bordering roads on south and west
    roads = [
        {"id": "road_south", "geometry": box(-10, -5, 40, 0), "name": "South Road"},
        {"id": "road_west", "geometry": box(-5, -5, 0, 40), "name": "West Road"},
    ]
    # Irregular 5-sided polygon corner plot
    pentagon = Polygon([(0, 0), (20, 0), (25, 15), (10, 25), (0, 20)])
    plots = [
        {"id": "corner_plot", "geometry": pentagon},
    ]

    graph = engine.process_drawing(plots=plots, roads=roads)

    plot_ent = graph.get_entity("corner_plot")
    assert plot_ent.properties.get("is_corner_plot") is True

    # Check edges created for all 5 sides
    edges = [e for e in graph.entities.values() if e.properties.get("parent_feature_id") == "corner_plot"]
    assert len(edges) == 5

    # Should have multiple road frontages
    frontage_edges = [e for e in edges if e.properties.get("is_road_frontage")]
    assert len(frontage_edges) >= 2


# -----------------------------------------------------------------------------
# Scenario 9: Imperial and metric units
# -----------------------------------------------------------------------------
def test_scenario_9_imperial_and_metric_units():
    # Metric variations
    m1 = parse_measurement_text("12.5 m")
    assert m1.parsed_value == 12.5 and m1.unit == "m"

    m2 = parse_measurement_text("12.50 MT.")
    assert m2.parsed_value == 12.5 and m2.unit == "m"

    m3 = parse_measurement_text("1250 cm")
    assert m3.parsed_value == 12.5 and m3.unit == "m"

    m4 = parse_measurement_text("12000 mm")
    assert m4.parsed_value == 12.0 and m4.unit == "m"

    # Imperial variations
    imp1 = parse_measurement_text("30'-0\"")
    assert imp1.parsed_value == 30.0 and imp1.unit == "ft"

    imp2 = parse_measurement_text("30' 6\"")
    assert imp2.parsed_value == 30.5 and imp2.unit == "ft"

    imp3 = parse_measurement_text("30'-6 1/2\"")
    assert abs(imp3.parsed_value - 30.5417) < 0.001 and imp3.unit == "ft"

    imp4 = parse_measurement_text("30.5'")
    assert imp4.parsed_value == 30.5 and imp4.unit == "ft"

    imp5 = parse_measurement_text("36\"")
    assert imp5.parsed_value == 3.0 and imp5.unit == "ft"


# -----------------------------------------------------------------------------
# Scenario 10: Ambiguous feet-inch notation
# -----------------------------------------------------------------------------
def test_scenario_10_ambiguous_notation(engine):
    # Bare number without unit: e.g. "30"
    bare = parse_measurement_text("30")
    assert bare.parsed_value == 30.0
    assert bare.unit is None
    assert bare.unit_uncertain is True

    # Architectural hyphen without tick e.g. "30-6"
    arch = parse_measurement_text("30-6")
    assert arch.parsed_value == 30.5
    assert arch.unit == "ft"

    # In engine pipeline, bare number generates QA issue
    plots = [{"id": "plot_x", "geometry": box(0, 0, 30, 40)}]
    dim_annotations = [{"id": "dim_bare", "raw_text": "30", "geometry": Point(15, 0)}]
    graph = engine.process_drawing(plots=plots, dimension_annotations=dim_annotations)
    cr = graph.canonical_relationships[0]
    qa_types = [q["issue_type"] for q in cr.qa_issues]
    assert "uncertain_dimension_unit" in qa_types


# -----------------------------------------------------------------------------
# Scenario 11: Area label versus length label
# -----------------------------------------------------------------------------
def test_scenario_11_area_label_vs_length_label(engine):
    # Area label: "150 SQ. YDS" inside plot
    area_meas = parse_measurement_text("150 SQ. YDS")
    assert area_meas.is_area is True
    assert area_meas.parsed_value == 150.0
    assert area_meas.unit == "sqyd"
    assert area_meas.measurement_type == MeasurementType.AREA

    # Plot ID: "Plot 42" must NOT be parsed as measurement
    plot_label = parse_measurement_text("Plot 42")
    assert plot_label.is_plot_label is True
    assert plot_label.is_valid_measurement is False

    # In drawing engine:
    plots = [{"id": "plot_area_test", "geometry": box(0, 0, 20, 20)}]
    dim_annotations = [
        {"id": "dim_sqyd", "raw_text": "150 SQ. YDS", "geometry": Point(10, 10)},
    ]
    graph = engine.process_drawing(plots=plots, dimension_annotations=dim_annotations)
    cr = graph.canonical_relationships[0]
    assert cr.measurement_type == MeasurementType.AREA.value
    assert cr.association_status == ValidationStatus.VERIFIED.value
    target_plot = graph.get_entity("plot_area_test")
    assert target_plot.properties.get("recorded_area") == 150.0
    assert target_plot.properties.get("recorded_area_unit") == "sqyd"


# -----------------------------------------------------------------------------
# Scenario 12: Dimension conflicting with polygon-derived measurements
# -----------------------------------------------------------------------------
def test_scenario_12_dimension_conflicting_with_polygon(engine):
    # Edge length in drawing is 20 units
    plots = [{"id": "plot_scaled", "geometry": box(0, 0, 20, 30)}]
    lines = [
        {"id": "dim_line_mismatch", "geometry": LineString([(0, 0), (20, 0)]), "kind": "dim_line"},
    ]
    # Text annotation says 50m (massive mismatch at scale 1.0)
    dim_annotations = [
        {
            "id": "dim_mismatch",
            "raw_text": "50.0m",
            "geometry": Point(10, 0),
            "dimension_line_id": "dim_line_mismatch",
        },
    ]

    graph = engine.process_drawing(
        plots=plots,
        lines=lines,
        dimension_annotations=dim_annotations,
        scale_ratio=1.0,
    )

    cr = graph.canonical_relationships[0]
    assert cr.association_status == ValidationStatus.REVIEW_REQUIRED.value
    qa_types = [q["issue_type"] for q in cr.qa_issues]
    assert "dimension_scale_mismatch" in qa_types


# -----------------------------------------------------------------------------
# Scenario 13: Missing arrowheads or extension lines
# -----------------------------------------------------------------------------
def test_scenario_13_missing_arrowheads_or_extension_lines(engine):
    plots = [{"id": "plot_flat", "geometry": box(0, 0, 25, 30)}]
    # Only dimension line, no arrowheads or extension lines
    lines = [
        {"id": "dim_line_naked", "geometry": LineString([(0, -1), (25, -1)]), "kind": "dim_line"},
    ]
    dim_annotations = [
        {
            "id": "dim_naked",
            "raw_text": "25.0m",
            "geometry": Point(12.5, -1),
            "dimension_line_id": "dim_line_naked",
        },
    ]

    graph = engine.process_drawing(
        plots=plots,
        lines=lines,
        dimension_annotations=dim_annotations,
    )

    cr = graph.canonical_relationships[0]
    # Evidence must flag missing arrowheads/extensions but still match candidate
    assert "missing_arrowheads" in cr.evidence
    assert "missing_extension_lines" in cr.evidence
    assert "plot_flat" in cr.candidate_target_features


# -----------------------------------------------------------------------------
# Scenario 14: Low-resolution OCR
# -----------------------------------------------------------------------------
def test_scenario_14_low_resolution_ocr(engine):
    plots = [{"id": "plot_ocr", "geometry": box(10, 10, 30, 30)}]
    texts = [
        {
            "id": "ocr_text_low",
            "text": "P-9",
            "geometry": Point(20, 20),
            "source": "ocr_low",
            "confidence": 0.55,
        },
    ]

    graph = engine.process_drawing(plots=plots, text_elements=texts)
    rels = graph.find_relationships(rel_type=RelationshipType.LABEL_BELONGS_TO_FEATURE)
    assert len(rels) == 1
    rel = rels[0]
    # Low confidence OCR reflects in confidence signals and validation status
    assert rel.confidence_signals.text_recognition == 0.55
    assert rel.confidence_signals.aggregate < 0.90


# -----------------------------------------------------------------------------
# Scenario 15: VLM and OCR disagreement
# -----------------------------------------------------------------------------
def test_scenario_15_vlm_ocr_disagreement(engine):
    plots = [
        {"id": "plot_1", "geometry": box(0, 0, 20, 20)},
        {"id": "plot_2", "geometry": box(20, 0, 40, 20)},
    ]
    # OCR detected label 'P-1' inside plot_1
    texts = [
        {"id": "text_label_1", "text": "P-1", "geometry": Point(10, 10), "source": "ocr_high"},
    ]
    # VLM hallucinated/suggested that text_label_1 belongs to plot_2!
    vlm_proposals = [
        {
            "proposal_type": "label_association",
            "source_id": "text_label_1",
            "target_id": "plot_2",
            "confidence": 0.85,
        },
    ]

    graph = engine.process_drawing(
        plots=plots,
        text_elements=texts,
        vlm_proposals=vlm_proposals,
    )

    # VLM cannot self-approve; contradiction is preserved and status set to review_required!
    rels = graph.find_relationships(rel_type=RelationshipType.LABEL_BELONGS_TO_FEATURE)
    rel = rels[0]
    assert rel.target_entity_id == "plot_1"  # Geometric truth maintained
    assert rel.validation_status == ValidationStatus.REVIEW_REQUIRED
    assert "vlm_conflict_flagged" in rel.evidence

    qa_types = [issue.issue_type for issue in graph.qa_issues]
    assert "vlm_ocr_disagreement" in qa_types


# -----------------------------------------------------------------------------
# Semantic Questions Query API Verification
# -----------------------------------------------------------------------------
def test_semantic_questions_answers(engine):
    roads = [{"id": "road_1", "geometry": box(-10, -5, 50, 0), "name": "Main Road"}]
    plots = [
        {"id": "plot_1", "geometry": box(0, 0, 20, 20)},
        {"id": "plot_2", "geometry": box(20, 0, 40, 20)},
    ]
    texts = [{"id": "t1", "text": "Plot 1", "geometry": Point(10, 10)}]

    graph = engine.process_drawing(plots=plots, roads=roads, text_elements=texts)
    answers = engine.answer_semantic_questions(graph)

    assert "Plot 1" in answers["plot_label_associations"]
    assert len(answers["shared_boundaries"]) == 1
    assert "road_1" in answers["road_adjacent_plots"]
