"""Tests for Multi-Model Evidence Fusion Engine and Schema."""

import pytest
from shapely.geometry import Polygon, mapping

from app.gis.ai_models.models import (
    DetectionBoxProposal,
    OCRTextDetection,
    SegmentationMaskProposal,
    VLMInterpretationResult,
)
from app.gis.evidence.fusion import MultiModelEvidenceFusionEngine
from app.gis.evidence.schema import EvidenceSourceType, UnifiedEvidenceCollection
from app.gis.ingestion.native_extractor import (
    ExtractedTextSpan,
    ExtractedVectorPath,
    PageExtractionResult,
)


@pytest.fixture
def mock_extraction():
    poly = Polygon([(100, 100), (200, 100), (200, 200), (100, 200), (100, 100)])
    return PageExtractionResult(
        page_number=1,
        width_points=500.0,
        height_points=500.0,
        text_spans=[
            ExtractedTextSpan(
                evidence_id="ev_txt_p1_1",
                page_number=1,
                text="Plot 55",
                bbox_points=[120.0, 130.0, 180.0, 150.0],
                font_name="Helvetica",
                font_size=12.0,
                font_flags=0,
                color_rgb=(0, 0, 0),
                orientation_deg=0.0,
                origin_point=(120.0, 145.0),
            )
        ],
        vector_paths=[
            ExtractedVectorPath(
                evidence_id="ev_vec_p1_1",
                page_number=1,
                path_type="rect",
                points=[(100, 100), (200, 100), (200, 200), (100, 200), (100, 100)],
                is_closed=True,
                stroke_color=(0, 0, 0),
                stroke_width=1.5,
                fill_color=None,
                geometry=mapping(poly),
            )
        ],
    )


def test_evidence_fusion_flow(mock_extraction):
    engine = MultiModelEvidenceFusionEngine()

    poly = Polygon([(100, 100), (200, 100), (200, 200), (100, 200), (100, 100)])
    base_polygons = [
        {"id": "plot_cand_1", "type": "plot", "geometry": mapping(poly)}
    ]

    ocr_items = [
        OCRTextDetection(
            text="Plot 55",
            confidence=0.96,
            bbox_pixel=[250, 270, 375, 312],
            bbox_page_pt=[120.0, 130.0, 180.0, 150.0],
            polygon_points=[[120, 130], [180, 130], [180, 150], [120, 150]],
            orientation_deg=0.0,
            model_name="PaddleOCR_PP-OCRv5",
        )
    ]

    segformer_items = [
        SegmentationMaskProposal(
            proposal_id="seg_1",
            category="building_plot",
            confidence=0.88,
            bbox_page_pt=[100, 100, 200, 200],
            polygon_geojson=mapping(poly),
            model_name="SegFormer",
        )
    ]

    mask2former_items = [
        SegmentationMaskProposal(
            proposal_id="m2f_1",
            category="parcel_candidate",
            confidence=0.91,
            bbox_page_pt=[100, 100, 200, 200],
            polygon_geojson=mapping(poly),
            model_name="Mask2Former",
            instance_id=1,
        )
    ]

    sam2_items = []

    dino_items = [
        DetectionBoxProposal(
            category="plot_number",
            label="plot number",
            confidence=0.89,
            bbox_pixel=[250, 270, 375, 312],
            bbox_page_pt=[120, 130, 180, 150],
            model_name="GroundingDINO",
        )
    ]

    vlm_result = VLMInterpretationResult(
        layout_summary="Standard rectangular parcel lot with verified internal number.",
        detected_plot_patterns=["Single plot with regular bounds"],
        ambiguity_explanations=[],
        suggested_classifications=[],
        model_name="Qwen2.5-VL",
    )

    fused = engine.fuse_page_evidence(
        document_id="doc_test_1",
        page_num=1,
        native_extraction=mock_extraction,
        ocr_detections=ocr_items,
        segformer_proposals=segformer_items,
        mask2former_proposals=mask2former_items,
        sam2_refinements=sam2_items,
        dino_detections=dino_items,
        vlm_result=vlm_result,
        base_polygons=base_polygons,
    )

    assert isinstance(fused, UnifiedEvidenceCollection)
    assert len(fused.items) >= 4
    assert len(fused.fused_regions) == 1

    region = fused.fused_regions[0]
    assert region.primary_label == "Plot 55"
    assert region.confidence >= 0.90
    assert region.model_agreements.get("SegFormer") is True
    assert region.model_agreements.get("Mask2Former") is True


def test_fusion_disagreement_detection(mock_extraction):
    engine = MultiModelEvidenceFusionEngine()
    poly = Polygon([(100, 100), (200, 100), (200, 200), (100, 200), (100, 100)])
    base_polygons = [{"id": "plot_cand_1", "type": "plot", "geometry": mapping(poly)}]

    # SegFormer claims this plot is actually a "park"
    segformer_items = [
        SegmentationMaskProposal(
            proposal_id="seg_park_conflict",
            category="park",
            confidence=0.88,
            bbox_page_pt=[100, 100, 200, 200],
            polygon_geojson=mapping(poly),
            model_name="SegFormer",
        )
    ]

    fused = engine.fuse_page_evidence(
        document_id="doc_test_disagree",
        page_num=1,
        native_extraction=mock_extraction,
        ocr_detections=[],
        segformer_proposals=segformer_items,
        mask2former_proposals=[],
        sam2_refinements=[],
        dino_detections=[],
        base_polygons=base_polygons,
    )

    region = fused.fused_regions[0]
    # Disagreement must be captured
    assert len(region.disagreement_notes) > 0
    assert "park" in region.disagreement_notes[0]
    assert region.validation_status in ("review_required", "candidate")
