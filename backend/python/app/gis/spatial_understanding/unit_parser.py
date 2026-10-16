"""Unit and Notation Parser for colony engineering drawings.

Supports configurable parsing of metric and imperial formats, architectural feet-inch
notation, area units, road annotations, setbacks, and radii. Preserves raw strings and
flags ambiguous or uncertain notations.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional, Tuple

from app.gis.spatial_understanding.models import MeasurementType


@dataclass
class ParsedMeasurement:
    raw_text: str
    parsed_value: Optional[float]
    unit: Optional[str]  # e.g., "m", "cm", "mm", "ft", "in", "sqm", "sqft", "sqyd", "deg"
    unit_uncertain: bool
    measurement_type: MeasurementType
    is_valid_measurement: bool
    is_area: bool = False
    is_road_label: bool = False
    is_plot_label: bool = False
    details: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "raw_text": self.raw_text,
            "parsed_value": self.parsed_value,
            "unit": self.unit,
            "unit_uncertain": self.unit_uncertain,
            "measurement_type": self.measurement_type.value,
            "is_valid_measurement": self.is_valid_measurement,
            "is_area": self.is_area,
            "is_road_label": self.is_road_label,
            "is_plot_label": self.is_plot_label,
            "details": self.details,
        }


# Regexes
PLOT_LABEL_RE = re.compile(
    r"^(?:plot|plt|pl|p|lot|parcel|survey|site)\s*(?:no\.?|#|num)?\s*[:\-\s]?\s*([a-z0-9\-/]+)$|"
    r"^[a-z]{1,2}[-/ ]?\d{1,4}[a-z]?$|"
    r"^\d{1,4}[-/ ]+[a-z]{1,2}$",
    re.I,
)

ROAD_LABEL_RE = re.compile(
    r"\b(?:road|rd\.?|street|lane|path|marg|rasta|avenue)\b",
    re.I,
)

ROAD_WIDTH_PATTERN = re.compile(
    r"(?:(\d+(?:\.\d+)?)\s*(mt\.?|m|mtr|meter|metre|ft|feet|')\s*(?:wide|width)?\s*(?:road|rd\.?|lane)?)|"
    r"(?:(?:road|rd\.?)\s*(\d+(?:\.\d+)?)\s*(mt\.?|m|mtr|meter|metre|ft|feet|'))",
    re.I,
)

SETBACK_RE = re.compile(
    r"\b(?:setback|margin|front\s*margin|rear\s*margin|side\s*margin|bldg\s*line)\b",
    re.I,
)

RADIUS_RE = re.compile(
    r"\b(?:r|rad|radius)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(mt\.?|m|mtr|ft|feet|'|\")?",
    re.I,
)

ANGLE_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(?:°|deg|degrees)|(\d{1,3})[-°](\d{1,2})['′][-']?(\d{1,2})?[\"″]",
    re.I,
)

AREA_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(sq\.?\s*m(?:t|tr|etres?)?|sqm|m2|m²|"
    r"sq\.?\s*ft|sqft|ft2|ft²|square\s*feet|"
    r"sq\.?\s*(?:yd|yds|yards?)|sqyd|sq\.?\s*var|sqvar|var|gaj|"
    r"guntas?|guntha|acres?|hectares?|ha|bigha|biswa)\b",
    re.I,
)

# Architectural feet-inch patterns
FEET_INCH_RE = re.compile(
    r"""
    ^
    (\d+)\s*['′]                       # Feet with tick
    (?:\s*[-–\s]?\s*(\d+))?            # Optional Inches integer
    (?:\s*(\d+)\s*/\s*(\d+))?          # Optional fraction (e.g. 1/2)
    \s*["″]?                           # Optional inch quote
    $
    """,
    re.VERBOSE | re.I,
)

FEET_DECIMAL_RE = re.compile(
    r"^(\d+(?:\.\d+)?)\s*(?:ft|feet|')(?:\s*0\s*[\"″])?$",
    re.I,
)

# Architectural hyphen without tick e.g. "30-6" or "30'-0"
ARCH_HYPHEN_RE = re.compile(
    r"^(\d{1,3})\s*[-–]\s*(\d{1,2}(?:\.\d+)?)\s*[\"″]?(?:\s*(\d+)\s*/\s*(\d+))?$",
    re.I,
)

# Metric length patterns
METRIC_LENGTH_RE = re.compile(
    r"^(\d+(?:\.\d+)?)\s*(mt\.?|m|mtr|mtrs|meter|meters|metre|metres)$",
    re.I,
)

CENTIMETRE_RE = re.compile(
    r"^(\d+(?:\.\d+)?)\s*(cm|cms|centimeters?|centimetres?)$",
    re.I,
)

MILLIMETRE_RE = re.compile(
    r"^(\d+(?:\.\d+)?)\s*(mm|millimeters?|millimetres?)$",
    re.I,
)

INCH_ONLY_RE = re.compile(
    r"^(\d+(?:\.\d+)?)\s*(?:in|inches|\"|″)$",
    re.I,
)

BARE_NUMBER_RE = re.compile(
    r"^(\d+(?:\.\d+)?)$",
)


def _fraction_to_float(num_str: Optional[str], den_str: Optional[str]) -> float:
    if num_str and den_str:
        try:
            den = float(den_str)
            if den > 0:
                return float(num_str) / den
        except ValueError:
            pass
    return 0.0


def parse_measurement_text(text: str) -> ParsedMeasurement:
    """Parses a raw text string from a drawing annotation into a structured measurement.

    Maintains raw text, detects units, flags uncertain notations without hallucinating,
    and classifies measurement category.
    """
    raw = (text or "").strip()
    if not raw:
        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=None,
            unit=None,
            unit_uncertain=True,
            measurement_type=MeasurementType.UNKNOWN_MEASUREMENT,
            is_valid_measurement=False,
        )

    # 1. Check for Road Width annotations (e.g. "9 MT. WIDE ROAD", "12.0 M WIDE ROAD", "30' ROAD")
    road_match = ROAD_WIDTH_PATTERN.search(raw)
    if road_match and ROAD_LABEL_RE.search(raw):
        val_str = road_match.group(1) or road_match.group(3)
        unit_str = road_match.group(2) or road_match.group(4)
        if val_str:
            val = float(val_str)
            unit_norm = "m" if re.search(r"m|mt", unit_str or "", re.I) else "ft"
            return ParsedMeasurement(
                raw_text=raw,
                parsed_value=round(val, 3),
                unit=unit_norm,
                unit_uncertain=False,
                measurement_type=MeasurementType.ROAD_WIDTH,
                is_valid_measurement=True,
                is_road_label=True,
            )

    # 2. Check for Area notation (e.g., "150 sq.m", "1200 sq.ft", "200 sq.yds")
    area_match = AREA_RE.search(raw)
    if area_match:
        val = float(area_match.group(1))
        unit_raw = area_match.group(2).lower().replace(" ", "").replace(".", "")
        if "sqm" in unit_raw or "m2" in unit_raw or "metre" in unit_raw:
            unit_norm = "sqm"
        elif "sqft" in unit_raw or "ft2" in unit_raw or "feet" in unit_raw:
            unit_norm = "sqft"
        elif "yd" in unit_raw or "yard" in unit_raw or "var" in unit_raw or "gaj" in unit_raw:
            unit_norm = "sqyd"
        elif "gunta" in unit_raw:
            unit_norm = "guntha"
        elif "acre" in unit_raw:
            unit_norm = "acre"
        elif "ha" in unit_raw or "hectare" in unit_raw:
            unit_norm = "ha"
        else:
            unit_norm = unit_raw

        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=round(val, 3),
            unit=unit_norm,
            unit_uncertain=False,
            measurement_type=MeasurementType.AREA,
            is_valid_measurement=True,
            is_area=True,
        )

    # 3. Check for Radius (e.g., "R=15'", "R=5.0M", "RADIUS 10M")
    rad_match = RADIUS_RE.search(raw)
    if rad_match:
        val = float(rad_match.group(1))
        unit_raw = rad_match.group(2)
        unit_norm = None
        uncertain = True
        if unit_raw:
            if re.search(r"m|mt", unit_raw, re.I):
                unit_norm = "m"
                uncertain = False
            elif re.search(r"ft|'|\"", unit_raw, re.I):
                unit_norm = "ft"
                uncertain = False
        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=round(val, 3),
            unit=unit_norm,
            unit_uncertain=uncertain,
            measurement_type=MeasurementType.RADIUS,
            is_valid_measurement=True,
        )

    # 4. Check for Angle (e.g. "45°", "90 deg")
    angle_match = ANGLE_RE.search(raw)
    if angle_match:
        if angle_match.group(1):
            val = float(angle_match.group(1))
        else:
            d = float(angle_match.group(2) or 0)
            m = float(angle_match.group(3) or 0)
            s = float(angle_match.group(4) or 0)
            val = d + m / 60.0 + s / 3600.0
        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=round(val, 3),
            unit="deg",
            unit_uncertain=False,
            measurement_type=MeasurementType.ANGLE,
            is_valid_measurement=True,
        )

    # 5. Check for Setback / Margin (e.g. "SETBACK 3.0M", "10' MARGIN")
    if SETBACK_RE.search(raw):
        # Extract numeric and unit from rest of string
        m_len = METRIC_LENGTH_RE.search(raw) or FEET_INCH_RE.search(raw) or FEET_DECIMAL_RE.search(raw)
        val = None
        unit = None
        uncertain = True
        if m_len:
            val = float(m_len.group(1))
            unit = "m" if "m" in m_len.group(0).lower() else "ft"
            uncertain = False
        else:
            bare = re.search(r"(\d+(?:\.\d+)?)", raw)
            if bare:
                val = float(bare.group(1))
        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=val,
            unit=unit,
            unit_uncertain=uncertain,
            measurement_type=MeasurementType.SETBACK,
            is_valid_measurement=val is not None,
        )

    # 6. Check for Plot labels (e.g. "PLOT 42", "P-15", "PL-101")
    # Must NOT be confused with dimension measurements!
    if PLOT_LABEL_RE.match(raw) and not re.search(r"['\"m]|ft|sq|wide|road", raw, re.I):
        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=None,
            unit=None,
            unit_uncertain=False,
            measurement_type=MeasurementType.UNKNOWN_MEASUREMENT,
            is_valid_measurement=False,
            is_plot_label=True,
        )

    # Clean string for pure dimension parsing
    cleaned = raw.replace("′", "'").replace("″", '"').strip()

    # 7. Architectural Feet and Inches: e.g. 30'-0", 30' 6", 30'-6 1/2", 30'6", 30'-0
    ft_in_match = FEET_INCH_RE.match(cleaned)
    if ft_in_match:
        feet = float(ft_in_match.group(1))
        inches = float(ft_in_match.group(2) or 0)
        frac = _fraction_to_float(ft_in_match.group(3), ft_in_match.group(4))
        total_feet = feet + (inches + frac) / 12.0
        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=round(total_feet, 4),
            unit="ft",
            unit_uncertain=False,
            measurement_type=MeasurementType.UNKNOWN_MEASUREMENT,  # Will be classified by spatial engine
            is_valid_measurement=True,
            details={"feet": feet, "inches": inches + frac},
        )

    # 8. Decimal feet: e.g. 30.5', 30.5 ft
    ft_dec_match = FEET_DECIMAL_RE.match(cleaned)
    if ft_dec_match:
        total_feet = float(ft_dec_match.group(1))
        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=round(total_feet, 4),
            unit="ft",
            unit_uncertain=False,
            measurement_type=MeasurementType.UNKNOWN_MEASUREMENT,
            is_valid_measurement=True,
        )

    # 9. Architectural hyphen notation without ticks: e.g. "30-6" (30 feet 6 inches)
    # Caution: only treat as feet-inches if inches < 12 and typical architectural pattern
    arch_hyphen = ARCH_HYPHEN_RE.match(cleaned)
    if arch_hyphen:
        feet = float(arch_hyphen.group(1))
        inches = float(arch_hyphen.group(2))
        frac = _fraction_to_float(arch_hyphen.group(3), arch_hyphen.group(4))
        if inches < 12.0:
            total_feet = feet + (inches + frac) / 12.0
            return ParsedMeasurement(
                raw_text=raw,
                parsed_value=round(total_feet, 4),
                unit="ft",
                unit_uncertain=False,
                measurement_type=MeasurementType.UNKNOWN_MEASUREMENT,
                is_valid_measurement=True,
                details={"feet": feet, "inches": inches + frac, "note": "parsed_from_arch_hyphen"},
            )

    # 10. Metric lengths: e.g. 12.5 m, 12.50 MT., 12.50 MTR
    m_match = METRIC_LENGTH_RE.match(cleaned)
    if m_match:
        val = float(m_match.group(1))
        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=round(val, 4),
            unit="m",
            unit_uncertain=False,
            measurement_type=MeasurementType.UNKNOWN_MEASUREMENT,
            is_valid_measurement=True,
        )

    # 11. Centimetres: e.g. 1250 cm
    cm_match = CENTIMETRE_RE.match(cleaned)
    if cm_match:
        val = float(cm_match.group(1))
        # Normalise to metres
        val_m = val / 100.0
        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=round(val_m, 4),
            unit="m",
            unit_uncertain=False,
            measurement_type=MeasurementType.UNKNOWN_MEASUREMENT,
            is_valid_measurement=True,
            details={"original_unit": "cm", "original_value": val},
        )

    # 12. Millimetres: e.g. 12000 mm
    mm_match = MILLIMETRE_RE.match(cleaned)
    if mm_match:
        val = float(mm_match.group(1))
        val_m = val / 1000.0
        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=round(val_m, 4),
            unit="m",
            unit_uncertain=False,
            measurement_type=MeasurementType.UNKNOWN_MEASUREMENT,
            is_valid_measurement=True,
            details={"original_unit": "mm", "original_value": val},
        )

    # 13. Inches only: e.g. 36"
    in_match = INCH_ONLY_RE.match(cleaned)
    if in_match:
        val_in = float(in_match.group(1))
        val_ft = val_in / 12.0
        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=round(val_ft, 4),
            unit="ft",
            unit_uncertain=False,
            measurement_type=MeasurementType.UNKNOWN_MEASUREMENT,
            is_valid_measurement=True,
            details={"original_unit": "in", "original_value": val_in},
        )

    # 14. Bare numbers without any unit: e.g. "30", "45.5"
    # IMPORTANT: Requirement 5: "Do not infer units from a numeric value alone.
    # If the notation is ambiguous, retain the raw text and flag the unit as uncertain."
    bare_match = BARE_NUMBER_RE.match(cleaned)
    if bare_match:
        val = float(bare_match.group(1))
        return ParsedMeasurement(
            raw_text=raw,
            parsed_value=round(val, 4),
            unit=None,
            unit_uncertain=True,
            measurement_type=MeasurementType.UNKNOWN_MEASUREMENT,
            is_valid_measurement=True,
            details={"note": "bare_number_no_unit"},
        )

    # 15. Unrecognized string
    return ParsedMeasurement(
        raw_text=raw,
        parsed_value=None,
        unit=None,
        unit_uncertain=True,
        measurement_type=MeasurementType.UNKNOWN_MEASUREMENT,
        is_valid_measurement=False,
    )
