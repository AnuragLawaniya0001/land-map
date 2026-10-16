"""Secure File Ingestion and Format Validation.

Validates uploaded files against magic bytes, size limits, page count caps,
zip-bomb expansion hazards, password encryption, and path-traversal attacks.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import io
import os
import re
import zipfile
from typing import Optional, Tuple

import pymupdf


MAX_UPLOAD_SIZE_MB = int(os.environ.get("MAX_UPLOAD_SIZE_MB", "200"))
MAX_FILE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024  # default 200 MB
MAX_PDF_PAGES = 50
MAX_KMZ_UNCOMPRESSED_BYTES = 50 * 1024 * 1024  # 50 MB
MAX_KMZ_FILE_COUNT = 50


@dataclass
class FileValidationResult:
    is_valid: bool
    error_message: Optional[str] = None
    sanitized_filename: str = ""
    sha256: str = ""
    detected_format: str = "unknown"  # "pdf", "kml", "kmz", "geojson", "dxf"
    page_count: int = 1
    is_encrypted: bool = False
    size_bytes: int = 0


def sanitize_filename(filename: str) -> str:
    """Strips directory traversal sequences and unsafe characters from filenames."""
    base = os.path.basename(filename).strip()
    # Remove any null bytes or control characters
    base = re.sub(r"[\x00-\x1f\x7f]", "", base)
    # Replace dangerous path navigation
    base = re.sub(r"\.\.+[/\\Release]*", "", base)
    return base or "unnamed_document"


def compute_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_uploaded_file(
    data: bytes,
    raw_filename: str,
    max_bytes: int = MAX_FILE_BYTES,
    max_pages: int = MAX_PDF_PAGES,
) -> FileValidationResult:
    """Performs deep validation of an uploaded file."""
    sanitized_name = sanitize_filename(raw_filename)
    size = len(data)
    file_hash = compute_sha256(data)

    if size == 0:
        return FileValidationResult(
            is_valid=False,
            error_message="Uploaded file is empty (0 bytes)",
            sanitized_filename=sanitized_name,
            sha256=file_hash,
            size_bytes=0,
        )

    if size > max_bytes:
        return FileValidationResult(
            is_valid=False,
            error_message=f"File exceeds maximum size limit of {max_bytes // (1024 * 1024)} MB",
            sanitized_filename=sanitized_name,
            sha256=file_hash,
            size_bytes=size,
        )

    ext = os.path.splitext(sanitized_name.lower())[1]

    # 1. PDF Validation
    if ext == ".pdf" or data.startswith(b"%PDF-"):
        if not data.startswith(b"%PDF-"):
            return FileValidationResult(
                is_valid=False,
                error_message="Invalid PDF signature. File does not start with '%PDF-' magic bytes",
                sanitized_filename=sanitized_name,
                sha256=file_hash,
                detected_format="pdf",
                size_bytes=size,
            )
        try:
            doc = pymupdf.open(stream=data, filetype="pdf")
            if doc.is_encrypted or doc.needs_pass:
                return FileValidationResult(
                    is_valid=False,
                    error_message="Encrypted or password-protected PDFs are not supported. Please remove password protection.",
                    sanitized_filename=sanitized_name,
                    sha256=file_hash,
                    detected_format="pdf",
                    is_encrypted=True,
                    size_bytes=size,
                )
            page_count = doc.page_count
            if page_count > max_pages:
                return FileValidationResult(
                    is_valid=False,
                    error_message=f"PDF page count ({page_count}) exceeds processing limit of {max_pages} pages",
                    sanitized_filename=sanitized_name,
                    sha256=file_hash,
                    detected_format="pdf",
                    page_count=page_count,
                    size_bytes=size,
                )
            return FileValidationResult(
                is_valid=True,
                sanitized_filename=sanitized_name,
                sha256=file_hash,
                detected_format="pdf",
                page_count=page_count,
                size_bytes=size,
            )
        except Exception as exc:
            return FileValidationResult(
                is_valid=False,
                error_message=f"Malformed or corrupt PDF file: {exc}",
                sanitized_filename=sanitized_name,
                sha256=file_hash,
                detected_format="pdf",
                size_bytes=size,
            )

    # 2. KMZ Validation (Zip archive containing KML)
    if ext == ".kmz" or data.startswith(b"PK\x03\x04"):
        if not data.startswith(b"PK\x03\x04"):
            return FileValidationResult(
                is_valid=False,
                error_message="Invalid KMZ signature. File does not contain standard ZIP archive header",
                sanitized_filename=sanitized_name,
                sha256=file_hash,
                detected_format="kmz",
                size_bytes=size,
            )
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                infos = zf.infolist()
                if len(infos) > MAX_KMZ_FILE_COUNT:
                    return FileValidationResult(
                        is_valid=False,
                        error_message=f"KMZ archive contains too many files ({len(infos)} > {MAX_KMZ_FILE_COUNT})",
                        sanitized_filename=sanitized_name,
                        sha256=file_hash,
                        detected_format="kmz",
                        size_bytes=size,
                    )
                total_uncompressed = sum(info.file_size for info in infos)
                if total_uncompressed > MAX_KMZ_UNCOMPRESSED_BYTES:
                    return FileValidationResult(
                        is_valid=False,
                        error_message=f"KMZ uncompressed expansion ({total_uncompressed // (1024*1024)} MB) exceeds safety threshold",
                        sanitized_filename=sanitized_name,
                        sha256=file_hash,
                        detected_format="kmz",
                        size_bytes=size,
                    )
                kml_found = any(info.filename.lower().endswith(".kml") for info in infos)
                if not kml_found:
                    return FileValidationResult(
                        is_valid=False,
                        error_message="KMZ archive does not contain any .kml document entry",
                        sanitized_filename=sanitized_name,
                        sha256=file_hash,
                        detected_format="kmz",
                        size_bytes=size,
                    )
            return FileValidationResult(
                is_valid=True,
                sanitized_filename=sanitized_name,
                sha256=file_hash,
                detected_format="kmz",
                size_bytes=size,
            )
        except zipfile.BadZipFile as exc:
            return FileValidationResult(
                is_valid=False,
                error_message=f"Corrupt or malformed KMZ ZIP archive: {exc}",
                sanitized_filename=sanitized_name,
                sha256=file_hash,
                detected_format="kmz",
                size_bytes=size,
            )

    # 3. KML Validation (XML)
    if ext == ".kml" or b"<kml" in data[:1024].lower() or b"<?xml" in data[:1024].lower():
        text_head = data[:1024].decode("utf-8", errors="ignore").lower()
        if "<kml" not in text_head and "<?xml" not in text_head:
            return FileValidationResult(
                is_valid=False,
                error_message="Invalid KML file. File missing XML or KML root tag",
                sanitized_filename=sanitized_name,
                sha256=file_hash,
                detected_format="kml",
                size_bytes=size,
            )
        return FileValidationResult(
            is_valid=True,
            sanitized_filename=sanitized_name,
            sha256=file_hash,
            detected_format="kml",
            size_bytes=size,
        )

    # 4. GeoJSON / Other GIS formats
    if ext in (".geojson", ".json"):
        return FileValidationResult(
            is_valid=True,
            sanitized_filename=sanitized_name,
            sha256=file_hash,
            detected_format="geojson",
            size_bytes=size,
        )

    # 5. CAD Formats
    if ext in (".dxf", ".dwg", ".dwf"):
        return FileValidationResult(
            is_valid=True,
            sanitized_filename=sanitized_name,
            sha256=file_hash,
            detected_format=ext[1:],
            size_bytes=size,
        )

    return FileValidationResult(
        is_valid=False,
        error_message=f"Unsupported file format '{ext}'. Supported: .pdf, .kml, .kmz, .geojson, .dxf",
        sanitized_filename=sanitized_name,
        sha256=file_hash,
        size_bytes=size,
    )
