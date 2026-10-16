"""Admin GIS import preview and commit workflow.

Mount the returned router under ``/api`` to preserve the Node route paths.
"""

import asyncio
import hashlib
import inspect
import json
import logging
import os
import xml.etree.ElementTree as ET
from typing import Any, Callable

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request
from shapely.geometry import shape
from starlette.datastructures import UploadFile

from app.gis import importer, vector_import
from app.gis.plot_persistence import persist_import_documents
from app.gis.pdf_overlay import render_pdf_overlay_images
from app.gis.cad_overlay import render_cad_overlay_images
from app.storage import build_storage_key, delete_object, get_signed_url, put_object

logger = logging.getLogger(__name__)

MAX_UPLOAD_SIZE_MB = int(os.environ.get("MAX_UPLOAD_SIZE_MB", "200"))
MAX_LAYOUT_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024
_UPLOAD_FIELDS = ("file", "layout_pdf", "cad_file")
_QGIS_EXTENSIONS = (".geojson", ".json", ".gpkg")
_DEFAULT_EXTENSIONS = (".pdf", ".dxf", ".dwg", ".dwf", ".geojson", ".json", ".gpkg", ".kml")


def _get(obj: Any, key: str, default=None):
    return obj.get(key, default) if isinstance(obj, dict) else getattr(obj, key, default)


async def _maybe_await(value):
    return await value if inspect.isawaitable(value) else value


def _kml_polygon(data: bytes):
    """Return the first KML polygon as a GeoJSON geometry, if present."""
    root = ET.fromstring(data)
    for polygon in root.iter():
        if polygon.tag.rsplit("}", 1)[-1] != "Polygon":
            continue
        ring = next(
            (element for element in polygon.iter()
             if element.tag.rsplit("}", 1)[-1] == "coordinates"),
            None,
        )
        if ring is None or not ring.text:
            continue
        coordinates = []
        for item in ring.text.split():
            parts = item.split(",")
            if len(parts) >= 2:
                coordinates.append([float(parts[0]), float(parts[1])])
        if len(coordinates) >= 4:
            return {"type": "Polygon", "coordinates": [coordinates]}
    return None


def _geojson_polygon(data: bytes):
    """Extract a boundary polygon from a GeoJSON document for PDF fitting."""
    value = json.loads(data.decode("utf-8-sig"))
    features = value.get("features", []) if value.get("type") == "FeatureCollection" else [value]
    polygons = []
    for item in features:
        geometry = item.get("geometry") if item.get("type") == "Feature" else item
        if isinstance(geometry, dict) and geometry.get("type") in ("Polygon", "MultiPolygon"):
            properties = item.get("properties") or {}
            is_boundary = str(properties.get("feature_type", "")).lower() in {
                "site_boundary", "colony_boundary", "boundary",
            }
            polygons.append((not is_boundary, geometry))
    if polygons:
        polygons.sort(key=lambda item: item[0])
        return polygons[0][1]
    return None


