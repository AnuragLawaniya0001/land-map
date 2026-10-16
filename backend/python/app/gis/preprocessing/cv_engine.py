"""Preprocessing and Image Processing Engine for Layout Drawings.

Provides robust image preprocessing using OpenCV when available, with full
NumPy, SciPy, and Pillow fallbacks so the pipeline executes seamlessly in any environment.
"""

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps
from scipy import ndimage

logger = logging.getLogger("livemap.preprocessing")

try:
    import cv2  # type: ignore
    HAS_CV2 = True
except ImportError:
    cv2 = None
    HAS_CV2 = False


class ImagePreprocessingEngine:
    """Multi-strategy preprocessing engine for raster and scanned colony layout documents."""

    def __init__(self, high_resolution_dpi: int = 300, base_resolution_dpi: int = 150):
        self.high_resolution_dpi = high_resolution_dpi
        self.base_resolution_dpi = base_resolution_dpi

    # -------------------------------------------------------------------------
    # 1. Deskewing
    # -------------------------------------------------------------------------
    def detect_skew_angle(self, image: Image.Image) -> float:
        """Estimates skew angle in degrees using Radon transform / projection variance or Hough lines."""
        gray = np.array(image.convert("L"))
        h, w = gray.shape

        if HAS_CV2:
            try:
                # Use Canny edges and probabilistic Hough lines
                edges = cv2.Canny(gray, 50, 150, apertureSize=3)
                lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=100, minLineLength=w // 8, maxLineGap=20)
                if lines is not None and len(lines) > 0:
                    angles = []
                    for line in lines:
                        x1, y1, x2, y2 = line[0]
                        if x2 != x1:
                            angle = math.degrees(math.atan2(y2 - y1, x2 - x1))
                            # Keep only small tilt angles within +/- 15 deg of 0 or 90
                            if abs(angle) < 15:
                                angles.append(angle)
                            elif abs(angle - 90) < 15:
                                angles.append(angle - 90)
                            elif abs(angle + 90) < 15:
                                angles.append(angle + 90)
                    if angles:
                        median_angle = float(np.median(angles))
                        return round(median_angle, 2)
            except Exception as e:
                logger.debug("cv2 deskew failed, falling back: %s", e)

        # NumPy/SciPy projection profile fallback
        try:
            # Test candidate angles between -5 and +5 degrees
            sample = gray[h // 4 : 3 * h // 4, w // 4 : 3 * w // 4]
            best_angle = 0.0
            max_variance = 0.0
            for a in np.linspace(-5.0, 5.0, 21):
                rotated = ndimage.rotate(sample, a, reshape=False, order=0)
                proj = np.sum(rotated < 128, axis=1)
                variance = float(np.var(proj))
                if variance > max_variance:
                    max_variance = variance
                    best_angle = a
            return round(best_angle, 2)
        except Exception:
            return 0.0

    def deskew(self, image: Image.Image, angle: Optional[float] = None) -> Tuple[Image.Image, float]:
        """Rotates image to correct skew, returning deskewed image and angle corrected."""
        if angle is None:
            angle = self.detect_skew_angle(image)
        if abs(angle) < 0.1:
            return image, 0.0
        rotated = image.rotate(-angle, expand=True, resample=Image.BICUBIC, fillcolor=(255, 255, 255))
        return rotated, angle

    # -------------------------------------------------------------------------
    # 2. Denoising & Contrast Normalization
    # -------------------------------------------------------------------------
    def normalize_illumination(self, image: Image.Image) -> Image.Image:
        """Normalizes uneven background lighting across scanned layout drawings."""
        if HAS_CV2:
            try:
                np_img = np.array(image.convert("RGB"))
                # Convert to LAB and apply CLAHE to L channel
                lab = cv2.cvtColor(np_img, cv2.COLOR_RGB2LAB)
                l, a, b = cv2.split(lab)
                clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
                cl = clahe.apply(l)
                merged = cv2.merge((cl, a, b))
                norm_rgb = cv2.cvtColor(merged, cv2.COLOR_LAB2RGB)
                return Image.fromarray(norm_rgb)
            except Exception as e:
                logger.debug("cv2 normalize_illumination error: %s", e)

        # Pillow fallback
        enhancer = ImageEnhance.Contrast(image)
        return enhancer.enhance(1.25)

    def denoise(self, image: Image.Image) -> Image.Image:
        """Removes scanner artifacts, salt-and-pepper noise while preserving thin cadastral linework."""
        if HAS_CV2:
            try:
                np_img = np.array(image.convert("RGB"))
                # Fast bilateral filter preserves sharp cadastral lines
                denoised = cv2.bilateralFilter(np_img, d=5, sigmaColor=50, sigmaSpace=50)
                return Image.fromarray(denoised)
            except Exception as e:
                logger.debug("cv2 denoise error: %s", e)

        return image.filter(ImageFilter.MedianFilter(size=3))

    # -------------------------------------------------------------------------
    # 3. Adaptive Thresholding & Binarization
    # -------------------------------------------------------------------------
    def adaptive_threshold(self, image: Image.Image, block_size: int = 21, c_offset: int = 10) -> np.ndarray:
        """Computes clean binary mask (0 = background, 255 = linework/text)."""
        gray = np.array(image.convert("L"))

        if HAS_CV2:
            try:
                # Invert so linework is white (255)
                bin_img = cv2.adaptiveThreshold(
                    gray,
                    255,
                    cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                    cv2.THRESH_BINARY_INV,
                    block_size if block_size % 2 == 1 else block_size + 1,
                    c_offset,
                )
                return bin_img
            except Exception as e:
                logger.debug("cv2 adaptive threshold error: %s", e)

        # SciPy uniform filter fallback for adaptive thresholding
        mean = ndimage.uniform_filter(gray.astype(float), size=block_size)
        binary = (gray < (mean - c_offset)).astype(np.uint8) * 255
        return binary

    # -------------------------------------------------------------------------
    # 4. Morphological Line & Junction Enhancement
    # -------------------------------------------------------------------------
    def extract_linework(
        self,
        binary_mask: np.ndarray,
        min_line_length: int = 15,
    ) -> Dict[str, np.ndarray]:
        """Separates horizontal, vertical, and diagonal linework from text annotations."""
        h, w = binary_mask.shape

        if HAS_CV2:
            try:
                # Horizontal line kernel
                h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (min_line_length, 1))
                h_lines = cv2.morphologyEx(binary_mask, cv2.MORPH_OPEN, h_kernel)

                # Vertical line kernel
                v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, min_line_length))
                v_lines = cv2.morphologyEx(binary_mask, cv2.MORPH_OPEN, v_kernel)

                combined_lines = cv2.bitwise_or(h_lines, v_lines)
                junctions = cv2.bitwise_and(h_lines, v_lines)
                isolated_text = cv2.subtract(binary_mask, combined_lines)

                return {
                    "horizontal_lines": h_lines,
                    "vertical_lines": v_lines,
                    "combined_lines": combined_lines,
                    "junctions": junctions,
                    "isolated_text_candidates": isolated_text,
                }
            except Exception as e:
                logger.debug("cv2 extract_linework error: %s", e)

        # SciPy fallback
        h_structure = np.ones((1, min_line_length), dtype=bool)
        v_structure = np.ones((min_line_length, 1), dtype=bool)
        bin_bool = binary_mask > 0

        h_lines = ndimage.binary_opening(bin_bool, structure=h_structure).astype(np.uint8) * 255
        v_lines = ndimage.binary_opening(bin_bool, structure=v_structure).astype(np.uint8) * 255
        combined = np.maximum(h_lines, v_lines)
        junctions = np.minimum(h_lines, v_lines)
        text_cand = np.clip(binary_mask.astype(int) - combined.astype(int), 0, 255).astype(np.uint8)

        return {
            "horizontal_lines": h_lines,
            "vertical_lines": v_lines,
            "combined_lines": combined,
            "junctions": junctions,
            "isolated_text_candidates": text_cand,
        }

    # -------------------------------------------------------------------------
    # 5. Color Segmentation for Layout Features (Parks, Roads, Water, Plots)
    # -------------------------------------------------------------------------
    def segment_by_color(self, image: Image.Image) -> Dict[str, np.ndarray]:
        """Segments layout drawing into semantic candidate masks based on layout conventions."""
        rgb = np.array(image.convert("RGB"))
        r, g, b = rgb[:, :, 0].astype(float), rgb[:, :, 1].astype(float), rgb[:, :, 2].astype(float)

        # Green spaces / parks: Green channel dominant and significantly higher than Red & Blue
        green_mask = (g > 130) & (g > r * 1.15) & (g > b * 1.15) & ((r + g + b) < 720)

        # Water bodies: Blue channel dominant and high saturation
        blue_mask = (b > 140) & (b > r * 1.15) & (b > g * 1.05) & ((r + g + b) < 720)

        # Yellow / Orange / Amenity / Commercial fills
        yellow_mask = (r > 160) & (g > 150) & (b < 120) & (r > b * 1.3)

        # Road surfaces: Often light grey or beige fills, or uncolored strips between plot parcels
        grey_fill_mask = (
            (np.abs(r - g) < 15)
            & (np.abs(g - b) < 15)
            & (r > 180)
            & (r < 240)
        )

        return {
            "park_green_mask": green_mask.astype(np.uint8) * 255,
            "water_body_mask": blue_mask.astype(np.uint8) * 255,
            "amenity_yellow_mask": yellow_mask.astype(np.uint8) * 255,
            "road_surface_mask": grey_fill_mask.astype(np.uint8) * 255,
        }

    # -------------------------------------------------------------------------
    # 6. Connected Components & Bounding Boxes
    # -------------------------------------------------------------------------
    def get_connected_components(
        self,
        binary_mask: np.ndarray,
        min_area: int = 50,
        max_area: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Finds connected components with bounding boxes, area, and centroid."""
        if HAS_CV2:
            try:
                num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(binary_mask)
                results = []
                for i in range(1, num_labels):
                    area = int(stats[i, cv2.CC_STAT_AREA])
                    if area < min_area:
                        continue
                    if max_area and area > max_area:
                        continue
                    x = int(stats[i, cv2.CC_STAT_LEFT])
                    y = int(stats[i, cv2.CC_STAT_TOP])
                    w = int(stats[i, cv2.CC_STAT_WIDTH])
                    h = int(stats[i, cv2.CC_STAT_HEIGHT])
                    cx, cy = centroids[i]
                    results.append({
                        "id": f"cc_{i}",
                        "bbox": [x, y, x + w, y + h],
                        "area": area,
                        "centroid": [float(cx), float(cy)],
                    })
                return results
            except Exception as e:
                logger.debug("cv2 connected components error: %s", e)

        # SciPy fallback
        labeled, num_features = ndimage.label(binary_mask > 0)
        slices = ndimage.find_objects(labeled)
        results = []
        for i, slc in enumerate(slices):
            if slc is None:
                continue
            component_mask = labeled[slc] == (i + 1)
            area = int(np.sum(component_mask))
            if area < min_area or (max_area and area > max_area):
                continue
            ymin, ymax = slc[0].start, slc[0].stop
            xmin, xmax = slc[1].start, slc[1].stop
            cy, cx = ndimage.center_of_mass(component_mask)
            results.append({
                "id": f"cc_{i + 1}",
                "bbox": [int(xmin), int(ymin), int(xmax), int(ymax)],
                "area": area,
                "centroid": [float(xmin + cx), float(ymin + cy)],
            })
        return results

    # -------------------------------------------------------------------------
    # 7. Targeted Crop Selection
    # -------------------------------------------------------------------------
    def crop_region(
        self,
        image: Image.Image,
        bbox: List[int],
        padding_ratio: float = 0.1,
    ) -> Tuple[Image.Image, List[int]]:
        """Safely extracts a padded crop from an image, returning the crop and actual padded bbox."""
        w_img, h_img = image.size
        x1, y1, x2, y2 = bbox
        bw = x2 - x1
        bh = y2 - y1

        pad_x = int(bw * padding_ratio)
        pad_y = int(bh * padding_ratio)

        crop_x1 = max(0, x1 - pad_x)
        crop_y1 = max(0, y1 - pad_y)
        crop_x2 = min(w_img, x2 + pad_x)
        crop_y2 = min(h_img, y2 + pad_y)

        cropped = image.crop((crop_x1, crop_y1, crop_x2, crop_y2))
        return cropped, [crop_x1, crop_y1, crop_x2, crop_y2]
