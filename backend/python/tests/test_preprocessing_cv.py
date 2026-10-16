"""Tests for OpenCV/NumPy Image Preprocessing Engine."""

import pytest
import numpy as np
from PIL import Image, ImageDraw

from app.gis.preprocessing.cv_engine import ImagePreprocessingEngine


@pytest.fixture
def synthetic_drawing_image():
    """Creates a synthetic layout drawing with lines, text, park green, and water blue."""
    img = Image.new("RGB", (300, 300), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Black linework (horizontal and vertical borders)
    draw.rectangle([20, 20, 280, 280], outline=(0, 0, 0), width=3)
    draw.line([20, 150, 280, 150], fill=(0, 0, 0), width=2)
    draw.line([150, 20, 150, 280], fill=(0, 0, 0), width=2)

    # Green park area (top left quadrant)
    draw.rectangle([30, 30, 140, 140], fill=(40, 190, 60))

    # Blue water body (bottom right quadrant)
    draw.rectangle([160, 160, 270, 270], fill=(50, 120, 220))

    return img


def test_deskewing(synthetic_drawing_image):
    engine = ImagePreprocessingEngine()
    # Test deskew on an unskewed image
    angle = engine.detect_skew_angle(synthetic_drawing_image)
    assert abs(angle) < 5.0

    # Intentionally rotate by 3 degrees
    tilted = synthetic_drawing_image.rotate(3.0, expand=True, fillcolor=(255, 255, 255))
    deskewed, detected_angle = engine.deskew(tilted)
    assert deskewed is not None
    assert deskewed.size[0] >= tilted.size[0]


def test_denoise_and_illumination(synthetic_drawing_image):
    engine = ImagePreprocessingEngine()
    norm = engine.normalize_illumination(synthetic_drawing_image)
    assert norm.size == synthetic_drawing_image.size

    denoised = engine.denoise(synthetic_drawing_image)
    assert denoised.size == synthetic_drawing_image.size


def test_adaptive_threshold_and_linework(synthetic_drawing_image):
    engine = ImagePreprocessingEngine()
    bin_mask = engine.adaptive_threshold(synthetic_drawing_image)
    assert isinstance(bin_mask, np.ndarray)
    assert bin_mask.shape == (300, 300)
    assert np.max(bin_mask) == 255

    linework = engine.extract_linework(bin_mask, min_line_length=15)
    assert "horizontal_lines" in linework
    assert "vertical_lines" in linework
    assert "combined_lines" in linework
    assert "junctions" in linework


def test_color_segmentation(synthetic_drawing_image):
    engine = ImagePreprocessingEngine()
    color_masks = engine.segment_by_color(synthetic_drawing_image)

    assert "park_green_mask" in color_masks
    assert "water_body_mask" in color_masks
    # Green quadrant should be detected
    assert np.sum(color_masks["park_green_mask"] > 0) > 100
    # Blue quadrant should be detected
    assert np.sum(color_masks["water_body_mask"] > 0) > 100


def test_connected_components(synthetic_drawing_image):
    engine = ImagePreprocessingEngine()
    bin_mask = engine.adaptive_threshold(synthetic_drawing_image)
    comps = engine.get_connected_components(bin_mask, min_area=30)
    assert len(comps) > 0
    assert "bbox" in comps[0]
    assert "area" in comps[0]
    assert "centroid" in comps[0]