def build_gis_import_router(
    db,
    require_admin_dep,
    load_owned_colony,
    audit_log,
    now_iso,
    importer_module,
    roads_module,
) -> APIRouter:
    """Build the isolated GIS-import router with application dependencies."""
    router = APIRouter()

    async def owned_colony(colony_id, user):
        return await _maybe_await(load_owned_colony(colony_id, user))

    async def get_import(import_id):
        if not ObjectId.is_valid(import_id):
            raise HTTPException(404, "GIS Import session not found")
        oid = ObjectId(import_id)
        imp = await db["gis_imports"].find_one({"_id": oid})
        if not imp:
            raise HTTPException(404, "GIS Import session not found")
        return oid, imp

    @router.post("/admin/colonies/{colonyId}/gis-imports", status_code=201)
    async def create_import(colonyId: str, request: Request, user=Depends(require_admin_dep)):
        colony = await owned_colony(colonyId, user)
        async with request.form() as form:
            files = {}
            for field in _UPLOAD_FIELDS:
                entries = form.getlist(field)
                if len(entries) > 1:
                    raise HTTPException(400, f"Only one {field} upload is allowed.")
                if entries and isinstance(entries[0], UploadFile):
                    upload = entries[0]
                    files[field] = {
                        "name": upload.filename or "",
                        "mime": upload.content_type or "application/octet-stream",
                        "data": await upload.read(),
                    }
            qgis_file = files.get("file")
            pdf_file = files.get("layout_pdf")
            companion = files.get("cad_file")
            provided = [item for item in (qgis_file, pdf_file, companion) if item]
            if not provided:
                raise HTTPException(
                    400,
                    "Upload at least one mapping file (GeoJSON, PDF layout, or KML/DWG companion).",
                )

            source = qgis_file or pdf_file or companion
            import_mode = str(form.get("import_mode") or "").lower()
            filename_lower = source["name"].lower()
            extension = os.path.splitext(filename_lower)[1]
            for uploaded in provided:
                if len(uploaded["data"]) > MAX_LAYOUT_BYTES:
                    raise HTTPException(413, f"File too large (max {MAX_UPLOAD_SIZE_MB} MB)")
            if import_mode == "qgis":
                allowed = _QGIS_EXTENSIONS
                message = "QGIS mode requires a GeoJSON or GeoPackage file."
            elif import_mode == "pdf_pair":
                allowed = (".pdf", ".kml", ".dwg", ".dwf", ".dxf")
                message = "Layout mode requires a PDF, DWG, DWF, or DXF layout file with a KML land boundary companion."
            else:
                allowed = _DEFAULT_EXTENSIONS
                message = "Upload a GeoJSON/GeoPackage, KML, DXF, DWG, DWF, or PDF file."
            if extension not in allowed:
                raise HTTPException(400, message)

            existing_boundary = _get(colony, "boundary")
            target_boundary = existing_boundary
            boundary_selection = None
            qgis_boundary_used = False
            companion_extension = os.path.splitext((companion or {}).get("name", "").lower())[1]
            if pdf_file and companion and companion_extension == ".kml":
                try:
                    target_boundary, boundary_selection = vector_import.extract_pdf_boundary(
                        companion["data"], companion["name"]
                    )
                except vector_import.VectorImportError as exc:
                    raise HTTPException(422, f"Could not read the uploaded KML land boundary: {exc}") from exc
            elif companion and companion_extension == ".kml" and not target_boundary:
                try:
                    target_boundary = vector_import.extract_boundary(companion["data"], companion["name"])
                except vector_import.VectorImportError:
                    target_boundary = None
            if qgis_file and pdf_file and not target_boundary:
                try:
                    target_boundary = vector_import.extract_boundary(qgis_file["data"], qgis_file["name"])
                    qgis_boundary_used = target_boundary is not None
                except vector_import.VectorImportError:
                    target_boundary = None

            if pdf_file and not target_boundary and not existing_boundary:
                raise HTTPException(
                    422,
                    "PDF layout preview requires a colony land boundary (KML) so plot geometry can be fitted and checked.",
                )

            now = now_iso()
            import_id = ObjectId()
            colony_id = str(_get(colony, "_id"))
            maps_link = str(form.get("maps_link") or "")
            try:
                if pdf_file and target_boundary:
                    anchor = shape(target_boundary).representative_point()
                    extract_num_fn = getattr(importer_module, "extract_pdf_plot_numbers", None) or getattr(importer, "extract_pdf_plot_numbers", None)
                    plot_numbers = await asyncio.to_thread(
                        extract_num_fn, pdf_file["data"]
                    )
                    fields = {
                        "boundary": target_boundary,
                        "map_center": {"lat": anchor.y, "lng": anchor.x},
                        "layout_version": "imported",
                        "import_source": {
                            "filename": pdf_file["name"],
                            "mode": "pdf_overlay_only",
                            "plots": len(plot_numbers),
                            "pdf_plot_count": len(plot_numbers),
                            "pdf_plot_numbers": plot_numbers,
                            "registration_metrics": {"processing_mode": "visual_overlay_only"},
                        },
                    }
                    zone_docs, plot_docs = [], []
                    warnings = [
                        f"Detected {len(plot_numbers)} unique plot labels from PDF text. This visual overlay does not create individual plot records or georeference their locations."
                    ]
                    pdf_extractor = getattr(importer_module, "_extract_pdf", None)
                    if callable(pdf_extractor):
                        extracted_pdf = await asyncio.to_thread(
                            pdf_extractor, pdf_file["data"]
                        )
                        fields["import_source"]["pdf_content"] = extracted_pdf.get(
                            "pdf_content"
                        )
                        if extracted_pdf.get("lines") or extracted_pdf.get("polys"):
                            try:
                                (
                                    detected_fields,
                                    detected_zones,
                                    detected_plots,
                                    detection_warnings,
                                ) = await asyncio.to_thread(
                                    importer_module.import_file,
                                    data=pdf_file["data"],
                                    filename=pdf_file["name"],
                                    maps_link=maps_link,
                                    colony_id=colony_id,
                                    now=now,
                                    target_boundary=target_boundary,
                                    extracted_pdf=extracted_pdf,
                                )
                            except Exception as exc:
                                importer_error = getattr(
                                    importer_module, "ImportError_", None
                                )
                                if importer_error is None or not isinstance(
                                    exc, importer_error
                                ):
                                    raise
                                logger.warning(
                                    "PDF vector plot extraction failed; keeping the visual overlay: %s",
                                    exc,
                                )
                                warnings.append(
                                    f"Individual plot extraction failed: {exc} "
                                    "Only the visual overlay and heuristic regions are available."
                                )
                            else:
                                if detected_plots:
                                    fields = detected_fields
                                    zone_docs = detected_zones
                                    plot_docs = detected_plots
                                    warnings = detection_warnings
                                    fields["boundary"] = target_boundary
                                    fields["map_center"] = {
                                        "lat": anchor.y,
                                        "lng": anchor.x,
                                    }
                                    fields.setdefault("import_source", {}).update({
                                        "pdf_plot_count": len(plot_numbers),
                                        "pdf_plot_numbers": plot_numbers,
                                        "saved_plot_records": len(plot_docs),
                                        "pdf_content": extracted_pdf.get("pdf_content"),
                                        "pdf_processing_mode": "vector_plots_and_visual_overlay",
                                    })
                                    warnings.append(
                                        f"Recovered {len(plot_docs)} individual vector plot geometries."
                                    )
                                else:
                                    warnings.append(
                                        "Vector content was present, but no individual plot boundaries "
                                        "were confidently recovered; only the visual overlay is available."
                                    )
                        if extracted_pdf.get("pdf_content", {}).get("page_count", 0) > 1:
                            warnings.append(
                                    "This PDF contains multiple pages; visual overlay rendering uses page 1."
                            )
                elif not pdf_file and extension in (".geojson", ".json", ".gpkg"):
                    fields, zone_docs, plot_docs, warnings = vector_import.import_vector(
                        source["data"],
                        source["name"],
                        colony_id,
                        now,
                        maps_link=maps_link,
                        existing_boundary=existing_boundary,
                    )
                elif not pdf_file and extension == ".kml":
                    fields, zone_docs, plot_docs, warnings = vector_import.import_kml_boundary(
                        source["data"],
                        source["name"],
                        colony_id,
                        now,
                        existing_boundary=existing_boundary,
                        maps_link=maps_link,
                    )
                else:
                    processing_source = pdf_file or source
                    fields, zone_docs, plot_docs, warnings = importer_module.import_file(
                        data=processing_source["data"],
                        filename=processing_source["name"],
                        maps_link=maps_link,
                        colony_id=colony_id,
                        now=now,
                        target_boundary=target_boundary,
                    )
            except (vector_import.VectorImportError, importer.ImportError_) as exc:
                raise HTTPException(422, str(exc)) from exc
            except Exception as exc:
                importer_err = getattr(importer_module, "ImportError_", None)
                if importer_err and isinstance(exc, importer_err):
                    raise HTTPException(422, str(exc)) from exc
                raise HTTPException(422, f"Could not parse GIS layout drawing: {exc}") from exc

            if pdf_file:
                fields.setdefault("import_source", {})["reference_filename"] = pdf_file["name"]
                if existing_boundary and not (companion and companion_extension == ".kml"):
                    # Clip plots to the existing boundary when it's different from the fitting boundary
                    if plot_docs and len(plot_docs) > 0:
                        try:
                            from app.gis.importer import _clip_plots_to_boundary, _plot_boundary_coverage
                            # Since plots are already in WGS84, we use identity transform
                            def to_wgs(x, y):
                                return (x, y)
                            plot_docs = _clip_plots_to_boundary(plot_docs, existing_boundary, to_wgs)
                            coverage = _plot_boundary_coverage(plot_docs, existing_boundary, 0.85)
                            if coverage is not None and coverage < 0.7:
                                warnings.append(
                                    f"Only {round(coverage * 100)}% of plot parcels have at least 85% of their area inside the land boundary after clipping."
                                )
                        except Exception as exc:
                            warnings.append(f"Could not clip plots to boundary: {exc}")
                    
                    fields["boundary"] = existing_boundary
                    fields["map_center"] = _get(colony, "map_center") or fields.get("map_center")
                    if companion_extension == ".kml":
                        warnings.append(
                            "The existing colony land boundary was kept. Plot geometry was extracted from the PDF; KML coordinates were not used to reposition it."
                        )
                    else:
                        warnings.append(
                            "The existing colony land boundary was kept. Plot geometry was extracted from the PDF."
                        )
                if qgis_file:
                    if qgis_boundary_used:
                        warnings.append(
                            "The QGIS file was used only to provide a boundary; its other features were not imported by the Python GIS importer."
                        )
                    else:
                        warnings.append(
                            "The existing colony boundary was kept; QGIS features were not imported by the Python GIS importer."
                        )

            pdf_overlay = None
            if pdf_file:
                overlay_boundary = target_boundary or fields.get("boundary")
                if overlay_boundary:
                    try:
                        is_cad_file = any(
                            pdf_file["name"].lower().endswith(ext)
                            for ext in (".dwg", ".dxf", ".dwf")
                        )
                        selection_info = {
                            "source": "uploaded_kml" if boundary_selection else (
                                "existing_colony_boundary" if existing_boundary else "imported_mapping"
                            ),
                            "kml_sha256": (
                                hashlib.sha256(companion["data"]).hexdigest()
                                if boundary_selection and companion
                                else None
                            ),
                            "selection": boundary_selection,
                        }
                        if is_cad_file:
                            png_data, base_png_data, bounds, fit, plot_regions = await asyncio.to_thread(
                                render_cad_overlay_images,
                                pdf_file["data"],
                                overlay_boundary,
                                selection_info,
                                pdf_file["name"],
                            )
                        else:
                            png_data, base_png_data, bounds, fit, plot_regions = await asyncio.to_thread(
                                render_pdf_overlay_images,
                                pdf_file["data"],
                                overlay_boundary,
                                selection_info,
                            )

                        base_storage_key = build_storage_key(
                            user_id=str(_get(user, "id") or _get(colony, "owner_id") or ""),
                            colony_id=colony_id,
                            category="map_overlay",
                            filename="pdf-map-source.png",
                            doc_id=str(import_id),
                        )
                        storage_key = build_storage_key(
                            user_id=str(_get(user, "id") or _get(colony, "owner_id") or ""),
                            colony_id=colony_id,
                            category="map_overlay",
                            filename="pdf-map.png",
                            doc_id=str(import_id),
                        )
                        try:
                            await asyncio.to_thread(
                                put_object, base_storage_key, base_png_data, "image/png"
                            )
                            await asyncio.to_thread(
                                put_object, storage_key, png_data, "image/png"
                            )
                        except Exception:
                            try:
                                await asyncio.to_thread(delete_object, base_storage_key)
                            except Exception:
                                logger.exception("failed to clean up incomplete layout overlay upload")
                            raise
                        pdf_overlay = {
                            "source_type": "cad" if is_cad_file else "pdf",
                            "storage_key": storage_key,
                            "base_storage_key": base_storage_key,
                            "auto_fit_storage_key": storage_key,
                            "bounds": bounds,
                            "plot_regions": plot_regions,
                            "regions": plot_regions,
                            "plot_count": len(plot_docs) or len(plot_regions) or len(plot_numbers),
                            "fit": fit,
                            "transform": {
                                "rotation_deg": 0,
                                "scale_x": 1,
                                "scale_y": 1,
                                "translation_x_m": 0,
                                "translation_y_m": 0,
                            },
                        }
                        warnings.extend(fit.get("warnings") or [])

                        if plot_docs:
                            warnings.append(
                                f"{len(plot_docs)} individual vector-derived plot geometries were saved. "
                                "They are extracted plan geometry, not surveyed boundary measurements."
                            )
                        elif is_cad_file:
                            warnings.append(
                                "The CAD drawing is fitted to the land boundary, but no verified plot boundaries "
                                "were recovered; no heuristic click regions were saved as plots."
                            )
                        else:
                            warnings.append(
                                "The PDF image is fitted to the land boundary. Any overlay click regions "
                                "are heuristic only and are not saved plot records."
                            )
                    except Exception as exc:
                        raise HTTPException(
                            422, f"Could not crop PDF map to the land boundary: {exc}"
                        ) from exc

            stats = {
                "plots_count": fields.get("import_source", {}).get("pdf_plot_count", len(plot_docs)),
                "zones_count": len(zone_docs),
                "greens_count": len(fields.get("greens") or []),
                "roads_count": len(fields.get("roads") or []),
            }
            if pdf_file:
                stats["detected_pdf_labels"] = fields.get(
                    "import_source", {}
                ).get("pdf_plot_count", 0)
                stats["saved_plot_records"] = len(plot_docs)
                stats["interactive_pdf_regions"] = len(
                    (pdf_overlay or {}).get("plot_regions") or []
                )
            spatial_understanding = None
            qa_report_data = None
            validation_data = {"is_valid": True, "errors": []}
            try:
                from app.gis.spatial_understanding.engine import SpatialUnderstandingEngine
                from app.gis.qa.qa_report import QAReportGenerator

                engine = SpatialUnderstandingEngine()
                pdf_content = (fields.get("import_source") or {}).get("pdf_content") or {}
                graph = engine.process_drawing(
                    plots=plot_docs,
                    roads=fields.get("roads") or [],
                    parks=fields.get("greens") or [],
                    boundaries=[{"id": "site_boundary", "geometry": fields.get("boundary")}] if fields.get("boundary") else None,
                    lines=pdf_content.get("lines"),
                    text_elements=pdf_content.get("texts"),
                )
                spatial_understanding = {
                    "canonical_relationships": [cr.to_dict() for cr in graph.canonical_relationships],
                    "qa_issues": [issue.to_dict() for issue in graph.qa_issues],
                    "answers": engine.answer_semantic_questions(graph),
                }

                qa_gen = QAReportGenerator()
                qa_report_data = qa_gen.generate_qa_report(
                    graph=graph,
                    document_id=str(import_id),
                    filename=source["name"],
                    page_number=1,
                    pdf_bytes=source.get("data") if source["name"].lower().endswith(".pdf") else None,
                    scale_ratio=fields.get("scale_ratio"),
                    enable_recovery=True,
                )
                validation_data = {
                    "is_valid": qa_report_data["validation_passed"],
                    "quality_grade": qa_report_data["quality_grade"],
                    "errors": [f["message"] for f in qa_report_data["findings"] if f["severity"] in ("error", "critical")],
                    "warnings": [f["message"] for f in qa_report_data["findings"] if f["severity"] == "warning"],
                }
            except Exception as exc:
                logger.warning("Spatial understanding and QA processing skipped or failed: %s", exc)

            import_doc = {
                "_id": import_id,
                "owner_id": _get(user, "id"),
                "colony_id": colony_id,
                "filename": source["name"],
                "mime": source["mime"],
                "size": len(source["data"]),
                "status": "PREVIEW_READY",
                "preview_data": {
                    "fields": fields,
                    "zones": zone_docs,
                    "plots": plot_docs,
                    "pdf_overlay": pdf_overlay,
                    "spatial_understanding": spatial_understanding,
                    "qa_report": qa_report_data,
                    "warnings": warnings,
                    "stats": stats,
                },
                "calibration": None,
                "validation": validation_data,
                "created_at": now,
                "updated_at": now,
            }
            await db["gis_imports"].insert_one(import_doc)
            await audit_log(
                user,
                "GIS_IMPORT_CREATED",
                "gis_import",
                str(import_id),
                colony_id=colony_id,
                metadata={"filename": source["name"], "plots_count": len(plot_docs)},
                request=request,
            )
            return {
                "id": str(import_id),
                "colony_id": colony_id,
                "filename": source["name"],
                "status": import_doc["status"],
                "stats": stats,
                "warnings": warnings,
                "created_at": now,
            }

    @router.get("/admin/gis-imports/{importId}")
    async def fetch_import(importId: str, user=Depends(require_admin_dep)):
        _, imp = await get_import(importId)
        await owned_colony(imp["colony_id"], user)
        preview_data = dict(imp.get("preview_data") or {})
        pdf_overlay = preview_data.get("pdf_overlay") or {}
        if pdf_overlay.get("storage_key"):
            preview_data["pdf_overlay"] = {
                "url": get_signed_url(pdf_overlay["storage_key"], 86400),
                "base_url": get_signed_url(
                    pdf_overlay.get("base_storage_key") or pdf_overlay["storage_key"],
                    86400,
                ),
                "bounds": pdf_overlay.get("bounds"),
                "plot_regions": pdf_overlay.get("plot_regions") or [],
                "plot_count": pdf_overlay.get("plot_count"),
                "source_type": pdf_overlay.get("source_type") or (
                    "cad"
                    if str(imp.get("filename") or "").lower().endswith((".dwg", ".dxf", ".dwf"))
                    else "pdf"
                ),
                "fit": pdf_overlay.get("fit"),
                "warnings": (pdf_overlay.get("fit") or {}).get("warnings") or [],
                "transform": pdf_overlay.get("transform") or {
                    "rotation_deg": 0,
                    "scale_x": 1,
                    "scale_y": 1,
                    "translation_x_m": 0,
                    "translation_y_m": 0,
                },
            }
        return {
            "id": str(imp["_id"]),
            "colony_id": imp["colony_id"],
            "filename": imp["filename"],
            "status": imp["status"],
            "preview_data": preview_data,
            "calibration": imp.get("calibration"),
            "validation": imp.get("validation"),
            "created_at": imp.get("created_at"),
            "committed_at": imp.get("committed_at"),
        }

    @router.get("/admin/gis-imports/{importId}/spatial-understanding")
    async def get_spatial_understanding(importId: str, user=Depends(require_admin_dep)):
        _, imp = await get_import(importId)
        await owned_colony(imp["colony_id"], user)
        preview_data = dict(imp.get("preview_data") or {})
        plots = preview_data.get("plots") or []
        fields = preview_data.get("fields") or {}
        roads = fields.get("roads") or []
        greens = fields.get("greens") or []
        boundary = fields.get("boundary")
        pdf_content = (fields.get("import_source") or {}).get("pdf_content") or {}

        from app.gis.spatial_understanding.engine import SpatialUnderstandingEngine
        engine = SpatialUnderstandingEngine()
        graph = engine.process_drawing(
            plots=plots,
            roads=roads,
            parks=greens,
            boundaries=[{"id": "site_boundary", "geometry": boundary}] if boundary else None,
            lines=pdf_content.get("lines"),
            text_elements=pdf_content.get("texts") or preview_data.get("annotations"),
        )
        answers = engine.answer_semantic_questions(graph)
        return {
            "import_id": importId,
            "colony_id": imp["colony_id"],
            "semantic_model": graph.to_dict(),
            "canonical_relationships": [cr.to_dict() for cr in graph.canonical_relationships],
            "answers": answers,
            "qa_issues": [issue.to_dict() for issue in graph.qa_issues],
        }

    @router.get("/admin/gis-imports/{importId}/qa-report")
    async def get_import_qa_report(importId: str, user=Depends(require_admin_dep)):
        _, imp = await get_import(importId)
        await owned_colony(imp["colony_id"], user)
        preview_data = dict(imp.get("preview_data") or {})
        existing_report = preview_data.get("qa_report")
        if existing_report:
            return existing_report

        plots = preview_data.get("plots") or []
        fields = preview_data.get("fields") or {}
        roads = fields.get("roads") or []
        greens = fields.get("greens") or []
        boundary = fields.get("boundary")
        pdf_content = (fields.get("import_source") or {}).get("pdf_content") or {}

        from app.gis.spatial_understanding.engine import SpatialUnderstandingEngine
        from app.gis.qa.qa_report import QAReportGenerator

        engine = SpatialUnderstandingEngine()
        graph = engine.process_drawing(
            plots=plots,
            roads=roads,
            parks=greens,
            boundaries=[{"id": "site_boundary", "geometry": boundary}] if boundary else None,
            lines=pdf_content.get("lines"),
            text_elements=pdf_content.get("texts") or preview_data.get("annotations"),
        )
        qa_gen = QAReportGenerator()
        report = qa_gen.generate_qa_report(
            graph=graph,
            document_id=importId,
            filename=imp.get("filename", "unknown.pdf"),
            page_number=1,
            scale_ratio=fields.get("scale_ratio"),
            enable_recovery=True,
        )
        return report

    @router.post("/admin/gis-imports/{importId}/calibrate")
    async def calibrate_import(importId: str, user=Depends(require_admin_dep)):
        raise HTTPException(
            501,
            "Coordinate recalibration is unsupported. Import a georeferenced PDF/DXF or provide a Google Maps pin during upload.",
        )

    @router.post("/admin/gis-imports/{importId}/validate")
    async def validate_import(importId: str, user=Depends(require_admin_dep)):
        oid, imp = await get_import(importId)
        colony = await owned_colony(imp["colony_id"], user)
        errors = []
        warnings = []
        preview = imp.get("preview_data") or {}
        plots = preview.get("plots") or []
        if not plots and not preview.get("pdf_overlay"):
            errors.append("No plots detected in the GIS import layout drawing")
        numbers_seen, duplicates = set(), set()
        for plot in plots:
            number = _get(plot, "number")
            if number in numbers_seen:
                duplicates.add(number)
            numbers_seen.add(number)
        if duplicates:
            errors.append(
                f"Duplicate plot numbers detected in import: {', '.join(map(str, duplicates))}"
            )
        colony_id = str(_get(colony, "_id"))
        existing_count = await db["plots"].count_documents({"colony_id": colony_id})
        if existing_count:
            warnings.append(
                f"Target colony currently has {existing_count} production plots. Committing will merge preview plots."
            )
        now = now_iso()
        status = "VALIDATED" if not errors else "CALIBRATION_REQUIRED"
        validation = {
            "is_valid": not errors,
            "errors": errors,
            "warnings": warnings,
            "validated_at": now,
        }
        await db["gis_imports"].update_one(
            {"_id": oid},
            {"$set": {"validation": validation, "status": status, "updated_at": now}},
        )
        return {"id": str(imp["_id"]), "status": status, "validation": validation}

    @router.post("/admin/gis-imports/{importId}/commit")
    async def commit_import(importId: str, request: Request, user=Depends(require_admin_dep)):
        oid, imp = await get_import(importId)
        colony = await owned_colony(imp["colony_id"], user)
        if imp.get("status") == "COMMITTED":
            raise HTTPException(400, "Import session already committed to production")
        if not (imp.get("validation") or {}).get("is_valid"):
            raise HTTPException(
                400,
                "Import validation failed. Clear all validation errors before committing.",
            )
        now = now_iso()
        preview = imp.get("preview_data") or {}
        fields = dict(preview.get("fields") or {})
        zone_docs = preview.get("zones") or []
        plot_docs = preview.get("plots") or []
        colony_id = str(_get(colony, "_id"))
        zone_counts = await persist_import_documents(
            db["zones"], zone_docs, now, "zone", colony_id
        )
        plot_counts = await persist_import_documents(
            db["plots"], plot_docs, now, "plot", colony_id
        )
        warnings = list(preview.get("warnings") or [])
        try:
            entrance = roads_module.entrance_fields(
                fields.get("boundary"), [plot.get("geometry") for plot in plot_docs]
            )
            fields.update(entrance or {})
        except Exception as exc:
            logger.exception("GIS import entrance detection failed")
            warning = f"Entrance metadata could not be calculated: {exc}"
            warnings.append(warning)
            fields.setdefault("import_source", {}).setdefault("warnings", []).append(warning)
        update = {
            "boundary": fields.get("boundary"),
            "map_center": fields.get("map_center"),
            "zoom": fields.get("zoom"),
            "entry_road": fields.get("entry_road"),
            "entrance": fields.get("entrance"),
            "entry_centerline": fields.get("entry_centerline"),
            "entry_checked": True,
            "layout_version": fields.get("layout_version"),
            "import_source": fields.get("import_source"),
            "updated_at": now,
        }
        if fields.get("greens"):
            update["greens"] = fields["greens"]
        if fields.get("roads"):
            update["roads"] = fields["roads"]
        if fields.get("maps_link"):
            update["maps_link"] = fields["maps_link"]
        pdf_overlay = preview.get("pdf_overlay")
        if pdf_overlay:
            update["pdf_overlay"] = pdf_overlay
        previous_overlay = _get(colony, "pdf_overlay") or {}
        await db["colonies"].update_one({"_id": ObjectId(colony_id)}, {"$set": update})
        retained_keys = {
            (pdf_overlay or {}).get("storage_key"),
            (pdf_overlay or {}).get("base_storage_key"),
            (pdf_overlay or {}).get("auto_fit_storage_key"),
        }
        for old_key in {
            previous_overlay.get("storage_key"),
            previous_overlay.get("base_storage_key"),
            previous_overlay.get("auto_fit_storage_key"),
        } - retained_keys - {None}:
            try:
                await asyncio.to_thread(delete_object, old_key)
            except Exception:
                logger.exception("old PDF overlay cleanup failed")
        await db["gis_imports"].update_one(
            {"_id": oid},
            {"$set": {"status": "COMMITTED", "committed_at": now, "updated_at": now}},
        )
        await audit_log(
            user,
            "GIS_IMPORT_COMMITTED",
            "gis_import",
            str(imp["_id"]),
            colony_id=colony_id,
            metadata={
                "plots_inserted": plot_counts["inserted"],
                "plots_updated": plot_counts["updated"],
                "zones_inserted": zone_counts["inserted"],
                "zones_updated": zone_counts["updated"],
            },
            request=request,
        )
        canonical_result = None
        try:
            from app.gis.canonical.persistence import commit_canonical_dataset
            canonical_result = await commit_canonical_dataset(
                db=db,
                colony_id=colony_id,
                preview_data=preview,
                source_filename=imp.get("filename", "unknown.pdf"),
                created_by=str(_get(user, "id")),
                now_iso=now,
            )
        except Exception as exc:
            logger.warning("Canonical persistence commit warning: %s", exc)

        commit_resp = {
            "success": True,
            "id": str(imp["_id"]),
            "colony_id": colony_id,
            "status": "COMMITTED",
            "committed_at": now,
            "summary": {
                "plots_inserted": plot_counts["inserted"],
                "zones_inserted": zone_counts["inserted"],
                "plots_updated": plot_counts["updated"],
                "zones_updated": zone_counts["updated"],
            },
            "warnings": warnings,
        }
        if canonical_result:
            commit_resp["canonical"] = canonical_result
        return commit_resp

    @router.post("/admin/gis-imports/{importId}/cancel")
    async def cancel_import(importId: str, request: Request, user=Depends(require_admin_dep)):
        oid, imp = await get_import(importId)
        await owned_colony(imp["colony_id"], user)
        if imp.get("status") == "COMMITTED":
            raise HTTPException(400, "Cannot cancel a committed GIS import")
        preview = imp.get("preview_data") or {}
        pdf_overlay = preview.get("pdf_overlay") or {}
        overlay_keys = {
            pdf_overlay.get("storage_key"),
            pdf_overlay.get("base_storage_key"),
            pdf_overlay.get("auto_fit_storage_key"),
        } - {None}
        for overlay_key in overlay_keys:
            try:
                await asyncio.to_thread(delete_object, overlay_key)
            except Exception:
                logger.exception("cancelled PDF overlay cleanup failed")
        now = now_iso()
        await db["gis_imports"].update_one(
            {"_id": oid}, {"$set": {"status": "CANCELLED", "updated_at": now}}
        )
        await audit_log(
            user,
            "GIS_IMPORT_CANCELLED",
            "gis_import",
            str(imp["_id"]),
            colony_id=imp["colony_id"],
            request=request,
        )
        return {"success": True, "id": str(imp["_id"]), "status": "CANCELLED"}

    from app.gis.canonical.routes import build_canonical_router
    canonical_router = build_canonical_router(
        db=db,
        require_admin_dep=require_admin_dep,
        owned_colony_fn=owned_colony,
        now_iso_fn=now_iso,
    )
    router.include_router(canonical_router)

    from app.gis.pipeline.routes import build_pipeline_job_router
    pipeline_router = build_pipeline_job_router(
        db=db,
        require_admin_dep=require_admin_dep,
        owned_colony_fn=owned_colony,
        now_iso_fn=now_iso,
    )
    router.include_router(pipeline_router)

    return router
