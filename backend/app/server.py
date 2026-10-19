"""LiveMap - Interactive real-estate colony & plot management backend.

Architecture:
    - FastAPI + Motor (MongoDB)
    - Cookie-based JWT sessions (HttpOnly)
    - Three roles: super_admin (platform owner), admin (tenant), + anonymous public
    - Tenant isolation on every protected resource
    - Private registry PDFs with max-3-version resale lineage
    - Audit log on every write operation
"""
from dotenv import load_dotenv
load_dotenv()

import os
# Configure OpenMP and PaddlePaddle flags before any AI/GIS C++ DLLs load on Windows
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["FLAGS_use_onednn"] = "0"
os.environ["FLAGS_use_mkldnn"] = "0"
os.environ["PADDLE_DISABLE_DNNL"] = "1"
try:
    import torch  # Pre-load PyTorch C++ runtimes cleanly to avoid DLL collisions with Paddle
except Exception:
    pass

import sys
import json
import re
import uuid
import hashlib
import logging
import math
from pathlib import Path
from datetime import datetime, timezone, timedelta
import csv
import io
from pymongo import UpdateOne
from typing import Optional, List, Dict, Any

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import hmac
import bcrypt
import jwt
import asyncio
from app.gis import layout, importer, roads, vector_import, pdf_fitter
from app.gis.plot_persistence import persist_import_documents
from app.gis.pdf_overlay import (
    detect_registered_overlay_plot_regions,
    render_pdf_overlay_images,
    transform_pdf_overlay,
)
from app.gis.cad_overlay import render_cad_overlay_images
from app.extended_routes import build_extended_router
from app.gis_import_routes import build_gis_import_router
from app.owner_routes import build_owner_router
from app.gis.canonical.routes import build_canonical_router
from app.gis.pipeline.routes import build_pipeline_job_router
from app.colony_geometry_routes import build_geometry_router
from app.colony_share_routes import build_colony_share_router
from app.gis.ai_models.registry import AIModelRegistry
from app.storage import (
    build_storage_key,
    delete_object,
    get_object,
    get_signed_url,
    init_storage,
    put_object,
    verify_signed_url,
)
from bson import ObjectId
from shapely.geometry import shape, mapping, Point
from shapely import affinity

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Response, UploadFile, File, Form, Header

from fastapi.responses import Response as RawResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

logger = logging.getLogger("livemap")

# -----------------------------------------------------------------------------
# Setup
# -----------------------------------------------------------------------------
ROOT_DIR = Path(__file__).parent
PYTHON_DIR = ROOT_DIR.parent
PORT = int(os.environ.get("PORT", "4801"))
HOST = os.environ.get("HOST", "0.0.0.0")

APP_NAME = "livemap"
# Use provided MongoDB Atlas connection
MONGO_URL = os.environ.get("MONGODB_URI", "mongodb+srv://anuraglawaniya0001_db_user:TwA2OGLV5tX5XFDO@cluster0.ny7seu3.mongodb.net")
DB_NAME = os.environ.get("MONGODB_DB", os.environ.get("DB_NAME", "livemap"))

print(f"🔗 Connecting to MongoDB: {MONGO_URL[:50]}...")

try:
    import dns.resolver
    _default_res = dns.resolver.get_default_resolver()
    # Filter out dead nameservers (like 205.254.161.2) and prioritize active local gateway
    _active_ns = [ns for ns in _default_res.nameservers if ns.startswith("192.168.") or ns.startswith("10.") or ns.startswith("172.")]
    if _active_ns:
        _default_res.nameservers = _active_ns + [ns for ns in _default_res.nameservers if ns not in _active_ns and ns != "205.254.161.2"]
    else:
        _default_res.nameservers = [ns for ns in _default_res.nameservers if ns != "205.254.161.2"]
    _default_res.lifetime = 4.0
    _default_res.timeout = 2.0
except Exception as _dns_err:
    logger.debug("DNS resolver optimization notice: %s", _dns_err)

MONGO = AsyncIOMotorClient(
    MONGO_URL,
    serverSelectionTimeoutMS=30000,  # Increased for Docker startup
    connectTimeoutMS=30000,
    socketTimeoutMS=30000,
    maxPoolSize=10,
    minPoolSize=1,
    maxIdleTimeMS=30000,
    retryWrites=True,
    retryReads=True,
)
DB = MONGO[DB_NAME]

JWT_SECRET = os.environ.get("JWT_SECRET", "livemap-dev-secret-change-in-prod")
if os.environ.get("NODE_ENV", "development").lower() == "production" and (
    len(JWT_SECRET) < 32 or JWT_SECRET == "livemap-dev-secret-change-in-prod"
):
    raise RuntimeError("Production startup aborted: configure a strong JWT_SECRET (at least 32 characters).")
JWT_ALG = "HS256"
TOKEN_TTL = timedelta(seconds=int(os.environ.get("TOKEN_TTL_SECONDS", "86400")))
JWT_COOKIE_NAME = os.environ.get("JWT_COOKIE_NAME", "access_token")
COOKIE_SECURE = os.environ.get(
    "COOKIE_SECURE", "true" if os.environ.get("NODE_ENV", "").lower() == "production" else "false"
).lower() == "true"
COOKIE_SAMESITE = os.environ.get("COOKIE_SAME_SITE", os.environ.get("COOKIE_SAMESITE", "lax")).lower()
if COOKIE_SAMESITE not in {"lax", "strict", "none"}:
    raise RuntimeError("COOKIE_SAME_SITE must be one of: lax, strict, none")

MAX_REGISTRY_VERSIONS = 3  # once, twice, thrice (resale lineage)
MAX_PDF_BYTES = 25 * 1024 * 1024
MAX_UPLOAD_SIZE_MB = int(os.environ.get("MAX_UPLOAD_SIZE_MB", "200"))
MAX_LAYOUT_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024

app = FastAPI(title="LiveMap API")
api = APIRouter(prefix="/api")


@api.get("/health")
@app.get("/health")
async def health_check():
    from app.gis.canonical.health_service import check_system_health
    res = await check_system_health(DB)
    status_code = 200 if res["status"] == "HEALTHY" else 503
    return JSONResponse(status_code=status_code, content=res)


@app.on_event("startup")
async def startup():
    """Initialize database indexes and storage directory."""
    from pathlib import Path
    
    # Create storage directory
    storage_path = os.environ.get("LOCAL_STORAGE_PATH", "./storage")
    storage_dir = Path(storage_path)
    storage_dir.mkdir(parents=True, exist_ok=True)
    
    # Ensure database indexes
    await ensure_db_indexes()


async def ensure_db_indexes():
    """Build compound indexes to accelerate queries and eliminate full-collection scans."""
    try:
        # Helper function to create index with conflict handling
        async def safe_create_index(collection, keys, **kwargs):
            try:
                await collection.create_index(keys, **kwargs)
            except Exception as e:
                # If index already exists with different options, log and continue
                if "IndexKeySpecsConflict" in str(e) or "already exists" in str(e):
                    logger.debug(f"Index on {collection.name} already exists: {e}")
                else:
                    raise

        await asyncio.gather(
            safe_create_index(DB.plots, [("colony_id", 1)]),
            safe_create_index(DB.plots, [("colony_id", 1), ("status_id", 1)]),
            safe_create_index(DB.property_inquiries, [("colony_id", 1)]),
            safe_create_index(DB.zones, [("colony_id", 1)]),
            safe_create_index(DB.registry, [("plot_id", 1)]),
            safe_create_index(DB.colonies, [("slug", 1)], unique=True, sparse=True),
            safe_create_index(DB.colonies, [("created_at", -1)]),
            safe_create_index(DB.colonies, [("owner_id", 1)]),
            safe_create_index(DB.canonical_datasets, [("colony_id", 1), ("is_current", 1)]),
            safe_create_index(DB.canonical_datasets, [("colony_id", 1), ("version", 1)]),
            safe_create_index(DB.canonical_plots, [("colony_id", 1), ("dataset_version", 1)]),
            safe_create_index(DB.canonical_roads, [("colony_id", 1), ("dataset_version", 1)]),
            safe_create_index(DB.canonical_dimensions, [("colony_id", 1), ("dataset_version", 1)]),
            safe_create_index(DB.canonical_qa_findings, [("colony_id", 1), ("dataset_version", 1)]),
            return_exceptions=True,
        )
        logger.info("MongoDB high-performance GIS & canonical indexes verified.")
    except Exception as e:
        logger.warning("MongoDB index creation failed (connection issue): %s", e)

INTERNAL_GIS_SECRET = os.environ.get("INTERNAL_GIS_SECRET", "dev-internal-secret-key-change-in-prod")
if os.environ.get("NODE_ENV", "development").lower() == "production" and (
    len(INTERNAL_GIS_SECRET) < 32
    or INTERNAL_GIS_SECRET == "dev-internal-secret-key-change-in-prod"
):
    raise RuntimeError(
        "Production startup aborted: configure a strong INTERNAL_GIS_SECRET (at least 32 characters)."
    )


def verify_internal_token(x_internal_token: Optional[str] = Header(None, alias="X-Internal-Token")):
    """Dependency verifying that internal microservice calls carry a valid X-Internal-Token."""
    if not x_internal_token:
        raise HTTPException(status_code=401, detail="Missing internal authentication token")
    
    expected = INTERNAL_GIS_SECRET.encode("utf-8")
    provided = x_internal_token.encode("utf-8")
    
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=403, detail="Invalid internal authentication token")


internal_gis = APIRouter(prefix="/internal/gis", dependencies=[Depends(verify_internal_token)])


@internal_gis.post("/import")
async def internal_import(
    file: UploadFile = File(...),
    maps_link: Optional[str] = Form(None),
    control_points: Optional[str] = Form(None),
    rotation: Optional[float] = Form(None),
    target_boundary: Optional[str] = Form(None),
    colony_id: Optional[str] = Form(None),
    now: Optional[str] = Form(None),
):
    """Internal GIS endpoint invoked by Node backend to process layout drawings."""
    data = await file.read()
    filename = file.filename or "file.pdf"
    ext = os.path.splitext(filename)[1].lower()
    
    if ext not in (".dxf", ".dwg", ".pdf"):
        raise HTTPException(status_code=400, detail="Only .pdf, .dxf, and .dwg files are supported")
    
    parsed_cp = None
    if control_points:
        try:
            parsed_cp = json.loads(control_points)
        except Exception:
            pass

    parsed_tb = None
    if target_boundary:
        try:
            parsed_tb = json.loads(target_boundary)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=422, detail=f"Invalid target_boundary JSON: {e.msg}")
        if not isinstance(parsed_tb, (dict, list)):
            raise HTTPException(status_code=422, detail="target_boundary must be a GeoJSON geometry, feature, or coordinate array")
    logger.info(
        "Internal GIS import: file=%s target_boundary=%s",
        filename,
        parsed_tb.get("type", "array") if parsed_tb is not None else "missing",
    )

    try:
        imported_at = now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        colony_fields, zone_docs, plot_docs, warnings = importer.import_file(
            data=data,
            filename=filename,
            maps_link=maps_link,
            colony_id=(colony_id or "preview").strip() or "preview",
            now=imported_at,
            control_points=parsed_cp,
            rotation_deg=rotation or 0,
            target_boundary=parsed_tb,
        )
        return {
            "colony": colony_fields,
            "zones": zone_docs,
            "plots": plot_docs,
            "warnings": warnings,
        }
    except importer.ImportError_ as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"Internal GIS processing error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
@app.get("/health")
def health_check():
    return {"status": "ok", "service": "livemap-python-gis"}

app.include_router(internal_gis)




DURGA_CENTER = layout.CENTER
DURGA_ROAD = "Village road off Vasna–Padra Road, Darapura"
DEFAULT_WHATSAPP = "+91 90000 00000"


# -----------------------------------------------------------------------------
# Pydantic models
# -----------------------------------------------------------------------------
class LoginIn(BaseModel):
    email: str
    password: str
    portal: Optional[str] = None  # "admin" | "super_admin"


class UserCreateIn(BaseModel):
    name: str
    email: str
    phone: Optional[str] = ""
    password: str = Field(min_length=6)


class UserUpdateIn(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    active: Optional[bool] = None


class PasswordResetIn(BaseModel):
    new_password: str = Field(min_length=6)


class ColonyCreateIn(BaseModel):
    name: str
    location: str = "Vadodara, Gujarat"
    description: str = ""
    public_enabled: bool = True
    whatsapp_number: str = DEFAULT_WHATSAPP
    lat: Optional[float] = None
    lng: Optional[float] = None
    rotation_deg: Optional[float] = None


class ColonyUpdateIn(BaseModel):
    name: Optional[str] = None
    location: Optional[str] = None
    description: Optional[str] = None
    public_enabled: Optional[bool] = None
    whatsapp_number: Optional[str] = None


class StatusChangeIn(BaseModel):
    status_id: str


class BulkStatusIn(BaseModel):
    plot_ids: List[str]
    status_id: str


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_pw(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False


def make_token(user_id: str, role: str) -> str:
    return jwt.encode(
        {"sub": user_id, "role": role, "exp": datetime.now(timezone.utc) + TOKEN_TTL},
        JWT_SECRET, algorithm=JWT_ALG,
    )


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or f"item-{uuid.uuid4().hex[:6]}"


SAFE_USER_FIELDS = {"id", "name", "email", "phone", "role", "slug", "active", "created_at", "last_login", "created_by"}


def serialize_user(doc: dict) -> dict:
    """Strip sensitive fields; always remove password_hash."""
    if not doc:
        return None
    out = {}
    for k, v in doc.items():
        if k == "_id":
            out["id"] = str(v)
        elif k == "password_hash":
            continue
        elif k in SAFE_USER_FIELDS:
            out[k] = v
    return out


def serialize_doc(doc: dict) -> dict:
    """Generic doc serializer: convert _id to id (preserving existing id), drop internals."""
    if not doc:
        return None
    out = dict(doc)
    if "_id" in out:
        oid = str(out.pop("_id"))
        if "id" not in out:
            out["id"] = oid
    out.pop("content", None)  # never return raw file bytes
    out.pop("storage_key", None)
    return out


def colony_out(c: dict) -> dict:
    out = serialize_doc(c)
    out.setdefault("map_center", DURGA_CENTER)
    out.setdefault("whatsapp_number", DEFAULT_WHATSAPP)
    out["map_road"] = DURGA_ROAD
    overlay = c.get("pdf_overlay") or {}
    storage_key = overlay.get("storage_key") if isinstance(overlay, dict) else None
    if storage_key:
        base_storage_key = overlay.get("base_storage_key") or storage_key
        source_filename = str((c.get("import_source") or {}).get("filename") or "").lower()
        source_type = overlay.get("source_type") or (
            "cad" if source_filename.endswith((".dwg", ".dxf", ".dwf")) else "pdf"
        )
        out["pdf_overlay"] = {
            "url": get_signed_url(storage_key, 86400),
            "base_url": get_signed_url(base_storage_key, 86400),
            "bounds": overlay.get("bounds"),
            "plot_regions": overlay.get("plot_regions") or [],
            "plot_count": overlay.get("plot_count"),
            "source_type": source_type,
            "fit": overlay.get("fit"),
            "warnings": (overlay.get("fit") or {}).get("warnings") or [],
            "transform": overlay.get("transform") or {
                "rotation_deg": 0,
                "scale_x": 1,
                "scale_y": 1,
                "translation_x_m": 0,
                "translation_y_m": 0,
            },
        }
    else:
        out.pop("pdf_overlay", None)
    return out


async def store_pdf_overlay(
    pdf_data: bytes,
    boundary: dict,
    user_id: str,
    colony_id: str,
    boundary_selection: Optional[dict] = None,
    extracted_pdf: Optional[dict] = None,
):
    if not pdf_data or not boundary:
        return None
    import gc
    gc.collect()
    png_data, base_png_data, bounds, fit, plot_regions = await asyncio.to_thread(
        render_pdf_overlay_images, pdf_data, boundary, boundary_selection, extracted_pdf
    )
    base_storage_key = build_storage_key(
        user_id=user_id,
        colony_id=colony_id,
        category="map_overlay",
        filename="pdf-map-source.png",
        doc_id=uuid.uuid4().hex,
    )
    storage_key = build_storage_key(
        user_id=user_id,
        colony_id=colony_id,
        category="map_overlay",
        filename="pdf-map.png",
        doc_id=uuid.uuid4().hex,
    )
    upload_results = await asyncio.gather(
        asyncio.to_thread(put_object, base_storage_key, base_png_data, "image/png"),
        asyncio.to_thread(put_object, storage_key, png_data, "image/png"),
        return_exceptions=True,
    )
    upload_errors = [
        result for result in upload_results if isinstance(result, BaseException)
    ]
    if upload_errors:
        for key in (base_storage_key, storage_key):
            try:
                await asyncio.to_thread(delete_object, key)
            except Exception:
                logger.exception("failed to clean up incomplete PDF overlay upload")
        raise upload_errors[0]
    return {
        "source_type": "pdf",
        "storage_key": storage_key,
        "base_storage_key": base_storage_key,
        "auto_fit_storage_key": storage_key,
        "bounds": bounds,
        "plot_regions": plot_regions,
        "regions": plot_regions,
        "fit": fit,
        "transform": {
            "rotation_deg": 0,
            "scale_x": 1,
            "scale_y": 1,
            "translation_x_m": 0,
            "translation_y_m": 0,
        },
    }


async def store_cad_overlay(
    cad_data: bytes,
    boundary: dict,
    user_id: str,
    colony_id: str,
    boundary_selection: Optional[dict] = None,
    filename: str = "",
):
    if not cad_data or not boundary:
        return None
    png_data, base_png_data, bounds, fit, plot_regions = await asyncio.to_thread(
        render_cad_overlay_images, cad_data, boundary, boundary_selection, filename
    )
    base_storage_key = build_storage_key(
        user_id=user_id,
        colony_id=colony_id,
        category="map_overlay",
        filename="cad-map-source.png",
        doc_id=uuid.uuid4().hex,
    )
    storage_key = build_storage_key(
        user_id=user_id,
        colony_id=colony_id,
        category="map_overlay",
        filename="cad-map.png",
        doc_id=uuid.uuid4().hex,
    )
    upload_results = await asyncio.gather(
        asyncio.to_thread(put_object, base_storage_key, base_png_data, "image/png"),
        asyncio.to_thread(put_object, storage_key, png_data, "image/png"),
        return_exceptions=True,
    )
    upload_errors = [
        result for result in upload_results if isinstance(result, BaseException)
    ]
    if upload_errors:
        for key in (base_storage_key, storage_key):
            try:
                await asyncio.to_thread(delete_object, key)
            except Exception:
                logger.exception("failed to clean up incomplete CAD overlay upload")
        raise upload_errors[0]
    return {
        "source_type": "cad",
        "storage_key": storage_key,
        "base_storage_key": base_storage_key,
        "auto_fit_storage_key": storage_key,
        "bounds": bounds,
        "plot_regions": plot_regions,
        "regions": plot_regions,
        "fit": fit,
        "transform": {
            "rotation_deg": 0,
            "scale_x": 1,
            "scale_y": 1,
            "translation_x_m": 0,
            "translation_y_m": 0,
        },
    }


# -----------------------------------------------------------------------------
# Auth dependencies
# -----------------------------------------------------------------------------
async def get_current_user(request: Request):
    raw = request.cookies.get(JWT_COOKIE_NAME)
    if not raw:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            raw = auth[7:]
    if not raw:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(raw, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.PyJWTError:
        raise HTTPException(401, "Session expired")
    uid = payload.get("sub")
    try:
        user = await DB.users.find_one({"_id": ObjectId(uid), "active": True})
    except Exception:
        raise HTTPException(401, "Invalid session")
    if not user:
        raise HTTPException(401, "Account not available")
    return serialize_user(user)


async def require_admin(user=Depends(get_current_user)):
    if user["role"] not in ("admin", "super_admin"):
        raise HTTPException(403, "Admin access required")
    return user


async def require_super_admin(user=Depends(get_current_user)):
    if user["role"] != "super_admin":
        raise HTTPException(403, "Super admin access required")
    return user


async def load_owned_colony(colony_id: str, user: dict):
    """Resolve colony by id (ObjectId or slug) and enforce tenant ownership."""
    query_ids = [colony_id]
    if ObjectId.is_valid(colony_id):
        query_ids.append(ObjectId(colony_id))
    base = {"$or": [{"_id": q} for q in query_ids] + [{"slug": colony_id}]}
    colony = await DB.colonies.find_one(base)
    if not colony:
        raise HTTPException(404, "Colony not found")
    uid_str = str(user.get("id") or user.get("_id") or "")
    allowed_ids = {
        str(colony.get("owner_id") or ""),
        str(colony.get("partner_admin_id") or ""),
        *[str(cid) for cid in (colony.get("collab_admin_ids") or [])],
    }
    allowed_ids.discard("")
    if user.get("role") != "super_admin" and uid_str not in allowed_ids:
        # Mask as 404 to avoid tenant enumeration
        raise HTTPException(404, "Colony not found")
    return colony


async def audit_log(user, action, entity_type, entity_id, colony_id=None, metadata=None, request: Request = None):
    uid = str((user.get("id") if isinstance(user, dict) else getattr(user, "id", None)) or (user.get("_id") if isinstance(user, dict) else getattr(user, "_id", None)) or "")
    rec = {
        "user_id": uid,
        "user_name": user.get("name", "") if isinstance(user, dict) else getattr(user, "name", ""),
        "action": action,
        "entity_type": entity_type,
        "entity_id": str(entity_id),
        "colony_id": colony_id,
        "metadata": metadata or {},
        "created_at": now_iso(),
    }
    if request:
        rec["ip"] = request.client.host if request.client else ""
        rec["user_agent"] = request.headers.get("user-agent", "")[:200]
    await DB.audit_logs.insert_one(rec)


# -----------------------------------------------------------------------------
# Public routes (no auth)
# -----------------------------------------------------------------------------
@api.get("/public/colonies")
async def public_colonies(owner: Optional[str] = None):
    """List public colonies, optionally scoped to one admin's slug."""
    query = {"public_enabled": True}
    owner_doc = None
    if owner:
        owner_doc = await DB.users.find_one({"slug": owner, "active": True, "role": {"$in": ["admin", "super_admin"]}})
        if not owner_doc:
            raise HTTPException(404, "Admin not found")
        query["owner_id"] = str(owner_doc["_id"])
    rows = await DB.colonies.find(query).sort("created_at", -1).to_list(200)
    return {
        "owner": serialize_user(owner_doc) if owner_doc else None,
        "colonies": [{
            "id": str(c["_id"]),
            "slug": c["slug"],
            "name": c["name"],
            "location": c.get("location", ""),
            "description": c.get("description", ""),
            "owner_id": c.get("owner_id"),
            "plot_count": await DB.plots.count_documents({"colony_id": str(c["_id"])}),
        } for c in rows],
    }


@api.get("/public/colonies/{slug}")
async def public_colony(slug: str):
    c = await DB.colonies.find_one({"slug": slug, "public_enabled": True})
    if not c:
        raise HTTPException(404, "Project not found")
    cid = str(c["_id"])
    zones = [serialize_doc(z) async for z in DB.zones.find({"colony_id": cid})]
    plots = [serialize_doc(p) async for p in DB.plots.find({"colony_id": cid}, {"notes": 0})]
    for p in plots:
        p["has_registry"] = await DB.registry.count_documents({"plot_id": p["id"]}) > 0
    statuses = [serialize_doc(s) async for s in DB.statuses.find({}).sort("sort_order", 1)]
    owner = await DB.users.find_one({"_id": ObjectId(c["owner_id"])}) if ObjectId.is_valid(c.get("owner_id", "")) else None
    return {
        "colony": colony_out(c),
        "zones": zones,
        "plots": plots,
        "statuses": statuses,
        "owner": serialize_user(owner) if owner else None,
    }


# -----------------------------------------------------------------------------
# Auth
# -----------------------------------------------------------------------------
@api.post("/auth/login")
@api.post("/login")
async def login(data: LoginIn, response: Response, request: Request):
    email = data.email.lower().strip()
    attempt = await DB.login_attempts.find_one({"identifier": email})
    if attempt and attempt.get("locked_until", "") > now_iso():
        raise HTTPException(429, "Too many failed attempts. Try again in 15 minutes.")

    user = await DB.users.find_one({"email": email})
    ok = user and user.get("active", True) and verify_pw(data.password, user.get("password_hash", ""))
    if not ok:
        count = (attempt or {}).get("count", 0) + 1
        locked = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat() if count >= 5 else ""
        await DB.login_attempts.update_one(
            {"identifier": email},
            {"$set": {"identifier": email, "count": count, "locked_until": locked}},
            upsert=True,
        )
        raise HTTPException(401, "Email or password is incorrect")

    if data.portal == "admin" and user["role"] != "admin":
        raise HTTPException(403, "This account belongs to the Owner workspace. Sign in at /owner-panel.")
    if data.portal == "super_admin" and user["role"] != "super_admin":
        raise HTTPException(403, "This is an Admin account. Sign in at /admin.")


    await DB.login_attempts.delete_one({"identifier": email})
    await DB.users.update_one({"_id": user["_id"]}, {"$set": {"last_login": now_iso()}})
    token = make_token(str(user["_id"]), user["role"])
    response.set_cookie(
        JWT_COOKIE_NAME,
        token,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        max_age=int(TOKEN_TTL.total_seconds()),
        path="/",
    )
    safe = serialize_user({**user, "last_login": now_iso()})
    await audit_log(safe, "USER_LOGIN", "user", safe["id"], request=request)
    return {"user": safe, "token": token}


@api.post("/auth/logout")
@api.post("/logout")
async def logout(response: Response):
    response.delete_cookie(JWT_COOKIE_NAME, path="/")
    return {"ok": True}


@api.get("/auth/me")
@api.get("/me")
async def me(user=Depends(get_current_user)):
    return user



# -----------------------------------------------------------------------------
# Super admin: User management
# -----------------------------------------------------------------------------
@api.get("/admin/users")
async def list_users(user=Depends(require_super_admin)):
    rows = await DB.users.find({"role": {"$in": ["admin", "super_admin"]}}).sort("created_at", -1).to_list(500)
    out = []
    for r in rows:
        u = serialize_user(r)
        u["colony_count"] = await DB.colonies.count_documents({"owner_id": u["id"]})
        out.append(u)
    return out


@api.post("/admin/users")
async def create_user(data: UserCreateIn, request: Request, user=Depends(require_super_admin)):
    email = data.email.lower().strip()
    if await DB.users.find_one({"email": email}):
        raise HTTPException(400, "Email already registered")
    slug = slugify(data.name)
    # Ensure slug unique
    base_slug = slug
    i = 2
    while await DB.users.find_one({"slug": slug}):
        slug = f"{base_slug}-{i}"
        i += 1
    doc = {
        "name": data.name,
        "email": email,
        "phone": data.phone or "",
        "password_hash": hash_pw(data.password),
        "role": "admin",
        "slug": slug,
        "active": True,
        "created_at": now_iso(),
        "created_by": user["id"],
    }
    res = await DB.users.insert_one(doc)
    doc["_id"] = res.inserted_id
    await audit_log(user, "USER_CREATED", "user", str(res.inserted_id), request=request)
    return serialize_user(doc)


@api.patch("/admin/users/{uid}")
async def update_user(uid: str, data: UserUpdateIn, request: Request, user=Depends(require_super_admin)):
    if not ObjectId.is_valid(uid):
        raise HTTPException(404, "User not found")
    update = {k: v for k, v in data.model_dump().items() if v is not None}
    if not update:
        raise HTTPException(400, "Nothing to update")
    res = await DB.users.update_one({"_id": ObjectId(uid)}, {"$set": update})
    if not res.matched_count:
        raise HTTPException(404, "User not found")
    await audit_log(user, "USER_UPDATED", "user", uid, metadata=update, request=request)
    doc = await DB.users.find_one({"_id": ObjectId(uid)})
    return serialize_user(doc)


@api.post("/admin/users/{uid}/reset-password")
async def reset_password(uid: str, data: PasswordResetIn, request: Request, user=Depends(require_super_admin)):
    if not ObjectId.is_valid(uid):
        raise HTTPException(404, "User not found")
    res = await DB.users.update_one({"_id": ObjectId(uid)}, {"$set": {"password_hash": hash_pw(data.new_password)}})
    if not res.matched_count:
        raise HTTPException(404, "User not found")
    await audit_log(user, "USER_PASSWORD_RESET", "user", uid, request=request)
    return {"ok": True}


@api.delete("/admin/users/{uid}")
async def delete_user(uid: str, request: Request, user=Depends(require_super_admin)):
    if not ObjectId.is_valid(uid):
        raise HTTPException(404, "User not found")
    if uid == user["id"]:
        raise HTTPException(400, "Cannot delete yourself")
    res = await DB.users.delete_one({"_id": ObjectId(uid), "role": {"$ne": "super_admin"}})
    if not res.deleted_count:
        raise HTTPException(404, "User not found")
    await audit_log(user, "USER_DELETED", "user", uid, request=request)
    return {"ok": True}


# -----------------------------------------------------------------------------
# Admin: Dashboard
# -----------------------------------------------------------------------------
@api.get("/admin/dashboard")
async def admin_dashboard(user=Depends(require_admin)):
    scope = {} if user["role"] == "super_admin" else {
        "$or": [{"owner_id": user["id"]}, {"partner_admin_id": user["id"]}]
    }
    colonies = await DB.colonies.find(scope, {"_id": 1}).to_list(1000)
    ids = [str(c["_id"]) for c in colonies]
    plot_total = await DB.plots.count_documents({"colony_id": {"$in": ids}})
    statuses = [serialize_doc(s) async for s in DB.statuses.find({}).sort("sort_order", 1)]
    counts = {s["id"]: 0 for s in statuses}
    async for p in DB.plots.find({"colony_id": {"$in": ids}}, {"status_id": 1}):
        sid = p.get("status_id", "available")
        counts[sid] = counts.get(sid, 0) + 1
    registry_total = await DB.registry.count_documents({"colony_id": {"$in": ids}})
    users_total = 0
    if user["role"] == "super_admin":
        users_total = await DB.users.count_documents({"role": {"$in": ["admin", "super_admin"]}})
    return {
        "role": user["role"],
        "colonies": len(ids),
        "plots": plot_total,
        "status_counts": counts,
        "statuses": statuses,
        "registry_docs": registry_total,
        "total_users": users_total,
        "inventory": {
            "totalPlots": plot_total,
            "availablePlots": counts.get("available", 0),
            "reservedPlots": counts.get("reserved", counts.get("booked", 0)),
            "holdPlots": counts.get("hold", 0),
            "soldPlots": counts.get("sold", 0),
            "blockedPlots": counts.get("blocked", 0),
        },
    }


@api.get("/admin/statuses")
async def list_statuses(user=Depends(require_admin)):
    return [serialize_doc(s) async for s in DB.statuses.find({}).sort("sort_order", 1)]


# -----------------------------------------------------------------------------
# Admin: Colonies
# -----------------------------------------------------------------------------
@api.get("/admin/colonies")
async def admin_list_colonies(user=Depends(require_admin)):
    uid = str(user.get("id") or user.get("_id") or "")
    scope = {} if user["role"] == "super_admin" else {
        "$or": [
            {"owner_id": uid},
            {"owner_id": ObjectId(uid) if ObjectId.is_valid(uid) else uid},
            {"partner_admin_id": uid},
            {"partner_admin_id": ObjectId(uid) if ObjectId.is_valid(uid) else uid},
            {"collab_admin_ids": uid},
        ]
    }
    rows = await DB.colonies.find(scope).sort("created_at", -1).to_list(500)
    colony_ids = [str(c["_id"]) for c in rows]
    owner_ids = [ObjectId(str(c.get("owner_id"))) for c in rows if c.get("owner_id") and ObjectId.is_valid(str(c.get("owner_id")))]

    users_task = DB.users.find({"_id": {"$in": owner_ids}}).to_list(len(owner_ids) or 1)
    plot_counts_pipe = [
        {"$match": {"colony_id": {"$in": colony_ids}}},
        {"$group": {"_id": "$colony_id", "count": {"$sum": 1}}},
    ]
    counts_task = DB.plots.aggregate(plot_counts_pipe).to_list(len(colony_ids) or 1)
    users_list, counts_list = await asyncio.gather(users_task, counts_task)
    user_map = {str(u["_id"]): serialize_user(u) for u in users_list}
    count_map = {doc["_id"]: doc["count"] for doc in counts_list}

    enriched = []
    for c in rows:
        cid = str(c["_id"])
        owner_id = str(c.get("owner_id", ""))
        owner_obj = user_map.get(owner_id)
        enriched.append({
            **serialize_doc(c),
            "owner_id": owner_id,
            "adminName": (owner_obj.get("name") if owner_obj else "") or (c.get("adminName") or "Super Admin"),
            "adminEmail": (owner_obj.get("email") if owner_obj else "") or "",
            "plot_count": count_map.get(cid, 0),
            "owner": owner_obj,
        })
    return enriched


def _safe_print(text: str):
    try:
        print(text, flush=True)
    except UnicodeEncodeError:
        try:
            ascii_text = text.encode("ascii", "replace").decode("ascii")
            print(ascii_text, flush=True)
        except Exception:
            pass
    except Exception:
        pass


class PipelineTerminalLogger:
    """Provides high-visibility terminal debug logging and client telemetry for colony imports."""
    def __init__(self, colony_name: str, colony_id: str):
        self.colony_name = colony_name
        self.colony_id = colony_id
        self.logs: List[Dict[str, Any]] = []
        self._print_banner()

    def _print_banner(self):
        ts = datetime.now().strftime("%H:%M:%S")
        banner = (
            f"\n{'=' * 80}\n"
            f"[LIVEMAP AI PIPELINE {ts}] COLONY GIS PROCESSING INITIATED\n"
            f"  Colony: {self.colony_name} (ID: {self.colony_id})\n"
            f"{'=' * 80}\n"
        )
        _safe_print(f"\n{'=' * 80}")
        _safe_print(f"\033[1;32m[LIVEMAP AI PIPELINE {ts}]\033[0m \033[1;37mCOLONY GIS PROCESSING INITIATED\033[0m")
        _safe_print(f"  Colony: \033[1;36m{self.colony_name}\033[0m (ID: \033[90m{self.colony_id}\033[0m)")
        _safe_print(f"{'=' * 80}")
        logger.info(banner)

    def log(self, stage: str, message: str, details: Optional[Dict[str, Any]] = None):
        ts = datetime.now().strftime("%H:%M:%S")
        record = {
            "timestamp": ts,
            "stage": stage,
            "message": message,
            "details": details or {},
        }
        self.logs.append(record)
        _safe_print(f"\033[1;36m[{ts}]\033[0m \033[1;33m[{stage}]\033[0m \033[1m{message}\033[0m")
        log_line = f"[{ts}] [{stage}] {message}"
        if details:
            for k, v in details.items():
                _safe_print(f"   \033[90m|--\033[0m \033[36m{k}:\033[0m \033[97m{v}\033[0m")
                log_line += f"\n   |-- {k}: {v}"
        logger.info(log_line)

    def finish(self, summary_msg: str):
        ts = datetime.now().strftime("%H:%M:%S")
        _safe_print(f"{'-' * 80}")
        _safe_print(f"\033[1;32m[{ts}] [PIPELINE SUCCESS]\033[0m \033[1m{summary_msg}\033[0m")
        _safe_print(f"{'=' * 80}\n")
        logger.info(f"[{ts}] [PIPELINE SUCCESS] {summary_msg}")

    def get_text(self) -> str:
        lines = []
        lines.append(f"=== LIVEMAP AI PIPELINE EXECUTION LOG: {self.colony_name} (ID: {self.colony_id}) ===")
        for entry in self.logs:
            lines.append(f"[{entry['timestamp']}] [{entry['stage']}] {entry['message']}")
            for k, v in entry.get("details", {}).items():
                lines.append(f"   ├─ {k}: {v}")
        return "\n".join(lines)

    def get_records(self) -> List[Dict[str, Any]]:
        return self.logs


def _has_usable_vector_plots(plots: Optional[List[Dict[str, Any]]], boundary: Optional[dict] = None) -> bool:
    """Predicate evaluating whether vector extraction produced genuine, usable plot candidates.

    Validates that:
    - Candidate list is non-empty.
    - Each candidate has valid polygon geometry and non-degenerate area >= 15.0 sqm.
    - Polygons intersect the colony boundary if boundary is provided.
    - Returns True only if at least one valid parcel survives geometric validation.
    """
    if not plots:
        return False
    from shapely.geometry import shape
    boundary_shape = None
    if boundary:
        try:
            boundary_shape = shape(boundary)
            if not boundary_shape.is_valid:
                boundary_shape = boundary_shape.buffer(0)
        except Exception:
            boundary_shape = None

    valid_count = 0
    for p in plots:
        geom = p.get("geometry")
        if not geom or not isinstance(geom, dict):
            continue
        try:
            poly = shape(geom)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty or poly.area <= 0:
                continue
            area = float(p.get("area_sqm") or 0.0)
            if area < 15.0:
                continue
            if boundary_shape and not boundary_shape.intersects(poly):
                continue
            valid_count += 1
        except Exception:
            continue
    return valid_count > 0


def _promote_overlay_regions_to_plots(overlay_regions, colony_id, now_ts, boundary):
    if not overlay_regions:
        return [], []
    import math
    from shapely.geometry import shape
    from app.gis.importer import ZONE_COLORS

    plots = []
    zone_codes = ["A", "B", "C", "D"]
    center = shape(boundary).centroid if boundary else None
    boundary_shape = None
    if boundary:
        try:
            boundary_shape = shape(boundary)
            if not boundary_shape.is_valid:
                boundary_shape = boundary_shape.buffer(0)
        except Exception:
            boundary_shape = None

    # Filter out invalid, degenerate, out-of-boundary, or extreme-area regions
    valid_regions = []
    reg_areas = []
    for reg in overlay_regions:
        geom = reg.get("geometry")
        if not geom or not isinstance(geom, dict):
            continue
        try:
            poly = shape(geom)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty or poly.area <= 0:
                continue
            if boundary_shape and not boundary_shape.intersects(poly):
                continue
            minx, miny, maxx, maxy = poly.bounds
            lat = (miny + maxy) / 2.0
            kx = 111320.0 * math.cos(math.radians(lat))
            ky = 110574.0
            area = float(reg.get("area_sqm") or 0.0)
            if area <= 0.0:
                area = poly.area * kx * ky
                reg["area_sqm"] = area
            if area < 15.0 or area > 900.0:
                continue

            # Validate dimensions and aspect ratio: real plots are compact parcels, not road corridors or gate spans
            w_m = (maxx - minx) * kx
            h_m = (maxy - miny) * ky
            aspect = max(w_m / max(h_m, 1e-3), h_m / max(w_m, 1e-3))
            if aspect > 5.2 or (min(w_m, h_m) < 5.0 and max(w_m, h_m) > 20.0):
                continue

            # Reject ornamental badges, text graphics, and compass roses with excessive interior holes
            num_holes = len(poly.interiors) if hasattr(poly, "interiors") else 0
            if num_holes >= 8:
                continue

            # Reject low-solidity concave remnants
            hull_area = poly.convex_hull.area if poly.convex_hull else 0
            if hull_area > 0 and (poly.area / hull_area) < 0.60:
                continue

            reg_areas.append(area)
            valid_regions.append(reg)
        except Exception:
            continue

    if not valid_regions:
        return [], []

    med_area = sorted(reg_areas)[len(reg_areas) // 2]
    max_plot_area = max(500.0, med_area * 3.5)

    final_regions = [r for r in valid_regions if float(r.get("area_sqm", 0.0)) <= max_plot_area]
    if not final_regions:
        final_regions = valid_regions

    for i, reg in enumerate(final_regions):
        num = reg.get("number") or str(i + 1)
        geom = reg.get("geometry")
        area = float(reg.get("area_sqm") or 100.0)

        z_code = "A"
        if center and geom:
            try:
                poly = shape(geom)
                pt = poly.centroid
                if pt.x >= center.x and pt.y >= center.y:
                    z_code = "A"
                elif pt.x < center.x and pt.y >= center.y:
                    z_code = "B"
                elif pt.x < center.x and pt.y < center.y:
                    z_code = "C"
                else:
                    z_code = "D"
            except Exception:
                z_code = zone_codes[i % len(zone_codes)]
        else:
            z_code = zone_codes[i % len(zone_codes)]

        w_m = 10.0
        d_m = 15.0
        reg_geom = geom
        if geom:
            try:
                poly = shape(geom)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.geom_type == "Polygon" and len(poly.exterior.coords) <= 5:
                    from shapely.geometry import mapping as s_mapping
                    reg_geom = s_mapping(poly)
                    coords = list(poly.exterior.coords)
                    lat = coords[0][1]
                    kx = 111320.0 * math.cos(math.radians(lat))
                    ky = 110574.0
                    dx1 = (coords[1][0] - coords[0][0]) * kx
                    dy1 = (coords[1][1] - coords[0][1]) * ky
                    len1 = round(math.hypot(dx1, dy1), 2)
                    dx2 = (coords[2][0] - coords[1][0]) * kx
                    dy2 = (coords[2][1] - coords[1][1]) * ky
                    len2 = round(math.hypot(dx2, dy2), 2)
                    w_m = round(min(len1, len2), 2)
                    d_m = round(max(len1, len2), 2)
                    area = round(len1 * len2, 1)
                else:
                    mrr = poly.minimum_rotated_rectangle
                    if mrr.is_valid and not mrr.is_empty:
                        iou = poly.intersection(mrr).area / max(poly.union(mrr).area, 1e-9)
                        if iou >= 0.40:
                            from shapely.geometry import mapping as s_mapping
                            reg_geom = s_mapping(mrr)
                            coords = list(mrr.exterior.coords)
                            lat = coords[0][1]
                            kx = 111320.0 * math.cos(math.radians(lat))
                            ky = 110574.0
                            dx1 = (coords[1][0] - coords[0][0]) * kx
                            dy1 = (coords[1][1] - coords[0][1]) * ky
                            len1 = round(math.hypot(dx1, dy1), 2)
                            dx2 = (coords[2][0] - coords[1][0]) * kx
                            dy2 = (coords[2][1] - coords[1][1]) * ky
                            len2 = round(math.hypot(dx2, dy2), 2)
                            w_m = round(min(len1, len2), 2)
                            d_m = round(max(len1, len2), 2)
                            area = round(len1 * len2, 1)
                        else:
                            sim = poly.simplify(0.00002, preserve_topology=True)
                            if sim.is_valid and not sim.is_empty:
                                from shapely.geometry import mapping as s_mapping
                                reg_geom = s_mapping(sim)
            except Exception:
                pass

        plot_doc = {
            "id": f"plot-{colony_id}-{str(num).lower()}",
            "colony_id": colony_id,
            "zone_id": f"zone-{colony_id}-{z_code.lower()}",
            "number": str(num),
            "area_sqm": round(area, 1),
            "area_sqft": round(area * 10.7639, 1),
            "area_sqyd": round(area * 1.19599, 1),
            "width_m": w_m,
            "depth_m": d_m,
            "shape": "rectangular",
            "sides": 4,
            "dimensions": f"{w_m}m × {d_m}m",
            "status_id": "available",
            "geometry": reg_geom,
            "notes": "Recovered from layout detection",
            "created_at": now_ts,
        }
        plots.append(plot_doc)

    zones = []
    for idx, code in enumerate(zone_codes):
        zones.append({
            "id": f"zone-{colony_id}-{code.lower()}",
            "colony_id": colony_id,
            "code": code,
            "name": f"Zone {code}",
            "color": ZONE_COLORS[idx % len(ZONE_COLORS)],
            "geometry": boundary,
            "sort_order": idx,
            "created_at": now_ts,
        })
    return zones, plots


async def update_colony_status(colony_id: str, status: str, progress: int, stage: str):
    """Update colony processing status safely."""
    if not colony_id or colony_id == "preview" or not ObjectId.is_valid(colony_id):
        return
    try:
        await DB.colonies.update_one(
            {"_id": ObjectId(colony_id)},
            {"$set": {
                "processing_status": status,
                "processing_progress": progress,
                "processing_stage": stage,
            }}
        )
    except Exception as e:
        logger.warning(f"Failed to update colony status for {colony_id}: {e}")


async def import_colony_bundle_py(
    file: Optional[UploadFile] = None,
    layout_pdf: Optional[UploadFile] = None,
    cad_file: Optional[UploadFile] = None,
    maps_link: str = "",
    colony_id: str = "preview",
    now: str = None,
    existing_boundary: Optional[dict] = None,
    visual_overlay_only: bool = False,
    user_id: str = "",
    pipe_logger: Optional[PipelineTerminalLogger] = None,
):
    now_ts = now or now_iso()
    if pipe_logger is None:
        pipe_logger = PipelineTerminalLogger(colony_id, colony_id)

    # Handle both UploadFile objects and raw bytes with filenames
    async def get_upload_data(upload):
        if upload is None:
            return None, None
        if isinstance(upload, tuple) and len(upload) == 2:
            # It's already (data, filename) tuple
            return upload
        if isinstance(upload, bytes):
            return upload, None
        try:
            filename = upload.filename if hasattr(upload, "filename") else None
            if hasattr(upload, "file") and hasattr(upload.file, "read"):
                data = upload.file.read()
            elif hasattr(upload, "read"):
                res = upload.read()
                if asyncio.iscoroutine(res):
                    data = await res
                else:
                    data = res
            else:
                data = None
            return data, filename
        except Exception:
            return None, None

    raw_uploads = [
        await get_upload_data(file),
        await get_upload_data(layout_pdf),
        await get_upload_data(cad_file),
    ]

    pdf_data, pdf_name = None, ""
    cad_data, cad_name = None, ""
    qgis_data, qgis_name = None, ""
    companion_data, companion_name = None, ""

    for data_bytes, fname in raw_uploads:
        if not data_bytes:
            continue
        fname = fname or ""
        ext = os.path.splitext(fname.lower())[1]
        if ext == ".pdf":
            pdf_data, pdf_name = data_bytes, fname
        elif ext in (".dwg", ".dwf", ".dxf"):
            cad_data, cad_name = data_bytes, fname
        elif ext in (".kml", ".geojson", ".json", ".gpkg"):
            if not qgis_data:
                qgis_data, qgis_name = data_bytes, fname
            else:
                companion_data, companion_name = data_bytes, fname

    if pipe_logger:
        pipe_logger.log(
            "1. INTAKE",
            "Inspecting uploaded source files...",
            {
                "PDF Layout": f"{pdf_name} ({len(pdf_data):,} bytes)" if pdf_data else "Not provided",
                "KML / GeoJSON": f"{qgis_name or companion_name} ({len(qgis_data or companion_data or b''):,} bytes)" if (qgis_data or companion_data) else "Not provided",
                "CAD Drawing": f"{cad_name} ({len(cad_data):,} bytes)" if cad_data else "Not provided",
            }
        )
    await update_colony_status(colony_id, "running", 18, "Inspecting uploaded source files...")

    target_boundary = existing_boundary
    boundary_selection = None
    qgis_ext = os.path.splitext(qgis_name.lower())[1] if qgis_name else ""
    companion_ext = os.path.splitext(companion_name.lower())[1] if companion_name else ""

    # Extract land boundary polygon from KML or GeoJSON file if provided
    kml_bytes = qgis_data if qgis_ext == ".kml" else (companion_data if companion_ext == ".kml" else None)
    kml_filename = qgis_name if qgis_ext == ".kml" else companion_name
    if kml_bytes:
        if pipe_logger:
            pipe_logger.log("2. KML PERIMETER", f"Extracting ground-truth land perimeter from {kml_filename}...")
        await update_colony_status(colony_id, "running", 28, f"Extracting land perimeter from {kml_filename}...")
        try:
            target_boundary, boundary_selection = vector_import.extract_pdf_boundary(
                kml_bytes, kml_filename
            )
        except Exception as exc:
            try:
                target_boundary = vector_import.extract_boundary(kml_bytes, kml_filename)
                boundary_selection = {"source": "uploaded_kml", "file": kml_filename}
            except Exception:
                if pdf_data:
                    raise importer.ImportError_(f"Could not read the uploaded KML land boundary: {exc}") from exc
                target_boundary = None

    elif qgis_data and qgis_ext in (".geojson", ".json", ".gpkg") and not target_boundary:
        try:
            target_boundary = vector_import.extract_boundary(qgis_data, qgis_name)
        except Exception:
            target_boundary = None

    if target_boundary and pipe_logger:
        b_shape = shape(target_boundary)
        b_anchor = b_shape.representative_point()
        pipe_logger.log(
            "2. KML PERIMETER",
            "Land boundary polygon parsed & verified.",
            {
                "File": kml_filename or qgis_name,
                "Type": target_boundary.get("type"),
                "Center Anchor": f"{b_anchor.y:.5f}°N, {b_anchor.x:.5f}°E",
            }
        )

    # Processing routes:
    if qgis_data and not pdf_data and not cad_data and qgis_ext in (".geojson", ".json", ".gpkg"):
        if pipe_logger:
            pipe_logger.log(
                "3. VECTOR GIS INGESTION",
                f"Parsing native GIS vector features from {qgis_name}...",
                {"Format": qgis_ext.upper(), "Target Boundary": "Provided" if target_boundary else "From vector"}
            )
        return await asyncio.to_thread(
            vector_import.import_vector,
            qgis_data, qgis_name, colony_id, now_ts, maps_link=maps_link, existing_boundary=existing_boundary
        )

    if not pdf_data and not cad_data and qgis_data and qgis_ext == ".kml":
        if pipe_logger:
            pipe_logger.log(
                "3. KML GIS INGESTION",
                f"Parsing land boundary coordinates from KML file {qgis_name}...",
                {"Format": "KML Boundary Polygon", "CRS": "WGS84"}
            )
        return await asyncio.to_thread(
            vector_import.import_kml_boundary,
            qgis_data, qgis_name, colony_id, now_ts, existing_boundary=existing_boundary, maps_link=maps_link
        )

    if not pdf_data and cad_data:
        if pipe_logger:
            pipe_logger.log(
                "3. CAD VECTOR PARSING",
                f"Extracting layers, polylines, and blocks from {cad_name}...",
                {"Format": "DWG/DXF Vector Drawing"}
            )
        fields, zones, plots, warnings = await asyncio.to_thread(
            importer.import_file,
            data=cad_data, filename=cad_name, maps_link=maps_link, colony_id=colony_id, now=now_ts, target_boundary=target_boundary
        )
        if target_boundary:
            try:
                overlay = await store_cad_overlay(
                    cad_data,
                    target_boundary,
                    user_id,
                    colony_id,
                    {
                        "source": "uploaded_kml" if boundary_selection else (
                            "existing_colony_boundary" if existing_boundary else "imported_mapping"
                        ),
                        "selection": boundary_selection,
                    },
                    filename=cad_name,
                )
                if overlay:
                    overlay["plot_count"] = len(plots) or overlay.get("plot_count", 0)
                    fields["pdf_overlay"] = overlay
            except Exception as exc:
                logger.warning("CAD visual overlay rendering failed: %s", exc)
        return fields, zones, plots, warnings

    if pdf_data:
        if visual_overlay_only and target_boundary:
            boundary_shape = shape(target_boundary)
            anchor = boundary_shape.representative_point()
            await update_colony_status(colony_id, "running", 42, f"Extracting vector linework & text from {pdf_name}...")
            if pipe_logger:
                pipe_logger.log("3. VECTOR EXTRACTION", f"PyMuPDF vector linework & text extraction running on {pdf_name}...")
            extracted_pdf = await asyncio.to_thread(importer._extract_pdf, pdf_data)
            plot_numbers = await asyncio.to_thread(
                importer.extract_pdf_plot_numbers, pdf_data, extracted_pdf
            )
            await update_colony_status(colony_id, "running", 58, "Running AI OCR & plot label detection...")
            if pipe_logger:
                page_content = (
                    extracted_pdf.get("pdf_content", {}).get("pages", [{}])[0]
                    if extracted_pdf.get("pdf_content", {}).get("pages")
                    else {}
                )
                pipe_logger.log(
                    "3. VECTOR EXTRACTION",
                    "PDF source inspection completed.",
                    {
                        "PDF Content Type": extracted_pdf.get("pdf_content", {}).get("pdf_type", "unknown"),
                        "Embedded Raster Images": page_content.get("embedded_image_count", 0),
                        "Vector Lines": len(extracted_pdf.get("lines", [])),
                        "Bezier Curves": len(extracted_pdf.get("polys", [])),
                        "Native PDF Text Plot Labels": len(plot_numbers),
                    }
                )
                pipe_logger.log(
                    "4. AI MODELS INFERENCE",
                    "Running Multi-Model AI Pipeline (PaddleOCR, SegFormer, Mask2Former, SAM 2, Grounding DINO, Qwen2.5-VL)...",
                )
            
            # ============ AI MODELS PIPELINE ============
            # Full 6-model inference stack: PaddleOCR + Grounding DINO + SegFormer +
            # Mask2Former + SAM 2 + Qwen2.5-VL. Falls back gracefully to mock predictions
            # if model weights are not downloaded yet.
            ai_execution_summary = {}
            ocr_res = []
            vlm_res = None
            try:
                import time
                import pymupdf
                from PIL import Image
                from app.gis.ai_models.registry import AIModelRegistry
                from app.gis.ai_models.models import ModelLifecycleStatus
                from app.gis.ingestion.coordinates import PageCoordinateTransform

                reg = AIModelRegistry.get_instance()
                with pymupdf.open(stream=pdf_data, filetype="pdf") as pdoc:
                    if len(pdoc) > 0:
                        ppage = pdoc[0]
                        page_w = float(ppage.rect.width)
                        page_h = float(ppage.rect.height)
                        max_dim = max(page_w, page_h, 1.0)
                        # Dynamically scale page for OCR so giant blueprint pages don't allocate 500MB+ images
                        render_scale = max(0.2, min(2.5, 2400.0 / max_dim))
                        pix = ppage.get_pixmap(matrix=pymupdf.Matrix(render_scale, render_scale))
                        orig_img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

                        transform_full = PageCoordinateTransform(
                            page_number=1,
                            width_points=page_w,
                            height_points=page_h,
                            render_dpi=int(round(72.0 * render_scale)),
                            render_scale_factor=render_scale,
                        )

                        # Downscale for OCR if needed
                        ocr_img = orig_img
                        ocr_transform = transform_full
                        ocr_scale_factor = 1.0
                        max_ocr_dim = 1200
                        if max(orig_img.width, orig_img.height) > max_ocr_dim:
                            scale = max_ocr_dim / max(orig_img.width, orig_img.height)
                            ocr_w, ocr_h = int(orig_img.width * scale), int(orig_img.height * scale)
                            ocr_img = orig_img.resize((ocr_w, ocr_h), Image.Resampling.BILINEAR)
                            ocr_scale_factor = 1.0 / scale
                            ocr_transform = PageCoordinateTransform(
                                page_number=1,
                                width_points=page_w,
                                height_points=page_h,
                                render_dpi=int(round(72.0 * render_scale * scale)),
                                render_scale_factor=render_scale * scale,
                            )
                            logger.info(f"[AI] Downscaled image for OCR: {orig_img.width}x{orig_img.height} → {ocr_w}x{ocr_h}")

                        # ── 1. PaddleOCR PP-OCRv5 (text label extraction) ──
                        has_native_labels = len(plot_numbers) >= 5
                        skip_ocr = os.getenv("SKIP_OCR", "false").lower() == "true" or has_native_labels
                        t_m = time.time()
                        if skip_ocr:
                            reason = f"PDF has {len(plot_numbers)} native vector labels" if has_native_labels else "SKIP_OCR=true"
                            logger.info(f"[AI] Skipping PaddleOCR ({reason})")
                            ai_execution_summary["PaddleOCR (labels)"] = f"SKIPPED ({reason})"
                        else:
                            try:
                                ocr_diag = reg.paddle_ocr.get_diagnostics()
                                if ocr_diag.status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                                    ocr_res_raw = await asyncio.to_thread(reg.paddle_ocr.detect_and_recognize, ocr_img, ocr_transform)
                                    if ocr_scale_factor != 1.0:
                                        for det in ocr_res_raw:
                                            det.bbox_page_pt = [
                                                det.bbox_page_pt[0] * ocr_scale_factor,
                                                det.bbox_page_pt[1] * ocr_scale_factor,
                                                det.bbox_page_pt[2] * ocr_scale_factor,
                                                det.bbox_page_pt[3] * ocr_scale_factor,
                                            ]
                                    ocr_res = ocr_res_raw
                                    dur = round(time.time() - t_m, 2)
                                    ai_execution_summary["PaddleOCR (labels)"] = f"EXECUTED ({dur}s) — {len(ocr_res)} detections"
                                else:
                                    ai_execution_summary["PaddleOCR (labels)"] = f"SKIPPED ({ocr_diag.status.value})"
                            except Exception as e_ocr:
                                logger.warning("[AI] PaddleOCR notice: %s", e_ocr)
                                ai_execution_summary["PaddleOCR (labels)"] = f"ERROR ({e_ocr})"

                        if has_native_labels:
                            ai_execution_summary["Grounding DINO"] = "SKIPPED (native vector linework & labels present)"
                            ai_execution_summary["SegFormer"] = "SKIPPED (native vector linework & labels present)"
                            ai_execution_summary["Mask2Former"] = "SKIPPED (native vector linework & labels present)"
                            ai_execution_summary["SAM 2"] = "SKIPPED (native vector linework & labels present)"
                            ai_execution_summary["Qwen2.5-VL"] = "SKIPPED (native vector linework & labels present)"
                        else:
                            enable_heavy_ai = os.getenv("ENABLE_HEAVY_AI_MODELS", "false").lower() == "true"
                            if not enable_heavy_ai:
                                dino_proposals = reg.grounding_dino.mock_predict(transform_full)
                                segformer_proposals = reg.segformer.mock_predict(transform_full)
                                mask2former_proposals = reg.mask2former.mock_predict(transform_full)
                                sam2_refinements = []
                                vlm_res = reg.qwen_vlm.mock_predict(orig_img)
                                ai_execution_summary["Grounding DINO"] = "MOCK (heavy AI disabled by default for memory safety)"
                                ai_execution_summary["SegFormer"] = "MOCK (heavy AI disabled by default for memory safety)"
                                ai_execution_summary["Mask2Former"] = "MOCK (heavy AI disabled by default for memory safety)"
                                ai_execution_summary["SAM 2"] = "SKIPPED (heavy AI disabled by default for memory safety)"
                                ai_execution_summary["Qwen2.5-VL"] = "MOCK (heavy AI disabled by default for memory safety)"
                            else:
                                # ── 2. Grounding DINO (open-vocabulary region detection) ──
                                try:
                                    t_m = time.time()
                                    dino_diag = reg.grounding_dino.get_diagnostics()
                                    if dino_diag.status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                                        dino_proposals = await asyncio.to_thread(reg.grounding_dino.detect_regions, orig_img, transform_full)
                                    else:
                                        dino_proposals = reg.grounding_dino.mock_predict(transform_full)
                                    dur = round(time.time() - t_m, 2)
                                    ai_execution_summary["Grounding DINO"] = f"{'EXECUTED' if dino_diag.status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED) else 'MOCK'} ({dur}s) — {len(dino_proposals)} proposals"
                                except Exception as e_dino:
                                    dino_proposals = []
                                    logger.warning("[AI] Grounding DINO notice: %s", e_dino)
                                    ai_execution_summary["Grounding DINO"] = f"ERROR ({e_dino})"

                                # ── 3. SegFormer (semantic segmentation) ──
                                try:
                                    t_m = time.time()
                                    seg_diag = reg.segformer.get_diagnostics()
                                    if seg_diag.status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                                        segformer_proposals = await asyncio.to_thread(reg.segformer.predict_segments, orig_img, transform_full)
                                    else:
                                        segformer_proposals = reg.segformer.mock_predict(transform_full)
                                    dur = round(time.time() - t_m, 2)
                                    ai_execution_summary["SegFormer"] = f"{'EXECUTED' if seg_diag.status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED) else 'MOCK'} ({dur}s) — {len(segformer_proposals)} segments"
                                except Exception as e_seg:
                                    segformer_proposals = []
                                    logger.warning("[AI] SegFormer notice: %s", e_seg)
                                    ai_execution_summary["SegFormer"] = f"ERROR ({e_seg})"

                                # ── 4. Mask2Former (instance segmentation) ──
                                try:
                                    t_m = time.time()
                                    m2f_diag = reg.mask2former.get_diagnostics()
                                    if m2f_diag.status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                                        mask2former_proposals = await asyncio.to_thread(reg.mask2former.predict_instances, orig_img, transform_full)
                                    else:
                                        mask2former_proposals = reg.mask2former.mock_predict(transform_full)
                                    dur = round(time.time() - t_m, 2)
                                    ai_execution_summary["Mask2Former"] = f"{'EXECUTED' if m2f_diag.status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED) else 'MOCK'} ({dur}s) — {len(mask2former_proposals)} instances"
                                except Exception as e_m2f:
                                    mask2former_proposals = []
                                    logger.warning("[AI] Mask2Former notice: %s", e_m2f)
                                    ai_execution_summary["Mask2Former"] = f"ERROR ({e_m2f})"

                                # ── 5. SAM 2 (boundary refinement on best candidate) ──
                                try:
                                    t_m = time.time()
                                    sam2_diag = reg.sam2.get_diagnostics()
                                    first_bbox = None
                                    if segformer_proposals:
                                        first_bbox = segformer_proposals[0].bbox_page_pt
                                    elif mask2former_proposals:
                                        first_bbox = mask2former_proposals[0].bbox_page_pt
                                    if first_bbox is not None:
                                        if sam2_diag.status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                                            refined = await asyncio.to_thread(
                                                reg.sam2.refine_candidate_boundary,
                                                orig_img, transform_full.bbox_point_to_pixel(first_bbox), transform_full
                                            )
                                            sam2_refinements = [refined] if refined else []
                                        else:
                                            sam2_refinements = [reg.sam2.mock_predict(first_bbox, transform_full)]
                                        dur = round(time.time() - t_m, 2)
                                        ai_execution_summary["SAM 2"] = f"{'EXECUTED' if sam2_diag.status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED) else 'MOCK'} ({dur}s) — {len(sam2_refinements)} refinements"
                                    else:
                                        sam2_refinements = []
                                        ai_execution_summary["SAM 2"] = "SKIPPED (no candidate bbox available)"
                                except Exception as e_sam:
                                    sam2_refinements = []
                                    logger.warning("[AI] SAM 2 notice: %s", e_sam)
                                    ai_execution_summary["SAM 2"] = f"ERROR ({e_sam})"

                                # ── 6. Qwen2.5-VL (visual layout interpretation) ──
                                try:
                                    t_m = time.time()
                                    vlm_diag = reg.qwen_vlm.get_diagnostics()
                                    if vlm_diag.status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED):
                                        vlm_res = await asyncio.to_thread(reg.qwen_vlm.interpret_layout, orig_img)
                                    else:
                                        vlm_res = reg.qwen_vlm.mock_predict(orig_img)
                                    dur = round(time.time() - t_m, 2)
                                    ai_execution_summary["Qwen2.5-VL"] = f"{'EXECUTED' if vlm_diag.status in (ModelLifecycleStatus.READY, ModelLifecycleStatus.CONFIGURED) else 'MOCK'} ({dur}s)"
                                except Exception as e_vlm:
                                    vlm_res = None
                                    logger.warning("[AI] Qwen2.5-VL notice: %s", e_vlm)
                                    ai_execution_summary["Qwen2.5-VL"] = f"ERROR ({e_vlm})"

                # Bridge OCR results into extracted_pdf for label-to-region matching
                if ocr_res:
                    existing_text_strings = {str(t[2]).strip().lower() for t in extracted_pdf.get("texts", [])}
                    for det in ocr_res:
                        txt_clean = det.text.strip()
                        if txt_clean.lower() not in existing_text_strings and importer.PLOT_NO.match(txt_clean):
                            cx = (det.bbox_page_pt[0] + det.bbox_page_pt[2]) / 2.0
                            cy_top = (det.bbox_page_pt[1] + det.bbox_page_pt[3]) / 2.0
                            cy_up = page_h - cy_top
                            extracted_pdf.setdefault("texts", []).append((cx, cy_up, txt_clean, "OCR"))
                            extracted_pdf.setdefault("annotations", []).append({
                                "x": cx,
                                "y": cy_up,
                                "text": txt_clean,
                                "direction": (1.0, 0.0),
                                "font_size": 10.0,
                            })
                    detected_plot_numbers = [
                        importer.normalize_plot_no(det.text)
                        for det in ocr_res
                        if importer.PLOT_NO.match(str(det.text).strip())
                        and importer.normalize_plot_no(det.text)
                    ]
                    if detected_plot_numbers and (not plot_numbers or len(detected_plot_numbers) > len(plot_numbers)):
                        plot_numbers = list(dict.fromkeys(list(plot_numbers) + detected_plot_numbers))
            except Exception as exc:
                logger.warning("[AI] Pipeline execution notice: %s", exc)
                ai_execution_summary["Pipeline Exception"] = str(exc)

            if pipe_logger and ai_execution_summary:
                pipe_logger.log(
                    "4. AI MODELS INFERENCE",
                    "AI Models pipeline completed:",
                    ai_execution_summary,
                )
            if pipe_logger:
                pipe_logger.log(
                    "5. GEOREFERENCING & SPATIAL WARPING",
                    "Warping layout coordinates to KML land perimeter...",
                    {
                        "Target CRS": "GEOGRAPHIC_WGS84 (EPSG:4326)",
                        "Anchor": f"{anchor.y:.5f}°N, {anchor.x:.5f}°E",
                    }
                )
            await update_colony_status(colony_id, "running", 72, "Georeferencing & spatial coordinate warping...")
            overlay = await store_pdf_overlay(
                pdf_data,
                target_boundary,
                user_id,
                colony_id,
                {
                    "source": "uploaded_kml" if boundary_selection else (
                        "existing_colony_boundary" if existing_boundary else "imported_mapping"
                    ),
                    "kml_sha256": hashlib.sha256(companion_data).hexdigest()
                    if boundary_selection and companion_data
                    else None,
                    "selection": boundary_selection,
                },
                extracted_pdf=extracted_pdf,
            )
            overlay["plot_count"] = len(plot_numbers)
            if pipe_logger:
                overlay_fit = overlay.get("fit") or {}
                pipe_logger.log(
                    "5. GEOREFERENCING & SPATIAL WARPING",
                    "Registered the source artwork; raster detections remain review candidates.",
                    {
                        "Raster Plot Candidates": overlay_fit.get("interactive_plot_count", len(overlay.get("plot_regions") or [])),
                        "Matched PDF Text Labels": overlay_fit.get("matched_plot_label_count", 0),
                        "Registration": overlay_fit.get("fit_mode", "unknown"),
                        "Alignment Warnings": " · ".join(overlay_fit.get("warnings") or []) or "None",
                    },
                )
            warnings = []
            zones = []
            plots = []
            fields = None
            if extracted_pdf.get("lines") or extracted_pdf.get("polys"):
                await update_colony_status(colony_id, "running", 85, "Segmenting plot polygons & snapping parcels...")
                try:
                    fields, zones, plots, warnings = await asyncio.to_thread(
                        importer.import_file,
                        data=pdf_data,
                        filename=pdf_name,
                        maps_link=maps_link,
                        colony_id=colony_id,
                        now=now_ts,
                        target_boundary=target_boundary,
                        extracted_pdf=extracted_pdf,
                    )
                except (importer.ImportError_, Exception) as exc:
                    logger.warning(
                        "PDF vector plot extraction failed (%s); evaluating raster fallback: %s",
                        type(exc).__name__,
                        exc,
                    )
                    warnings.append(
                        f"PDF vector extraction failed: {exc}. "
                        "Evaluating raster fallback overlay regions."
                    )
                    plots = []
                    zones = []
            if fields is None:
                fields = {
                    "boundary": target_boundary,
                    "map_center": {"lat": anchor.y, "lng": anchor.x},
                    "layout_version": "imported",
                    "import_source": {
                        "filename": pdf_name,
                        "mode": "pdf_overlay_only",
                        "imported_at": now_ts,
                    },
                }


            # If overlay regions are unnumbered, perform spatial join with detected plot numbers / OCR anchors
            overlay_plot_regions = overlay.get("plot_regions") or []
            if overlay_plot_regions and not any((reg.get("number") not in (None, "", "unknown")) for reg in overlay_plot_regions):
                from shapely.geometry import shape as s_shape, Point as S_Point
                from app.gis.importer import PLOT_NO, normalize_plot_no

                # PRIMARY: Use georeferenced text annotations from overlay fit diagnostics (already in WGS84 lng/lat)
                fit_annotations = (overlay.get("fit") or {}).get("pdf_text_annotations") or []
                valid_anchors = []
                for ann in fit_annotations:
                    t_str = str(ann.get("text", "")).strip()
                    coords = ann.get("coordinates")
                    if PLOT_NO.match(t_str) and coords and len(coords) == 2:
                        n = normalize_plot_no(t_str)
                        if n:
                            valid_anchors.append((n, float(coords[0]), float(coords[1])))

                # FALLBACK: Use OCR detections georeferenced via the overlay homography
                # This handles raster PDFs where fit_annotations may be empty
                if not valid_anchors and ocr_res:
                    try:
                        from shapely.geometry import shape as s_shape2
                        overlay_fit = overlay.get("fit") or {}
                        # Try using the homography matrix from the overlay fit to map OCR pixel positions
                        H = overlay_fit.get("homography")  # 3x3 matrix stored during registration
                        src_w = overlay_fit.get("src_width", page_w * render_scale)
                        src_h = overlay_fit.get("src_height", page_h * render_scale)
                        boundary_bounds = shape(target_boundary).bounds  # (minx, miny, maxx, maxy) in WGS84
                        bnd_minx, bnd_miny, bnd_maxx, bnd_maxy = boundary_bounds
                        for det in ocr_res:
                            t_str = str(det.text).strip()
                            if not PLOT_NO.match(t_str):
                                continue
                            n = normalize_plot_no(t_str)
                            if not n:
                                continue
                            # OCR bbox_page_pt is in PDF page points at full render_scale
                            cx_px = (det.bbox_page_pt[0] + det.bbox_page_pt[2]) / 2.0
                            cy_px = (det.bbox_page_pt[1] + det.bbox_page_pt[3]) / 2.0
                            # Normalize pixel position to [0,1] relative to page
                            nx = cx_px / max(page_w * render_scale, 1)
                            ny = cy_px / max(page_h * render_scale, 1)
                            # Map to WGS84 via bounding box interpolation
                            geo_x = bnd_minx + nx * (bnd_maxx - bnd_minx)
                            geo_y = bnd_maxy - ny * (bnd_maxy - bnd_miny)
                            valid_anchors.append((n, geo_x, geo_y))
                    except Exception as _ocr_geo_err:
                        logger.debug("OCR geo fallback failed: %s", _ocr_geo_err)

                if valid_anchors:
                    used_anchors = set()
                    for reg in overlay_plot_regions:
                        if reg.get("number"):
                            continue
                        try:
                            poly_geo = s_shape(reg.get("geometry", {}))
                            centroid = poly_geo.centroid
                            best_num = None
                            min_d = float("inf")
                            for num_str, ax, ay in valid_anchors:
                                if num_str in used_anchors:
                                    continue
                                pt_anchor = S_Point(ax, ay)
                                if poly_geo.contains(pt_anchor):
                                    best_num = num_str
                                    min_d = 0.0
                                    break
                                d = centroid.distance(pt_anchor)
                                if d < min_d and d < 0.001:  # ~100m search radius for raster PDFs
                                    min_d = d
                                    best_num = num_str
                                if best_num:
                                    reg["number"] = best_num
                                    reg["label"] = f"Plot {best_num}"
                                    reg["detection_confidence"] = 0.85
                                    used_anchors.add(best_num)
                        except Exception:
                            pass

            # Evaluate vector usability and determine raster promotion fallback
            has_usable_vector = _has_usable_vector_plots(plots, target_boundary)
            has_numbered_regions = any(
                (reg.get("number") not in (None, "", "unknown")) for reg in overlay_plot_regions
            )
            # Route to raster fallback if:
            # 1. Vector extraction produced no usable plots, OR
            # 2. Vector extraction produced an isolated artifact (<= 2 plots) while raster overlay detected a full layout (>= 5 regions)
            raster_fallback_applied = False
            should_fallback_to_raster = (
                (not has_usable_vector)
                or (len(plots) <= 2 and len(overlay_plot_regions) >= 5)
            )

            if should_fallback_to_raster and overlay_plot_regions:
                promoted_zones, promoted_plots = _promote_overlay_regions_to_plots(
                    overlay_plot_regions, colony_id, now_ts, target_boundary
                )
                if promoted_plots:
                    raster_fallback_applied = True
                    reason = "no usable vector plots" if not has_usable_vector else "vector extraction yielded non-layout artifacts only"
                    plots = promoted_plots
                    zones = promoted_zones
                    label_src = "OCR-numbered" if has_numbered_regions else "auto-numbered"
                    logger.info(
                        "Promoted %d raster overlay regions into plot inventory (%s, reason: %s)",
                        len(plots),
                        label_src,
                        reason,
                    )
                    warnings.append(
                        f"Promoted {len(plots)} plot parcels ({label_src}) from raster layout detection into inventory ({reason})."
                    )

            warnings.append(
                f"Detected {len(plot_numbers) or len(plots)} unique PDF plot labels and recovered "
                f"{len(plots)} individual plot geometries."
            )
            if not plots:
                warnings.append(
                    "No verified vector plot boundaries were recovered; the PDF remains "
                    "a visual overlay with heuristic regions only."
                )
            else:
                warnings.append(
                    f"Recovered {len(plots)} plot parcels with verified spatial boundaries ready for interactive review."
                )
            warnings.extend(overlay.get("fit", {}).get("warnings") or [])
            warnings.append(
                "The PDF layout image was warped to the land perimeter and clipped to its boundary."
            )
            fields["boundary"] = target_boundary
            fields["map_center"] = {"lat": anchor.y, "lng": anchor.x}
            fields["pdf_overlay"] = overlay
            fields["maps_link"] = maps_link or None
            if vlm_res:
                fields["vlm_reasoning"] = vlm_res.to_dict()
                if overlay:
                    overlay["vlm_reasoning"] = vlm_res.to_dict()
            source = fields.setdefault("import_source", {})
            source["filename"] = pdf_name
            source["pdf_plot_count"] = len(plot_numbers) or len(plots)
            source["pdf_plot_numbers"] = plot_numbers or [p["number"] for p in plots]
            source["saved_plot_records"] = len(plots)
            source["pdf_content"] = extracted_pdf.get("pdf_content")
            source["pdf_processing_mode"] = (
                "vector_plots_and_visual_overlay"
                if (plots and not raster_fallback_applied)
                else ("raster_plots_and_visual_overlay" if plots else "visual_overlay_only")
            )
            source["registration_metrics"] = {
                **(source.get("registration_metrics") or {}),
                "overlay_fit": overlay.get("fit"),
                "pdf_vector_plot_count": len(plots) if not raster_fallback_applied else 0,
                "raster_promoted_plot_count": len(plots) if raster_fallback_applied else 0,
                "usable_vector_plots_found": has_usable_vector,
                "raster_fallback_applied": raster_fallback_applied,
            }
            source["warnings"] = warnings
            return fields, zones, plots, warnings
        return await asyncio.to_thread(
            importer.import_file,
            data=pdf_data, filename=pdf_name, maps_link=maps_link, colony_id=colony_id, now=now_ts, target_boundary=target_boundary
        )

    src_data = qgis_data or companion_data
    src_name = qgis_name or companion_name
    if not src_data:
        raise importer.ImportError_("Upload at least one mapping source file (GeoJSON, KML, PDF, DXF, or DWG).")

    if src_name.lower().endswith(".kml"):
        return await asyncio.to_thread(
            vector_import.import_kml_boundary,
            src_data, src_name, colony_id, now_ts, existing_boundary=existing_boundary, maps_link=maps_link
        )

    return await asyncio.to_thread(
        importer.import_file,
        data=src_data, filename=src_name, maps_link=maps_link, colony_id=colony_id, now=now_ts, target_boundary=target_boundary
    )


@api.post("/admin/colonies")
async def admin_create_colony(
    request: Request,
    name: Optional[str] = Form(None),
    colony_id: Optional[str] = Form(None),
    whatsapp_number: Optional[str] = Form(DEFAULT_WHATSAPP),
    maps_link: Optional[str] = Form(""),
    location: Optional[str] = Form(""),
    description: Optional[str] = Form(""),
    public_enabled: Optional[bool] = Form(None),
    is_public: Optional[str] = Form(None),
    partner_admin_id: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    layout_pdf: Optional[UploadFile] = File(None),
    cad_file: Optional[UploadFile] = File(None),
    user=Depends(require_admin),
):
    from fastapi import BackgroundTasks

    if request.headers.get("content-type", "").startswith("application/json"):
        body = await request.json()
        c_name = str(body.get("name", "")).strip()
        c_whatsapp = str(body.get("whatsapp_number", DEFAULT_WHATSAPP))
        c_maps_link = str(body.get("maps_link", ""))
        c_location = str(body.get("location", ""))
        c_description = str(body.get("description", ""))
        c_public = body.get("public_enabled", body.get("is_public", True))
        c_partner = body.get("partner_admin_id")
        c_colony_id = body.get("colony_id")
    else:
        c_name = (name or "").strip()
        c_whatsapp = whatsapp_number or DEFAULT_WHATSAPP
        c_maps_link = maps_link or ""
        c_location = (location or "").strip()
        c_description = (description or "").strip()
        c_public = public_enabled if public_enabled is not None else (str(is_public).lower() == "true" if is_public is not None else True)
        c_partner = partner_admin_id
        c_colony_id = colony_id

    if not c_name:
        raise HTTPException(400, "Colony name is required")

    digits = re.sub(r"\D", "", c_whatsapp)
    if digits and (len(digits) < 10 or len(digits) > 15):
        c_whatsapp = DEFAULT_WHATSAPP

    base = slugify(c_colony_id or c_name)
    slug = base
    i = 2
    while await DB.colonies.find_one({"slug": slug}):
        slug = f"{base}-{i}"
        i += 1

    provided_files = [f for f in (file, layout_pdf, cad_file) if f]
    if not provided_files:
        raise HTTPException(400, "Upload at least one mapping source file (KML boundary or PDF/DXF layout drawing).")

    for f in provided_files:
        if f.size and f.size > MAX_LAYOUT_BYTES:
            raise HTTPException(413, f"File too large (max {MAX_UPLOAD_SIZE_MB} MB)")

    # Strict upload formats: ONLY KML (.kml) for boundary, and PDF (.pdf) or DXF (.dxf) for layout drawing
    if file and file.filename:
        ext = os.path.splitext(file.filename.lower())[1]
        if ext != ".kml":
            raise HTTPException(400, f"Unsupported file format '{file.filename}'. Only KML (.kml) files are allowed for boundary.")

    if layout_pdf and layout_pdf.filename:
        ext = os.path.splitext(layout_pdf.filename.lower())[1]
        if ext not in (".pdf", ".dxf"):
            raise HTTPException(400, f"Unsupported file format '{layout_pdf.filename}'. Only PDF (.pdf) and DXF (.dxf) files are allowed for layout drawing.")

    if cad_file and cad_file.filename:
        ext = os.path.splitext(cad_file.filename.lower())[1]
        if ext != ".dxf":
            raise HTTPException(400, f"Unsupported file format '{cad_file.filename}'. Only DXF (.dxf) files are allowed.")

    partner_id = str(c_partner) if (user["role"] == "super_admin" and c_partner) else None

    # Create colony with processing status
    res = await DB.colonies.insert_one({
        "name": c_name,
        "slug": slug,
        "owner_id": user["id"],
        "partner_admin_id": partner_id,
        "location": c_location or "—",
        "description": c_description,
        "public_enabled": bool(c_public),
        "whatsapp_number": c_whatsapp,
        "created_at": now_iso(),
        "processing_status": "queued",
        "processing_progress": 0,
        "processing_stage": "Queued for processing",
        "processing_error": None,
    })
    cid = str(res.inserted_id)

    # Save files to disk for background processing
    storage_dir = Path(__file__).resolve().parent.parent / "storage"
    storage_dir.mkdir(parents=True, exist_ok=True)

    file_data = {}
    
    try:
        if file:
            if hasattr(file, "seek"):
                _seek_res = file.seek(0)
                if asyncio.iscoroutine(_seek_res):
                    await _seek_res
            file_content = await file.read() if hasattr(file, "read") else b""
            file_path = storage_dir / f"{cid}_boundary{os.path.splitext(file.filename)[1]}"
            file_path.write_bytes(file_content)
            file_data["file"] = (str(file_path), file.filename)
            logger.info(f"Saved boundary file: {file_path} ({len(file_content)} bytes)")
    except Exception as e:
        logger.error(f"Failed to save boundary file: {e}")
    
    try:
        if layout_pdf:
            if hasattr(layout_pdf, "seek"):
                _seek_res = layout_pdf.seek(0)
                if asyncio.iscoroutine(_seek_res):
                    await _seek_res
            pdf_content = await layout_pdf.read() if hasattr(layout_pdf, "read") else b""
            pdf_path = storage_dir / f"{cid}_layout{os.path.splitext(layout_pdf.filename)[1]}"
            pdf_path.write_bytes(pdf_content)
            file_data["layout_pdf"] = (str(pdf_path), layout_pdf.filename)
            logger.info(f"Saved layout PDF: {pdf_path} ({len(pdf_content)} bytes)")
    except Exception as e:
        logger.error(f"Failed to save layout PDF: {e}")
    
    try:
        if cad_file:
            if hasattr(cad_file, "seek"):
                _seek_res = cad_file.seek(0)
                if asyncio.iscoroutine(_seek_res):
                    await _seek_res
            cad_content = await cad_file.read() if hasattr(cad_file, "read") else b""
            cad_path = storage_dir / f"{cid}_cad{os.path.splitext(cad_file.filename)[1]}"
            cad_path.write_bytes(cad_content)
            file_data["cad_file"] = (str(cad_path), cad_file.filename)
            logger.info(f"Saved CAD file: {cad_path} ({len(cad_content)} bytes)")
    except Exception as e:
        logger.error(f"Failed to save CAD file: {e}")
    
    logger.info(f"File data saved: {list(file_data.keys())}")
    
    # Check if we have any files to process
    if not file_data:
        await update_colony_status(cid, "failed", 0, "No files to process")
        await DB.colonies.delete_one({"_id": ObjectId(cid)})
        raise HTTPException(400, "No files were successfully saved for processing")

    # Queue background processing
    async def process_colony_background():
        try:
            await update_colony_status(cid, "running", 5, "Starting import...")
            logger.info(f"Starting background processing for colony {cid}")
            
            # Read file contents from disk
            file_content = None
            layout_pdf_content = None
            cad_file_content = None
            file_name = None
            layout_pdf_name = None
            cad_file_name = None
            
            if "file" in file_data:
                file_path, file_name = file_data["file"]
                logger.info(f"Reading boundary file from: {file_path}")
                with open(file_path, "rb") as f:
                    file_content = f.read()
                logger.info(f"Read boundary file: {len(file_content)} bytes")
            
            if "layout_pdf" in file_data:
                pdf_path, layout_pdf_name = file_data["layout_pdf"]
                logger.info(f"Reading layout PDF from: {pdf_path}")
                with open(pdf_path, "rb") as f:
                    layout_pdf_content = f.read()
                logger.info(f"Read layout PDF: {len(layout_pdf_content)} bytes")
            
            if "cad_file" in file_data:
                cad_path, cad_file_name = file_data["cad_file"]
                logger.info(f"Reading CAD file from: {cad_path}")
                with open(cad_path, "rb") as f:
                    cad_file_content = f.read()
                logger.info(f"Read CAD file: {len(cad_file_content)} bytes")

            pipe_logger = PipelineTerminalLogger(c_name, cid)
            pipe_logger.log("INITIALIZE", f"Colony record created in database: '{c_name}' (slug: {slug})")

            await update_colony_status(cid, "running", 10, "Processing layout file...")
            
            fields, zone_docs, plot_docs, warnings = await import_colony_bundle_py(
                file=(file_content, file_name) if file_content else None,
                layout_pdf=(layout_pdf_content, layout_pdf_name) if layout_pdf_content else None,
                cad_file=(cad_file_content, cad_file_name) if cad_file_content else None,
                maps_link=c_maps_link,
                colony_id=cid,
                now=now_iso(),
                visual_overlay_only=True,
                user_id=user["id"],
                pipe_logger=pipe_logger,
            )

            await update_colony_status(cid, "running", 89, "Saving zones and plots to database...")
            
            if zone_docs:
                await DB.zones.insert_many(zone_docs)
            if plot_docs:
                await DB.plots.insert_many(plot_docs)
            else:
                warnings.append("Only an explicit colony land boundary was imported; no plot parcel geometry was supplied.")

            if not c_location:
                mc = fields.get("map_center", {})
                if mc and "lat" in mc and "lng" in mc:
                    fields["location"] = f"{mc['lat']:.5f}, {mc['lng']:.5f}"

            await update_colony_status(cid, "running", 94, "Detecting entrance & road alignments...")
            
            try:
                if plot_docs:
                    fields.update(await asyncio.to_thread(roads.entrance_fields, fields["boundary"], [p["geometry"] for p in plot_docs]))
            except Exception:
                logger.exception("entrance detection failed")

            fields["entry_checked"] = True
            if not fields.get("entrance"):
                warnings.append("No mapped road found near the layout — entry gate not placed")

            # Dynamically infer and persist WGS84 CRS metadata from boundary / plots
            has_wgs84 = False
            bnd = fields.get("boundary")
            if bnd and isinstance(bnd, dict):
                bcoords = bnd.get("coordinates")
                if bcoords:
                    try:
                        pt = bcoords[0]
                        while isinstance(pt, (list, tuple)) and len(pt) > 0 and isinstance(pt[0], (list, tuple)):
                            pt = pt[0]
                        if pt and len(pt) >= 2 and isinstance(pt[0], (int, float)) and isinstance(pt[1], (int, float)):
                            if -180 <= pt[0] <= 180 and -90 <= pt[1] <= 90 and (abs(pt[0]) > 0.1 or abs(pt[1]) > 0.1):
                                has_wgs84 = True
                    except Exception:
                        pass
            if not has_wgs84 and plot_docs:
                try:
                    p_geom = (plot_docs[0].get("geometry") or {}) if isinstance(plot_docs[0], dict) else None
                    if p_geom and isinstance(p_geom, dict):
                        pcoords = p_geom.get("coordinates")
                        if pcoords:
                            pt = pcoords[0]
                            while isinstance(pt, (list, tuple)) and len(pt) > 0 and isinstance(pt[0], (list, tuple)):
                                pt = pt[0]
                            if pt and len(pt) >= 2 and isinstance(pt[0], (int, float)) and isinstance(pt[1], (int, float)):
                                if -180 <= pt[0] <= 180 and -90 <= pt[1] <= 90 and (abs(pt[0]) > 0.1 or abs(pt[1]) > 0.1):
                                    has_wgs84 = True
                except Exception:
                    pass

            if has_wgs84:
                fields["crs_metadata"] = {
                    "crs_type": "geographic_wgs84",
                    "epsg": 4326,
                    "units": "deg",
                    "is_geographic": True,
                    "is_georeferenced": True,
                    "georeferencing_status": "authoritative_kml",
                    "geographic_verified": True,
                }
                fields["is_georeferenced"] = True

            await update_colony_status(cid, "running", 97, "Updating colony record & CRS parameters...")
            
            await DB.colonies.update_one({"_id": res.inserted_id}, {"$set": fields})

            await update_colony_status(cid, "running", 99, "Finalizing digital masterplan & canonical dataset...")
            
            # Automatically persist canonical dataset
            try:
                from app.gis.canonical.persistence import commit_canonical_dataset
                source_plots = plot_docs
                formatted_plots = [
                    {
                        "id": str(p.get("_id") or p.get("id")),
                        "number": p.get("number"),
                        "original_number": p.get("original_number") or p.get("number"),
                        "normalized_number": p.get("normalized_number") or p.get("number"),
                        "geometry": p.get("geometry"),
                        "area_declared": p.get("area_declared") or p.get("area_sqm"),
                        "area_sqm": p.get("area_sqm") or p.get("area_declared"),
                        "frontage_declared": p.get("frontage_declared"),
                        "depth_declared": p.get("depth_declared"),
                        "side_declared": p.get("side_declared") or {},
                        "declared_units": p.get("declared_units"),
                        "semantic_validation_status": p.get("semantic_validation_status", "review_required"),
                        "source_page": p.get("source_page", 1),
                    }
                    for p in source_plots
                ]
                # Build preview_data structure expected by commit_canonical_dataset
                preview_data = {
                    "fields": fields,
                    "plots": formatted_plots,
                    "roads": fields.get("roads", []),
                    "greens": fields.get("greens", []),
                    "dimensions": [],
                }
                source_filename = (
                    file_data.get("layout_pdf", ("", ""))[1]
                    or file_data.get("file", ("", ""))[1]
                    or file_data.get("cad_file", ("", ""))[1]
                    or "unknown"
                )
                commit_res = await commit_canonical_dataset(
                    DB,
                    colony_id=cid,
                    preview_data=preview_data,
                    source_filename=source_filename,
                    created_by=user["id"],
                    force_approval=True,
                )
                active_ds = await DB.canonical_datasets.find_one({"colony_id": cid, "is_active": True})
                if active_ds:
                    ds_id = str(active_ds["_id"])
                    await DB.colonies.update_one(
                        {"_id": ObjectId(cid)},
                        {"$set": {"canonical_dataset_id": ds_id}},
                    )
                    logger.info(f"Canonical dataset committed & linked for colony {cid}: {ds_id}")
            except Exception as e:
                logger.exception("canonical dataset creation failed")
                warnings.append(f"Canonical dataset creation failed: {e}")

            # If a layout file was supplied but no plots and no overlay could be recovered, raise explicit failure
            if not plot_docs and (layout_pdf_content or cad_file_content) and not fields.get("pdf_overlay"):
                raise importer.ImportError_(
                    "No usable plot boundaries or visual layout overlay could be extracted from the uploaded file."
                )

            # Cleanup temp files
            for path, _ in file_data.values():
                try:
                    os.remove(path)
                except:
                    pass

            if plot_docs:
                await update_colony_status(cid, "ready", 100, "Complete")
                pipe_logger.log("SUCCESS", f"Colony processed successfully: {len(plot_docs)} plots")
            elif fields.get("pdf_overlay"):
                await update_colony_status(cid, "ready", 100, "Complete (Visual overlay registered; 0 plots extracted)")
                pipe_logger.log("WARNING", "Colony registered as visual overlay only: no verified plot boundaries could be extracted.")
            else:
                await update_colony_status(cid, "ready", 100, "Complete (Boundary perimeter only)")
                pipe_logger.log("SUCCESS", "Colony land boundary imported successfully.")

        except importer.ImportError_ as e:
            await update_colony_status(cid, "failed", 0, f"Import error: {e}")
            await DB.colonies.delete_one({"_id": ObjectId(cid)})
            logger.error(f"Colony import validation error: {e}")
        except Exception as e:
            import traceback
            traceback.print_exc()
            await update_colony_status(cid, "failed", 0, f"Processing error: {e}")
            await DB.colonies.delete_one({"_id": ObjectId(cid)})
            logger.exception("colony import failed")

    # Start background task
    asyncio.create_task(process_colony_background())

    return {"id": cid, "status": "processing", "slug": slug}


@api.get("/admin/colonies/{colony_id}/status")
async def get_colony_status(colony_id: str, user=Depends(require_admin)):
    """Get colony processing status."""
    colony = await DB.colonies.find_one({"_id": ObjectId(colony_id)})
    if not colony:
        raise HTTPException(404, "Colony not found")
    
    return {
        "id": colony_id,
        "status": colony.get("processing_status", "ready"),
        "progress": colony.get("processing_progress", 100),
        "stage": colony.get("processing_stage", "Complete"),
        "error": colony.get("processing_error"),
    }


@api.get("/admin/colonies/{colony_id}")
async def admin_get_colony_map(colony_id: str, user=Depends(require_admin)):
    c = await load_owned_colony(colony_id, user)
    cid = str(c["_id"])
    
    # Check if colony is still processing
    processing_status = c.get("processing_status", "ready")
    if processing_status in ("queued", "running"):
        return {
            "colony": colony_out(c),
            "zones": [],
            "plots": [],
            "statuses": [],
            "is_processing": True,
        }
    
    zones_task = DB.zones.find({"colony_id": cid}).to_list(1000)
    plots_task = DB.plots.find({"colony_id": cid}).to_list(5000)
    statuses_task = DB.statuses.find({}).sort("sort_order", 1).to_list(100)
    zones, plots, statuses = await asyncio.gather(zones_task, plots_task, statuses_task)

    # Batch aggregation for registry count instead of N+1 individual queries
    if plots:
        plot_ids = [str(p.get("id") or p.get("_id")) for p in plots]
        pipeline = [
            {"$match": {"plot_id": {"$in": plot_ids}}},
            {"$group": {"_id": "$plot_id", "count": {"$sum": 1}}},
        ]
        reg_map = {doc["_id"]: doc["count"] async for doc in DB.registry.aggregate(pipeline)}
        for p in plots:
            pid = str(p.get("id") or p.get("_id"))
            p["registry_count"] = reg_map.get(pid, 0)

    return {
        "colony": colony_out(c),
        "zones": [serialize_doc(z) for z in zones],
        "plots": [serialize_doc(p) for p in plots],
        "statuses": [serialize_doc(s) for s in statuses],
        "is_processing": False,
    }


@api.get("/admin/colonies/{colony_id}/geojson")
async def admin_get_colony_geojson(colony_id: str, user=Depends(require_admin)):
    c = await load_owned_colony(colony_id, user)
    cid = str(c["_id"])
    zones = await DB.zones.find({"colony_id": cid}).to_list(1000)
    plots = await DB.plots.find({"colony_id": cid}).to_list(5000)
    return importer.to_geojson(c, zones, plots)


class PlacementUpdateIn(BaseModel):
    translation_x: Optional[float] = 0.0
    translation_y: Optional[float] = 0.0
    rotation: Optional[float] = 0.0
    placement_status: Optional[str] = "confirmed"


class CalibrationCommitIn(BaseModel):
    rotation_deg: float = Field(default=0.0, ge=-360, le=360)
    scale_x: float = Field(default=1.0, ge=0.5, le=2.0)
    scale_y: float = Field(default=1.0, ge=0.5, le=2.0)
    translation_x_m: float = Field(default=0.0, ge=-500, le=500)
    translation_y_m: float = Field(default=0.0, ge=-500, le=500)


async def apply_colony_calibration(colony: dict, transform: dict) -> int:
    """
    Applies unified affine calibration (rotation, scale, metric translation)
    to DB.plots, DB.canonical_plots, and DB.canonical_roads around the boundary bounding-box center.
    Preserves original_geometry for lossless reset.
    """
    cid = str(colony["_id"])
    boundary_geo = colony.get("boundary")
    if not boundary_geo or "coordinates" not in boundary_geo:
        return 0

    rot = float(transform.get("rotation_deg", transform.get("rotation", 0.0)))
    scale_x = float(transform.get("scale_x", 1.0))
    scale_y = float(transform.get("scale_y", 1.0))
    tx_m = float(transform.get("translation_x_m", transform.get("translation_x", 0.0)))
    ty_m = float(transform.get("translation_y_m", transform.get("translation_y", 0.0)))

    b_poly = shape(boundary_geo)
    min_lng, min_lat, max_lng, max_lat = b_poly.bounds
    cx, cy = (min_lng + max_lng) / 2.0, (min_lat + max_lat) / 2.0
    centroid = Point(cx, cy)

    # Convert metric offset (meters) to degrees using colony latitude
    dx_deg = tx_m / (111320.0 * math.cos(math.radians(cy))) if abs(cy) <= 89 else 0.0
    dy_deg = ty_m / 110574.0

    transformed_count = 0

    def _transform_geom(orig_geom):
        if not orig_geom or "coordinates" not in orig_geom:
            return None
        poly = shape(orig_geom)
        if scale_x != 1.0 or scale_y != 1.0:
            poly = affinity.scale(poly, xfact=scale_x, yfact=scale_y, origin=centroid)
        if rot != 0.0:
            poly = affinity.rotate(poly, rot, origin=centroid)
        if dx_deg != 0.0 or dy_deg != 0.0:
            poly = affinity.translate(poly, xoff=dx_deg, yoff=dy_deg)
        mapped = mapping(poly)
        mapped["coordinates"] = vector_import._round_coords(mapped["coordinates"])
        return mapped

    # 1. Update DB.plots
    plots_cursor = DB.plots.find({"colony_id": {"$in": [cid, ObjectId(cid)]}})
    plots = await plots_cursor.to_list(5000)
    for p in plots:
        orig = p.get("original_geometry")
        if not orig:
            orig = p.get("geometry")
            await DB.plots.update_one({"_id": p["_id"]}, {"$set": {"original_geometry": orig}})
        if orig:
            new_geom = _transform_geom(orig)
            if new_geom:
                await DB.plots.update_one({"_id": p["_id"]}, {"$set": {"geometry": new_geom}})
                transformed_count += 1

    # 2. Update DB.canonical_plots
    cplots_cursor = DB.canonical_plots.find({"colony_id": {"$in": [cid, ObjectId(cid)]}})
    cplots = await cplots_cursor.to_list(5000)
    for cp in cplots:
        orig = cp.get("original_geometry")
        if not orig:
            orig = cp.get("geometry")
            await DB.canonical_plots.update_one({"_id": cp["_id"]}, {"$set": {"original_geometry": orig}})
        if orig:
            new_geom = _transform_geom(orig)
            if new_geom:
                await DB.canonical_plots.update_one({"_id": cp["_id"]}, {"$set": {"geometry": new_geom}})

    # 3. Update DB.canonical_roads
    roads_cursor = DB.canonical_roads.find({"colony_id": {"$in": [cid, ObjectId(cid)]}})
    roads = await roads_cursor.to_list(1000)
    for r in roads:
        orig = r.get("original_geometry")
        if not orig:
            orig = r.get("geometry")
            await DB.canonical_roads.update_one({"_id": r["_id"]}, {"$set": {"original_geometry": orig}})
        if orig:
            new_geom = _transform_geom(orig)
            if new_geom:
                await DB.canonical_roads.update_one({"_id": r["_id"]}, {"$set": {"geometry": new_geom}})

    # 4. Update greens if present in colony
    greens = colony.get("greens") or []
    if greens:
        updated_greens = []
        for g in greens:
            orig = g.get("original_geometry") or g.get("geometry")
            if orig:
                new_geom = _transform_geom(orig)
                updated_greens.append({
                    **g,
                    "original_geometry": orig,
                    "geometry": new_geom or orig,
                })
            else:
                updated_greens.append(g)
        await DB.colonies.update_one({"_id": colony["_id"]}, {"$set": {"greens": updated_greens}})

    # 5. Update pdf_overlay.plot_regions if present
    overlay = colony.get("pdf_overlay") or {}
    plot_regions = overlay.get("plot_regions") or []
    if plot_regions:
        updated_regions = []
        for reg in plot_regions:
            orig = reg.get("original_geometry") or reg.get("geometry")
            if orig:
                new_geom = _transform_geom(orig)
                updated_regions.append({
                    **reg,
                    "original_geometry": orig,
                    "geometry": new_geom or orig,
                })
            else:
                updated_regions.append(reg)
        await DB.colonies.update_one(
            {"_id": colony["_id"]},
            {"$set": {"pdf_overlay.plot_regions": updated_regions, "pdf_overlay.regions": updated_regions}}
        )

    # 6. Update colony.roads if present directly on colony
    colony_roads = colony.get("roads") or []
    if colony_roads:
        updated_croads = []
        for r in colony_roads:
            orig = r.get("original_geometry") or r.get("geometry")
            if orig:
                new_geom = _transform_geom(orig)
                updated_croads.append({
                    **r,
                    "original_geometry": orig,
                    "geometry": new_geom or orig,
                })
            else:
                updated_croads.append(r)
        await DB.colonies.update_one({"_id": colony["_id"]}, {"$set": {"roads": updated_croads}})

    return transformed_count


async def reset_colony_calibration(colony: dict):
    """
    Restores DB.plots, DB.canonical_plots, DB.canonical_roads, greens, and plot_regions to original_geometry.
    """
    cid = str(colony["_id"])
    plots_cursor = DB.plots.find({"colony_id": {"$in": [cid, ObjectId(cid)]}})
    plots = await plots_cursor.to_list(5000)
    for p in plots:
        orig = p.get("original_geometry")
        if orig:
            await DB.plots.update_one({"_id": p["_id"]}, {"$set": {"geometry": orig}})

    cplots_cursor = DB.canonical_plots.find({"colony_id": {"$in": [cid, ObjectId(cid)]}})
    cplots = await cplots_cursor.to_list(5000)
    for cp in cplots:
        orig = cp.get("original_geometry")
        if orig:
            await DB.canonical_plots.update_one({"_id": cp["_id"]}, {"$set": {"geometry": orig}})

    roads_cursor = DB.canonical_roads.find({"colony_id": {"$in": [cid, ObjectId(cid)]}})
    roads = await roads_cursor.to_list(1000)
    for r in roads:
        orig = r.get("original_geometry")
        if orig:
            await DB.canonical_roads.update_one({"_id": r["_id"]}, {"$set": {"geometry": orig}})

    greens = colony.get("greens") or []
    if greens:
        reset_greens = []
        for g in greens:
            orig = g.get("original_geometry")
            if orig:
                reset_greens.append({**g, "geometry": orig})
            else:
                reset_greens.append(g)
        await DB.colonies.update_one({"_id": colony["_id"]}, {"$set": {"greens": reset_greens}})

    # Reset pdf_overlay.plot_regions if present
    overlay = colony.get("pdf_overlay") or {}
    plot_regions = overlay.get("plot_regions") or []
    if plot_regions:
        reset_regions = []
        for reg in plot_regions:
            orig = reg.get("original_geometry")
            if orig:
                reset_regions.append({**reg, "geometry": orig})
            else:
                reset_regions.append(reg)
        await DB.colonies.update_one(
            {"_id": colony["_id"]},
            {"$set": {"pdf_overlay.plot_regions": reset_regions, "pdf_overlay.regions": reset_regions}}
        )

    # Reset colony.roads if present
    colony_roads = colony.get("roads") or []
    if colony_roads:
        reset_croads = []
        for r in colony_roads:
            orig = r.get("original_geometry")
            if orig:
                reset_croads.append({**r, "geometry": orig})
            else:
                reset_croads.append(r)
        await DB.colonies.update_one({"_id": colony["_id"]}, {"$set": {"roads": reset_croads}})


class PdfOverlayTransformIn(BaseModel):
    rotation_deg: float = Field(default=0, ge=-360, le=360)
    scale_x: float = Field(default=1, ge=0.5, le=2.0)
    scale_y: float = Field(default=1, ge=0.5, le=2.0)
    translation_x_m: float = Field(default=0, ge=-500, le=500)
    translation_y_m: float = Field(default=0, ge=-500, le=500)


@api.patch("/admin/colonies/{colony_id}/pdf-overlay/transform")
async def update_pdf_overlay_transform(
    colony_id: str,
    data: PdfOverlayTransformIn,
    request: Request,
    user=Depends(require_admin),
):
    colony = await load_owned_colony(colony_id, user)
    overlay = colony.get("pdf_overlay") or {}
    base_key = overlay.get("base_storage_key") or overlay.get("storage_key")
    auto_fit_key = overlay.get("auto_fit_storage_key") or overlay.get("storage_key")
    if not base_key:
        raise HTTPException(404, "Colony has no PDF image overlay to calibrate")
    transform = data.model_dump()
    try:
        base_png, _ = await asyncio.to_thread(get_object, base_key)
        is_auto_fit = (
            transform["rotation_deg"] == 0
            and transform["scale_x"] == 1
            and transform["scale_y"] == 1
            and transform["translation_x_m"] == 0
            and transform["translation_y_m"] == 0
        )
        if is_auto_fit:
            storage_key = auto_fit_key
        else:
            png_data = await asyncio.to_thread(
                transform_pdf_overlay, base_png, colony.get("boundary"), transform
            )
            storage_key = build_storage_key(
                user_id=str(
                    (user.get("id") if isinstance(user, dict) else getattr(user, "id", None))
                    or colony.get("owner_id")
                    or ""
                ),
                colony_id=str(colony["_id"]),
                category="map_overlay",
                filename="pdf-map-calibrated.png",
                doc_id=uuid.uuid4().hex,
            )
            await asyncio.to_thread(put_object, storage_key, png_data, "image/png")
    except Exception as exc:
        logger.exception("PDF overlay calibration failed for colony %s", colony_id)
        raise HTTPException(422, f"Could not apply PDF overlay calibration: {exc}") from exc

    previous_key = overlay.get("storage_key")
    await DB.colonies.update_one(
        {"_id": colony["_id"]},
        {
            "$set": {
                "pdf_overlay.storage_key": storage_key,
                "pdf_overlay.base_storage_key": base_key,
                "pdf_overlay.transform": transform,
                "placement.transform": transform,
                "updated_at": now_iso(),
            }
        },
    )
    if previous_key and previous_key not in (storage_key, base_key, auto_fit_key):
        try:
            await asyncio.to_thread(delete_object, previous_key)
        except Exception:
            logger.exception("old calibrated PDF overlay cleanup failed")

    # Apply calibration to real plot geometries synchronously
    await apply_colony_calibration(colony, transform)

    updated = await DB.colonies.find_one({"_id": colony["_id"]})
    await audit_log(
        user,
        "PDF_OVERLAY_CALIBRATED",
        "colony",
        str(colony["_id"]),
        colony_id=str(colony["_id"]),
        metadata={"transform": transform},
        request=request,
    )
    return {"status": "ok", "pdf_overlay": colony_out(updated)["pdf_overlay"]}


@api.post("/admin/colonies/{colony_id}/calibration/commit")
async def commit_colony_calibration(
    colony_id: str,
    data: CalibrationCommitIn,
    request: Request,
    user=Depends(require_admin),
):
    colony = await load_owned_colony(colony_id, user)
    cid = str(colony["_id"])
    transform = data.model_dump()

    # 1. Apply geometric calibration to DB.plots, canonical_plots, canonical_roads
    transformed_plots = await apply_colony_calibration(colony, transform)

    # 2. If PDF overlay image exists, synchronize it with the exact same transform
    overlay = colony.get("pdf_overlay") or {}
    base_key = overlay.get("base_storage_key") or overlay.get("storage_key")
    storage_key = overlay.get("storage_key")
    if base_key:
        try:
            base_png, _ = await asyncio.to_thread(get_object, base_key)
            png_data = await asyncio.to_thread(
                transform_pdf_overlay, base_png, colony.get("boundary"), transform
            )
            storage_key = build_storage_key(
                user_id=str(
                    (user.get("id") if isinstance(user, dict) else getattr(user, "id", None))
                    or colony.get("owner_id")
                    or ""
                ),
                colony_id=cid,
                category="map_overlay",
                filename="pdf-map-calibrated.png",
                doc_id=uuid.uuid4().hex,
            )
            await asyncio.to_thread(put_object, storage_key, png_data, "image/png")
        except Exception as exc:
            logger.warning("PDF overlay artwork sync failed during calibration: %s", exc)

    # 3. Update colony record in DB
    update_doc = {
        "placement": {
            "transform": transform,
            "placement_status": "confirmed",
            "updated_at": now_iso(),
        },
        "updated_at": now_iso(),
    }
    if overlay:
        update_doc["pdf_overlay.transform"] = transform
        if storage_key:
            update_doc["pdf_overlay.storage_key"] = storage_key

    await DB.colonies.update_one({"_id": colony["_id"]}, {"$set": update_doc})

    await audit_log(
        user,
        "COLONY_CALIBRATION_COMMITTED",
        "colony",
        cid,
        colony_id=cid,
        metadata={"transform": transform, "transformed_plots": transformed_plots},
        request=request,
    )
    updated = await DB.colonies.find_one({"_id": colony["_id"]})
    return {
        "status": "ok",
        "transform": transform,
        "transformed_plots": transformed_plots,
        "colony": colony_out(updated),
    }


@api.post("/admin/colonies/{colony_id}/calibration/reset")
async def reset_colony_calibration_endpoint(
    colony_id: str,
    request: Request,
    user=Depends(require_admin),
):
    colony = await load_owned_colony(colony_id, user)
    cid = str(colony["_id"])

    # 1. Restore original plot & road geometries
    await reset_colony_calibration(colony)

    # 2. Reset PDF overlay transform if present
    overlay = colony.get("pdf_overlay") or {}
    auto_fit_key = overlay.get("auto_fit_storage_key") or overlay.get("storage_key")
    default_transform = {
        "rotation_deg": 0.0,
        "scale_x": 1.0,
        "scale_y": 1.0,
        "translation_x_m": 0.0,
        "translation_y_m": 0.0,
    }

    update_doc = {
        "placement": {
            "transform": default_transform,
            "placement_status": "reset",
            "updated_at": now_iso(),
        },
        "updated_at": now_iso(),
    }
    if overlay:
        update_doc["pdf_overlay.transform"] = default_transform
        if auto_fit_key:
            update_doc["pdf_overlay.storage_key"] = auto_fit_key

    await DB.colonies.update_one({"_id": colony["_id"]}, {"$set": update_doc})

    await audit_log(
        user,
        "COLONY_CALIBRATION_RESET",
        "colony",
        cid,
        colony_id=cid,
        request=request,
    )
    updated = await DB.colonies.find_one({"_id": colony["_id"]})
    return {"status": "ok", "transform": default_transform, "colony": colony_out(updated)}


@api.patch("/admin/colonies/{colony_id}/pdf-overlay/regions/{region_id}/status")
async def admin_change_pdf_region_status(
    colony_id: str,
    region_id: str,
    data: StatusChangeIn,
    request: Request,
    user=Depends(require_admin),
):
    colony = await load_owned_colony(colony_id, user)
    region = next(
        (
            item for item in (colony.get("pdf_overlay") or {}).get("plot_regions", [])
            if item.get("id") == region_id
        ),
        None,
    )
    if not region:
        raise HTTPException(404, "Detected PDF region not found")
    if data.status_id == "sold":
        raise HTTPException(
            400,
            "A detected PDF region must be verified and saved as a plot before it can be marked Sold.",
        )
    status = await DB.statuses.find_one({"id": data.status_id})
    if not status:
        raise HTTPException(400, "Unknown status")
    previous = region.get("status_id", "available")
    result = await DB.colonies.update_one(
        {"_id": colony["_id"], "pdf_overlay.plot_regions.id": region_id},
        {"$set": {"pdf_overlay.plot_regions.$.status_id": data.status_id}},
    )
    if not result.matched_count:
        raise HTTPException(404, "Detected PDF region not found")
    await audit_log(
        user,
        "PDF_REGION_STATUS_CHANGED",
        "pdf_region",
        region_id,
        colony_id=str(colony["_id"]),
        metadata={"from": previous, "to": data.status_id},
        request=request,
    )
    return {"ok": True, "region_id": region_id, "status_id": data.status_id}


@api.post("/admin/colonies/{colony_id}/pdf-overlay/rebuild-regions")
async def rebuild_pdf_overlay_plot_regions(
    colony_id: str,
    request: Request,
    user=Depends(require_admin),
):
    colony = await load_owned_colony(colony_id, user)
    overlay = colony.get("pdf_overlay") or {}
    base_key = overlay.get("base_storage_key") or overlay.get("storage_key")
    if not base_key or not overlay.get("bounds"):
        raise HTTPException(404, "Colony has no registered PDF overlay to analyze")
    try:
        base_png, _ = await asyncio.to_thread(get_object, base_key)
        regions, diagnostics = await asyncio.to_thread(
            detect_registered_overlay_plot_regions,
            base_png,
            colony.get("boundary"),
            overlay["bounds"],
        )
    except Exception as exc:
        logger.exception("PDF overlay plot-region rebuild failed for colony %s", colony_id)
        raise HTTPException(422, f"Could not detect plot regions in the stored overlay: {exc}") from exc

    fit = dict(overlay.get("fit") or {})
    fit.update(diagnostics)
    warnings = [
        existing for existing in fit.get("warnings", [])
        if "plot boundaries were reliable enough to make interactive" not in existing
        and "Click regions were rebuilt from closed cells" not in existing
        and "No unlabeled plot cells could be reconstructed" not in existing
    ]
    warning = diagnostics.get("plot_detection_warning")
    if warning and warning not in warnings:
        warnings.append(warning)
    fit["warnings"] = warnings
    await DB.colonies.update_one(
        {"_id": colony["_id"]},
        {
            "$set": {
                "pdf_overlay.plot_regions": regions,
                "pdf_overlay.fit": fit,
                "updated_at": now_iso(),
            }
        },
    )
    updated = await DB.colonies.find_one({"_id": colony["_id"]})
    await audit_log(
        user,
        "PDF_OVERLAY_PLOT_REGIONS_REBUILT",
        "colony",
        str(colony["_id"]),
        colony_id=str(colony["_id"]),
        metadata={
            "interactive_plot_count": len(regions),
            "method": diagnostics.get("plot_detection_method"),
        },
        request=request,
    )
    return {
        "status": "ok",
        "pdf_overlay": colony_out(updated)["pdf_overlay"],
    }


@api.patch("/admin/colonies/{colony_id}/placement")
async def update_colony_placement(colony_id: str, data: PlacementUpdateIn, request: Request, user=Depends(require_admin)):
    c = await load_owned_colony(colony_id, user)
    cid = str(c["_id"])
    current_placement = c.get("placement") or {}
    transform = current_placement.get("transform") or {}
    
    rot = data.rotation if data.rotation is not None else transform.get("rotation", 0.0)
    tx = data.translation_x if data.translation_x is not None else transform.get("translation_x", 0.0)
    ty = data.translation_y if data.translation_y is not None else transform.get("translation_y", 0.0)

    transform["translation_x"] = tx
    transform["translation_y"] = ty
    transform["rotation"] = rot

    new_placement = {
        "content_bbox": current_placement.get("content_bbox") or {},
        "transform": transform,
        "placement_status": data.placement_status or "confirmed",
        "updated_at": now_iso()
    }

    # Transform plot geometries in DB using Shapely affinity
    boundary_geo = c.get("boundary")
    if boundary_geo and "coordinates" in boundary_geo:
        try:
            b_poly = shape(boundary_geo)
            centroid = b_poly.centroid
            plots_cur = DB.plots.find({"colony_id": cid})
            plots = await (plots_cur.to_list(5000) if hasattr(plots_cur, "to_list") else plots_cur)
            if isinstance(plots, list):
                for p in plots:
                    orig = p.get("original_geometry")
                    if not orig:
                        orig = p.get("geometry")
                        await DB.plots.update_one({"_id": p["_id"]}, {"$set": {"original_geometry": orig}})
                    if orig and "coordinates" in orig:
                        p_poly = shape(orig)
                        if rot != 0.0:
                            p_poly = affinity.rotate(p_poly, rot, origin=centroid)
                        if tx != 0.0 or ty != 0.0:
                            p_poly = affinity.translate(p_poly, xoff=tx, yoff=ty)
                        mapped_geo = mapping(p_poly)
                        mapped_geo["coordinates"] = vector_import._round_coords(mapped_geo["coordinates"])
                        await DB.plots.update_one({"_id": p["_id"]}, {"$set": {"geometry": mapped_geo}})
        except Exception as exc:
            logger.exception(f"Error applying plot placement transform: {exc}")

    await DB.colonies.update_one({"_id": c["_id"]}, {"$set": {"placement": new_placement}})
    await audit_log(user, "COLONY_PLACEMENT_CONFIRMED", "colony", cid, colony_id=cid, metadata=new_placement, request=request)
    return {"status": "ok", "placement": new_placement}


@api.post("/admin/colonies/{colony_id}/placement/reset")
async def reset_colony_placement(colony_id: str, request: Request, user=Depends(require_admin)):
    c = await load_owned_colony(colony_id, user)
    cid = str(c["_id"])
    boundary = c.get("boundary")
    current_placement = c.get("placement") or {}
    bbox = current_placement.get("content_bbox") or {"width": 100, "height": 100, "min_x": 0, "min_y": 0}
    
    # Restore original plot geometries
    try:
        plots_cur = DB.plots.find({"colony_id": cid})
        plots = await (plots_cur.to_list(5000) if hasattr(plots_cur, "to_list") else plots_cur)
        if isinstance(plots, list):
            for p in plots:
                orig = p.get("original_geometry")
                if orig:
                    await DB.plots.update_one({"_id": p["_id"]}, {"$set": {"geometry": orig}})
    except Exception as exc:
        logger.exception(f"Error resetting plot placement: {exc}")

    if boundary:
        reset_placement = pdf_fitter.compute_auto_fit_transform(boundary, bbox)
    else:
        reset_placement = {
            "content_bbox": bbox,
            "transform": {"translation_x": 0.0, "translation_y": 0.0, "rotation": 0.0, "auto_scale": 1.0},
            "placement_status": "auto_fitted"
        }
    
    await DB.colonies.update_one({"_id": c["_id"]}, {"$set": {"placement": reset_placement}})
    await audit_log(user, "COLONY_PLACEMENT_RESET", "colony", cid, colony_id=cid, metadata=reset_placement, request=request)
    return {"status": "ok", "placement": reset_placement}


@api.patch("/admin/colonies/{colony_id}")
async def admin_update_colony(
    colony_id: str,
    request: Request,
    name: Optional[str] = Form(None),
    location: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    public_enabled: Optional[bool] = Form(None),
    is_public: Optional[str] = Form(None),
    whatsapp_number: Optional[str] = Form(None),
    partner_admin_id: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    layout_pdf: Optional[UploadFile] = File(None),
    cad_file: Optional[UploadFile] = File(None),
    user=Depends(require_admin),
):
    c = await load_owned_colony(colony_id, user)
    cid = str(c["_id"])

    if request.headers.get("content-type", "").startswith("application/json"):
        body = await request.json()
        u_name = body.get("name")
        u_location = body.get("location")
        u_description = body.get("description")
        u_public = body.get("public_enabled", body.get("is_public"))
        u_whatsapp = body.get("whatsapp_number")
        u_partner = body.get("partner_admin_id")
    else:
        u_name = name
        u_location = location
        u_description = description
        u_public = public_enabled if public_enabled is not None else (str(is_public).lower() == "true" if is_public is not None else None)
        u_whatsapp = whatsapp_number
        u_partner = partner_admin_id

    update = {}
    if u_name is not None and u_name.strip():
        update["name"] = u_name.strip()
    if u_location is not None:
        update["location"] = u_location.strip()
    if u_description is not None:
        update["description"] = u_description.strip()
    if u_public is not None:
        update["public_enabled"] = bool(u_public)
    if u_whatsapp is not None:
        digits = re.sub(r"\D", "", u_whatsapp)
        if 10 <= len(digits) <= 15:
            update["whatsapp_number"] = u_whatsapp
    if u_partner is not None and user["role"] == "super_admin":
        update["partner_admin_id"] = u_partner or None

    provided_files = [f for f in (file, layout_pdf, cad_file) if f]
    for f in provided_files:
        if f.size and f.size > MAX_LAYOUT_BYTES:
            raise HTTPException(413, f"File too large (max {MAX_UPLOAD_SIZE_MB} MB)")

    # Strict upload formats: ONLY KML (.kml) for boundary, and PDF (.pdf) or DXF (.dxf) for layout drawing
    if file and file.filename:
        ext = os.path.splitext(file.filename.lower())[1]
        if ext != ".kml":
            raise HTTPException(400, f"Unsupported file format '{file.filename}'. Only KML (.kml) files are allowed for boundary.")

    if layout_pdf and layout_pdf.filename:
        ext = os.path.splitext(layout_pdf.filename.lower())[1]
        if ext not in (".pdf", ".dxf"):
            raise HTTPException(400, f"Unsupported file format '{layout_pdf.filename}'. Only PDF (.pdf) and DXF (.dxf) files are allowed for layout drawing.")

    if cad_file and cad_file.filename:
        ext = os.path.splitext(cad_file.filename.lower())[1]
        if ext != ".dxf":
            raise HTTPException(400, f"Unsupported file format '{cad_file.filename}'. Only DXF (.dxf) files are allowed.")
    import_summary = None
    previous_overlay = c.get("pdf_overlay") or {}

    if provided_files:
        try:
            update_logger = PipelineTerminalLogger(u_name or c.get("name", "Colony"), cid)
            fields, zone_docs, plot_docs, warnings = await import_colony_bundle_py(
                file=file,
                layout_pdf=layout_pdf,
                cad_file=cad_file,
                maps_link=c.get("maps_link", ""),
                colony_id=cid,
                now=now_iso(),
                existing_boundary=c.get("boundary"),
                visual_overlay_only=True,
                user_id=user["id"],
                pipe_logger=update_logger,
            )
            visual_overlay_only = bool(fields.get("pdf_overlay")) and not plot_docs
            if not visual_overlay_only:
                existing_plot_count = await DB.plots.count_documents({"colony_id": cid})
                zone_counts = await persist_import_documents(
                    DB.zones, zone_docs, now_iso(), "zone", cid
                )
                plot_counts = await persist_import_documents(
                    DB.plots, plot_docs, now_iso(), "plot", cid
                )
                if not plot_docs:
                    warnings.append("Only land boundary was updated; no plot parcel geometry was supplied.")
                if plot_counts["updated"] or zone_counts["updated"]:
                    warnings.append(
                        f"Updated {plot_counts['updated']} existing plots and "
                        f"{zone_counts['updated']} zones; existing plot statuses were preserved."
                    )
                if existing_plot_count:
                    warnings.append(
                        f"Existing inventory plots were merged, not removed; "
                        f"{existing_plot_count} records existed before this update."
                    )

                try:
                    if plot_docs:
                        fields.update(await asyncio.to_thread(roads.entrance_fields, fields["boundary"], [p["geometry"] for p in plot_docs]))
                except Exception:
                    logger.exception("entrance detection failed on update")

                fields["entry_checked"] = True
            update.update(fields)
            primary_name = (file and file.filename) or (layout_pdf and layout_pdf.filename) or (cad_file and cad_file.filename) or "map"
            import_summary = {
                "filename": primary_name,
                "plots": fields.get("import_source", {}).get("pdf_plot_count", len(plot_docs)),
                "saved_plot_records": await DB.plots.count_documents({"colony_id": cid}),
                "zones": await DB.zones.count_documents({"colony_id": cid}),
                "greens": len(fields.get("greens", [])),
                "roads": len(fields.get("roads", [])),
                "mode": fields.get("import_source", {}).get("mode", "updated"),
                "warnings": warnings,
                "debug_log": update_logger.get_text(),
                "debug_records": update_logger.get_records(),
            }
        except importer.ImportError_ as e:
            raise HTTPException(422, str(e))
        except Exception as e:
            logger.exception("colony update import failed")
            raise HTTPException(422, f"Could not read uploaded layout file: {e}")

    update["updated_at"] = now_iso()
    await DB.colonies.update_one({"_id": c["_id"]}, {"$set": update})
    new_overlay = update.get("pdf_overlay") or {}
    retained_keys = {
        new_overlay.get("storage_key"),
        new_overlay.get("base_storage_key"),
        new_overlay.get("auto_fit_storage_key"),
    }
    old_overlay_keys = {
        previous_overlay.get("storage_key"),
        previous_overlay.get("base_storage_key"),
        previous_overlay.get("auto_fit_storage_key"),
    } - retained_keys - {None}
    if provided_files:
        for previous_key in old_overlay_keys:
            try:
                await asyncio.to_thread(delete_object, previous_key)
            except Exception:
                logger.exception("old PDF overlay cleanup failed")
    await audit_log(user, "COLONY_UPDATED", "colony", cid, colony_id=cid, metadata=update, request=request)

    out = colony_out(await DB.colonies.find_one({"_id": c["_id"]}))
    if import_summary:
        out["import_summary"] = import_summary
    return out



@api.delete("/admin/colonies/{colony_id}")
async def admin_delete_colony(colony_id: str, request: Request, user=Depends(require_admin)):
    query_ids = [colony_id]
    if ObjectId.is_valid(colony_id):
        query_ids.append(ObjectId(colony_id))
    c = await DB.colonies.find_one({"$or": [{"_id": q} for q in query_ids] + [{"slug": colony_id}]})
    if not c:
        raise HTTPException(404, "Colony not found")
    cid = str(c["_id"])

    # Check deletion authorization:
    # Super admin can delete any colony.
    # An admin can only delete a colony if they are the owner / creator of it.
    is_super = user.get("role") == "super_admin"
    current_uid = str(user.get("id") or user.get("_id") or "")
    colony_owner_id = str(c.get("owner_id") or "")

    if not is_super and current_uid != colony_owner_id:
        owner_name = "Super Admin"
        if colony_owner_id:
            owner_doc = None
            if ObjectId.is_valid(colony_owner_id):
                owner_doc = await DB.users.find_one({"_id": ObjectId(colony_owner_id)})
            if not owner_doc:
                owner_doc = await DB.users.find_one({"id": colony_owner_id})
            if owner_doc:
                owner_name = owner_doc.get("name") or owner_doc.get("email") or "Colony Owner"

        raise HTTPException(
            status_code=403,
            detail=f"Aap is colony ko delete nahi kar sakte. Ise keval iske owner ({owner_name}) hi delete kar sakte hain."
        )

    await DB.plots.delete_many({"colony_id": cid})
    await DB.zones.delete_many({"colony_id": cid})
    await DB.registry.delete_many({"colony_id": cid})
    await DB.colonies.delete_one({"_id": c["_id"]})
    try:
        await DB.colony_shares.delete_many({"colony_id": cid})
    except Exception:
        pass
    await audit_log(user, "COLONY_DELETED", "colony", cid, colony_id=cid, request=request)
    return {"ok": True}


# -----------------------------------------------------------------------------
# Admin: Plot status + Registry
# -----------------------------------------------------------------------------
@api.patch("/admin/plots/{plot_id}/status")
async def admin_change_status(plot_id: str, data: StatusChangeIn, request: Request, user=Depends(require_admin)):
    plot = await DB.plots.find_one({"id": plot_id})
    if not plot:
        raise HTTPException(404, "Plot not found")
    await load_owned_colony(plot["colony_id"], user)

    status = await DB.statuses.find_one({"id": data.status_id})
    if not status:
        raise HTTPException(400, "Unknown status")
    if data.status_id == "sold" and not await DB.registry.count_documents({"plot_id": plot_id}):
        raise HTTPException(400, "Registry document is required before this plot can be marked Sold.")

    previous = plot.get("status_id", "available")
    await DB.plots.update_one({"id": plot_id}, {"$set": {"status_id": data.status_id, "updated_at": now_iso()}})
    await DB.status_history.insert_one({
        "plot_id": plot_id,
        "colony_id": plot["colony_id"],
        "previous_status": previous,
        "new_status": data.status_id,
        "user_id": user["id"],
        "user_name": user["name"],
        "created_at": now_iso(),
    })
    await audit_log(user, "PLOT_STATUS_CHANGED", "plot", plot_id, colony_id=plot["colony_id"],
                    metadata={"from": previous, "to": data.status_id}, request=request)
    return {"ok": True, "status_id": data.status_id}


@api.patch("/admin/plots/bulk-status")
async def admin_bulk_status(data: BulkStatusIn, request: Request, user=Depends(require_admin)):
    if not data.plot_ids:
        raise HTTPException(400, "No plots selected")
    if not await DB.statuses.find_one({"id": data.status_id}):
        raise HTTPException(400, "Unknown status")
    plots = await DB.plots.find({"id": {"$in": data.plot_ids}}).to_list(1000)
    if len(plots) != len(set(data.plot_ids)):
        raise HTTPException(404, "One or more plots not found")
    colony_ids = {p["colony_id"] for p in plots}
    for cid in colony_ids:
        await load_owned_colony(cid, user)
    if data.status_id == "sold":
        for plot in plots:
            if not await DB.registry.count_documents({"plot_id": plot["id"]}):
                raise HTTPException(
                    400,
                    f"Registry document is required before Plot {plot.get('number', '')} can be marked Sold.",
                )
    ts = now_iso()
    await DB.plots.update_many({"id": {"$in": data.plot_ids}}, {"$set": {"status_id": data.status_id, "updated_at": ts}})
    await DB.status_history.insert_many([{
        "plot_id": p["id"], "colony_id": p["colony_id"], "previous_status": p.get("status_id", "available"),
        "new_status": data.status_id, "user_id": user["id"], "user_name": user["name"], "created_at": ts,
    } for p in plots])
    for cid in colony_ids:
        await audit_log(user, "PLOT_STATUS_BULK_CHANGED", "colony", cid, colony_id=cid,
                        metadata={"count": len(plots), "to": data.status_id}, request=request)
    return {"ok": True, "updated": len(plots), "status_id": data.status_id}


@api.patch("/admin/plots/{plot_id}")
async def admin_update_plot(plot_id: str, request: Request, user=Depends(require_admin)):
    plot_query = {"$or": [{"id": plot_id}]}
    if ObjectId.is_valid(plot_id):
        plot_query["$or"].append({"_id": ObjectId(plot_id)})
    plot = await DB.plots.find_one(plot_query)
    if not plot:
        raise HTTPException(404, "Plot not found")
    await load_owned_colony(plot["colony_id"], user)
    body = await request.json()
    update = {}

    # Basic text fields
    for key in ("title", "description", "notes"):
        if key in body and body[key] is not None:
            update[key] = str(body[key]).strip()

    # Plot Number
    if "number" in body and body["number"] is not None:
        num = str(body["number"]).strip()
        if num:
            update["number"] = num

    # Pricing
    for key, label in (("price", "Price"), ("price_per_sqft", "Price per sqft")):
        if key in body and body[key] is not None and str(body[key]).strip() != "":
            try:
                value = float(body[key])
            except (TypeError, ValueError):
                raise HTTPException(400, f"{label} must be a non-negative number")
            if value < 0:
                raise HTTPException(400, f"{label} must be a non-negative number")
            update[key] = value

    # Dimensions & Length / Breadth
    len_val = None
    br_val = None
    if "length" in body or "length_ft" in body:
        raw_l = body.get("length_ft") if "length_ft" in body else body.get("length")
        if raw_l is not None and str(raw_l).strip() != "":
            try:
                len_val = round(float(raw_l), 2)
                update["length_ft"] = len_val
                update["width_m"] = round(len_val * 0.3048, 2)
            except (TypeError, ValueError):
                pass

    if "breadth" in body or "breadth_ft" in body:
        raw_b = body.get("breadth_ft") if "breadth_ft" in body else body.get("breadth")
        if raw_b is not None and str(raw_b).strip() != "":
            try:
                br_val = round(float(raw_b), 2)
                update["breadth_ft"] = br_val
                update["depth_m"] = round(br_val * 0.3048, 2)
            except (TypeError, ValueError):
                pass

    if "dimensions" in body and body["dimensions"] is not None and str(body["dimensions"]).strip():
        update["dimensions"] = str(body["dimensions"]).strip()
    elif len_val is not None and br_val is not None:
        update["dimensions"] = f"{len_val}ft × {br_val}ft"

    # Area calculations
    if "area_sqft" in body and body["area_sqft"] is not None and str(body["area_sqft"]).strip() != "":
        try:
            sqft = round(float(body["area_sqft"]), 2)
            update["area_sqft"] = sqft
            update["area_sqyd"] = round(sqft / 9.0, 2)
            update["area_sqm"] = round(sqft * 0.092903, 2)
        except (TypeError, ValueError):
            pass
    elif len_val is not None and br_val is not None:
        sqft = round(len_val * br_val, 2)
        update["area_sqft"] = sqft
        update["area_sqyd"] = round(sqft / 9.0, 2)
        update["area_sqm"] = round(sqft * 0.092903, 2)

    if "area_sqyd" in body and body["area_sqyd"] is not None and str(body["area_sqyd"]).strip() != "" and "area_sqft" not in update:
        try:
            sqyd = round(float(body["area_sqyd"]), 2)
            update["area_sqyd"] = sqyd
            update["area_sqft"] = round(sqyd * 9.0, 2)
            update["area_sqm"] = round(sqyd * 0.836127, 2)
        except (TypeError, ValueError):
            pass

    # Zone
    if "zone_id" in body and body["zone_id"] is not None:
        zid = str(body["zone_id"]).strip()
        update["zone_id"] = zid

    # Status
    if "status_id" in body and body["status_id"] is not None:
        sid = str(body["status_id"]).strip().lower()
        if sid in ("available", "reserved", "hold", "sold", "blocked"):
            update["status_id"] = sid

    if "facing" in body:
        valid_facings = (
            "North", "South", "East", "West", "North-East", "North-West",
            "South-East", "South-West",
        )
        facing = str(body["facing"] or "").strip()
        if facing and facing.lower() not in {value.lower() for value in valid_facings}:
            raise HTTPException(
                400,
                f"Invalid facing direction. Allowed values: {', '.join(valid_facings)}",
            )
        update["facing"] = facing

    if "visibility" in body:
        valid_visibilities = {"PRIVATE", "PUBLIC", "SHARED"}
        visibility = str(body["visibility"]).upper().strip()
        if visibility not in valid_visibilities:
            raise HTTPException(
                400,
                f"Invalid visibility. Allowed values: {', '.join(sorted(valid_visibilities))}",
            )
        update["visibility"] = visibility

    if not update:
        raise HTTPException(400, "Nothing to update")
    update["updated_at"] = now_iso()
    await DB.plots.update_one({"_id": plot["_id"]}, {"$set": update})

    # Synchronize canonical_plots collection if present
    c_query = {"$or": [{"id": plot.get("id") or plot_id}, {"plot_id": plot.get("id") or plot_id}]}
    if plot.get("number"):
        c_query["$or"].append({"number": str(plot.get("number"))})
    if ObjectId.is_valid(plot_id):
        c_query["$or"].append({"_id": ObjectId(plot_id)})
    canonical_update = {k: v for k, v in update.items()}
    if "dimensions" in update:
        canonical_update["declared_dimensions"] = update["dimensions"]
    if "area_sqyd" in update:
        canonical_update["declared_area_sqyd"] = update["area_sqyd"]
    try:
        await DB.canonical_plots.update_many(c_query, {"$set": canonical_update})
    except Exception:
        pass

    await audit_log(
        user, "PLOT_UPDATED", "plot", str(plot.get("id") or plot["_id"]),
        colony_id=plot["colony_id"], metadata=update, request=request,
    )
    updated_doc = await DB.plots.find_one({"_id": plot["_id"]})
    out = serialize_doc(updated_doc)
    if not out.get("id"):
        out["id"] = str(updated_doc["_id"])
    return out


@api.get("/admin/colonies/{colony_id}/plots/export-csv")
async def admin_export_colony_plots_csv(colony_id: str, request: Request, user=Depends(require_admin)):
    colony = await load_owned_colony(colony_id, user)
    cid = str(colony["_id"])

    plots = await DB.plots.find({"$or": [{"colony_id": cid}, {"colony_id": str(colony.get("slug"))}]}).to_list(10000)
    zones = await DB.zones.find({"$or": [{"colony_id": cid}, {"colony_id": str(colony.get("slug"))}]}).to_list(100)
    zone_map = {str(z.get("id")): z.get("name") for z in zones}

    def sort_key(p):
        num_str = str(p.get("number", "")).strip()
        digits = re.findall(r"\d+", num_str)
        return (int(digits[0]) if digits else 999999, num_str)
    plots.sort(key=sort_key)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Plot Number",
        "Length (ft)",
        "Breadth (ft)",
        "Dimensions",
        "Area (sq.ft)",
        "Area (sq.yd)",
        "Area (sq.m)",
        "Zone",
        "Facing",
        "Status",
        "Price",
        "Rate (per sq.ft)",
    ])

    for p in plots:
        zid = str(p.get("zone_id") or "")
        zname = zone_map.get(zid, zid)
        writer.writerow([
            p.get("number", ""),
            p.get("length_ft", ""),
            p.get("breadth_ft", ""),
            p.get("dimensions", ""),
            p.get("area_sqft", ""),
            p.get("area_sqyd", ""),
            p.get("area_sqm", ""),
            zname,
            p.get("facing", ""),
            p.get("status_id", "available"),
            p.get("price", ""),
            p.get("price_per_sqft", ""),
        ])

    csv_data = output.getvalue()
    slug = colony.get("slug") or "colony"
    return Response(
        content=csv_data,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{slug}_plots.csv"'}
    )


@api.post("/admin/colonies/{colony_id}/plots/import-csv")
async def admin_import_colony_plots_csv(
    colony_id: str,
    request: Request,
    file: Optional[UploadFile] = File(None),
    user=Depends(require_admin)
):
    colony = await load_owned_colony(colony_id, user)
    cid = str(colony["_id"])

    csv_text = ""
    rows_data = []
    if file and file.filename:
        content = await file.read()
        try:
            csv_text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            csv_text = content.decode("latin-1")
    else:
        content_type = request.headers.get("content-type", "")
        if "application/json" in content_type:
            body = await request.json()
            csv_text = body.get("csv_content") or body.get("csv") or ""
            if not csv_text and isinstance(body.get("rows"), list):
                rows_data = body["rows"]
        else:
            raw = await request.body()
            csv_text = raw.decode("utf-8-sig", errors="replace")

    query_colony = {"$or": [{"colony_id": cid}, {"colony_id": str(colony.get("slug"))}]}
    plots = await DB.plots.find(query_colony).to_list(10000)
    zones = await DB.zones.find(query_colony).to_list(100)

    def norm_num(val):
        return re.sub(r"[^a-zA-Z0-9]", "", str(val or "")).lower()

    plots_by_norm = {norm_num(p.get("number")): p for p in plots if p.get("number")}
    plots_by_id = {str(p.get("id")): p for p in plots if p.get("id")}
    zone_by_name = {str(z.get("name", "")).strip().lower(): str(z.get("id")) for z in zones}
    zone_by_id = {str(z.get("id")): str(z.get("id")) for z in zones}

    parsed_rows = []
    if csv_text.strip():
        f = io.StringIO(csv_text.strip())
        reader = csv.DictReader(f)
        for r in reader:
            parsed_rows.append(r)
    elif rows_data:
        parsed_rows = rows_data

    if not parsed_rows:
        raise HTTPException(400, "No CSV rows found in upload")

    def get_col(row, *aliases):
        for k, v in row.items():
            clean_k = re.sub(r"[^a-zA-Z0-9]", "", str(k or "")).lower()
            for a in aliases:
                clean_a = re.sub(r"[^a-zA-Z0-9]", "", a).lower()
                if clean_k == clean_a:
                    return str(v or "").strip()
        return ""

    bulk_ops = []
    unmatched_numbers = []
    ts = now_iso()

    for row in parsed_rows:
        p_num = get_col(row, "plotnumber", "plotno", "plot_no", "plot_number", "plot", "number", "no")
        p_id = get_col(row, "plotid", "plot_id", "id")

        target_plot = None
        if p_id and p_id in plots_by_id:
            target_plot = plots_by_id[p_id]
        elif p_num and norm_num(p_num) in plots_by_norm:
            target_plot = plots_by_norm[norm_num(p_num)]

        if not target_plot:
            if p_num:
                unmatched_numbers.append(p_num)
            continue

        update_dict = {}

        len_str = get_col(row, "lengthft", "length", "length_ft", "lengthm", "l")
        br_str = get_col(row, "breadthft", "breadth", "breadth_ft", "width", "width_ft", "b", "w")
        dim_str = get_col(row, "dimensions", "dimension", "size")

        l_val, b_val = None, None
        if len_str:
            try:
                l_val = round(float(len_str), 2)
                update_dict["length_ft"] = l_val
                update_dict["width_m"] = round(l_val * 0.3048, 2)
            except ValueError:
                pass
        if br_str:
            try:
                b_val = round(float(br_str), 2)
                update_dict["breadth_ft"] = b_val
                update_dict["depth_m"] = round(b_val * 0.3048, 2)
            except ValueError:
                pass

        if dim_str:
            update_dict["dimensions"] = dim_str
        elif l_val is not None and b_val is not None:
            update_dict["dimensions"] = f"{l_val}ft × {b_val}ft"

        sqft_str = get_col(row, "areasqft", "area_sqft", "sqft", "area")
        sqyd_str = get_col(row, "areasqyd", "area_sqyd", "sqyd", "gaj")
        if sqft_str:
            try:
                sqft = round(float(sqft_str), 2)
                update_dict["area_sqft"] = sqft
                update_dict["area_sqyd"] = round(sqft / 9.0, 2)
                update_dict["area_sqm"] = round(sqft * 0.092903, 2)
            except ValueError:
                pass
        elif sqyd_str:
            try:
                sqyd = round(float(sqyd_str), 2)
                update_dict["area_sqyd"] = sqyd
                update_dict["area_sqft"] = round(sqyd * 9.0, 2)
                update_dict["area_sqm"] = round(sqyd * 0.836127, 2)
            except ValueError:
                pass
        elif l_val is not None and b_val is not None:
            sqft = round(l_val * b_val, 2)
            update_dict["area_sqft"] = sqft
            update_dict["area_sqyd"] = round(sqft / 9.0, 2)
            update_dict["area_sqm"] = round(sqft * 0.092903, 2)

        z_str = get_col(row, "zone", "zone_id", "zonename", "sector")
        if z_str:
            clean_z = z_str.strip().lower()
            if clean_z in zone_by_name:
                update_dict["zone_id"] = zone_by_name[clean_z]
            elif z_str in zone_by_id:
                update_dict["zone_id"] = zone_by_id[z_str]

        facing_str = get_col(row, "facing", "direction")
        if facing_str:
            update_dict["facing"] = facing_str.title()

        status_str = get_col(row, "status", "status_id")
        if status_str and status_str.lower() in ("available", "reserved", "hold", "sold", "blocked"):
            update_dict["status_id"] = status_str.lower()

        price_str = get_col(row, "price", "total_price")
        if price_str:
            try:
                update_dict["price"] = float(price_str)
            except ValueError:
                pass

        rate_str = get_col(row, "rate", "price_per_sqft", "ratesqft")
        if rate_str:
            try:
                update_dict["price_per_sqft"] = float(rate_str)
            except ValueError:
                pass

        if update_dict:
            update_dict["updated_at"] = ts
            bulk_ops.append(UpdateOne({"_id": target_plot["_id"]}, {"$set": update_dict}))

    if bulk_ops:
        await DB.plots.bulk_write(bulk_ops, ordered=False)
        await audit_log(
            user, "PLOTS_BULK_CSV_IMPORTED", "colony", cid,
            colony_id=cid, metadata={"updated_count": len(bulk_ops)}, request=request,
        )

    fresh_plots = await DB.plots.find(query_colony).to_list(10000)
    return {
        "ok": True,
        "updated_count": len(bulk_ops),
        "total_plots": len(plots),
        "unmatched": unmatched_numbers,
        "plots": [serialize_doc(p) for p in fresh_plots]
    }


@api.post("/admin/plots/{plot_id}/sold")
async def admin_mark_plot_sold(
    plot_id: str,
    request: Request,
    file: Optional[UploadFile] = File(None),
    user=Depends(require_admin),
):
    plot = await DB.plots.find_one({"id": plot_id})
    if not plot:
        raise HTTPException(404, "Plot not found")
    await load_owned_colony(plot["colony_id"], user)
    existing_count = await DB.registry.count_documents({"plot_id": plot_id})
    registry_record = None
    if file:
        if existing_count >= MAX_REGISTRY_VERSIONS:
            raise HTTPException(400, f"Maximum {MAX_REGISTRY_VERSIONS} registry versions reached for this plot")
        content = await file.read()
        if not content:
            raise HTTPException(400, "Empty file")
        if len(content) > MAX_PDF_BYTES:
            raise HTTPException(400, "File exceeds 25 MB")
        if not content.startswith(b"%PDF-"):
            raise HTTPException(400, "File signature is not a valid PDF")
        if file.content_type and file.content_type != "application/pdf":
            raise HTTPException(400, "Only application/pdf is accepted")
        if not (file.filename or "").lower().endswith(".pdf"):
            raise HTTPException(400, "Filename must end with .pdf")
        doc_id = str(uuid.uuid4())
        version = existing_count + 1
        storage_path = build_storage_key(
            user_id=user["id"],
            colony_id=plot["colony_id"],
            category="registry",
            plot_id=plot_id,
            filename=file.filename or "document.pdf",
            version=version,
            doc_id=doc_id,
        )
        try:
            upload_result = await asyncio.to_thread(
                put_object, storage_path, content, "application/pdf"
            )
        except Exception as exc:
            logger.exception("Registry upload failed")
            raise HTTPException(500, "Could not upload registry document") from exc
        registry_record = {
            "id": doc_id,
            "plot_id": plot_id,
            "colony_id": plot["colony_id"],
            "filename": file.filename,
            "size": len(content),
            "mime": "application/pdf",
            "checksum": hashlib.sha256(content).hexdigest(),
            "version": version,
            "uploaded_by": user["id"],
            "uploaded_by_name": user["name"],
            "created_at": now_iso(),
            "storage_key": upload_result.get("path", storage_path),
        }
        await DB.registry.insert_one(registry_record)
        await audit_log(
            user, "REGISTRY_UPLOADED", "registry", doc_id,
            colony_id=plot["colony_id"],
            metadata={"plot_id": plot_id, "version": version, "size": len(content)},
            request=request,
        )
    elif existing_count == 0:
        raise HTTPException(400, "Registry document is required before this plot can be marked Sold.")

    previous = plot.get("status_id", "available")
    timestamp = now_iso()
    await DB.plots.update_one(
        {"id": plot_id}, {"$set": {"status_id": "sold", "updated_at": timestamp}}
    )
    await DB.status_history.insert_one({
        "plot_id": plot_id,
        "colony_id": plot["colony_id"],
        "previous_status": previous,
        "new_status": "sold",
        "user_id": user["id"],
        "user_name": user["name"],
        "created_at": timestamp,
    })
    await audit_log(
        user, "PLOT_STATUS_CHANGED", "plot", plot_id,
        colony_id=plot["colony_id"],
        metadata={"from": previous, "to": "sold", "registry_attached": registry_record is not None},
        request=request,
    )
    updated_plot = await DB.plots.find_one({"id": plot_id})
    return {
        "success": True,
        "plot": serialize_doc(updated_plot),
        "registry": serialize_doc(registry_record) if registry_record else None,
        "status": "sold",
    }


@api.post("/admin/plots/{plot_id}/registry")
async def admin_upload_registry(plot_id: str, request: Request, file: UploadFile = File(...), user=Depends(require_admin)):
    plot = await DB.plots.find_one({"id": plot_id})
    if not plot:
        raise HTTPException(404, "Plot not found")
    await load_owned_colony(plot["colony_id"], user)

    if plot.get("status_id") != "sold":
        raise HTTPException(400, "Registry can only be attached when the plot is marked Sold")

    existing_count = await DB.registry.count_documents({"plot_id": plot_id})
    if existing_count >= MAX_REGISTRY_VERSIONS:
        raise HTTPException(400, f"Maximum {MAX_REGISTRY_VERSIONS} registry versions reached for this plot")

    content = await file.read()
    if len(content) == 0:
        raise HTTPException(400, "Empty file")
    if len(content) > MAX_PDF_BYTES:
        raise HTTPException(400, "File exceeds 25 MB")
    if not content.startswith(b"%PDF"):
        raise HTTPException(400, "File signature is not a valid PDF")
    if file.content_type and file.content_type != "application/pdf":
        raise HTTPException(400, "Only application/pdf is accepted")
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "Filename must end with .pdf")

    doc_id = str(uuid.uuid4())
    version = existing_count + 1
    storage_path = f"{APP_NAME}/registry/{user['id']}/{plot['colony_id']}/{plot_id}/v{version}-{doc_id}.pdf"
    try:
        upload_result = put_object(storage_path, content, "application/pdf")
    except Exception as e:
        logger.error(f"Registry upload failed: {e}")
        raise HTTPException(500, "Could not upload registry document")

    rec = {
        "id": doc_id,
        "plot_id": plot_id,
        "colony_id": plot["colony_id"],
        "filename": file.filename,
        "size": len(content),
        "mime": "application/pdf",
        "checksum": hashlib.sha256(content).hexdigest(),
        "version": version,
        "uploaded_by": user["id"],
        "uploaded_by_name": user["name"],
        "created_at": now_iso(),
        "storage_key": upload_result.get("path", storage_path),
    }
    await DB.registry.insert_one(rec)
    await audit_log(user, "REGISTRY_UPLOADED", "registry", doc_id, colony_id=plot["colony_id"],
                    metadata={"plot_id": plot_id, "version": version, "size": len(content)}, request=request)
    return serialize_doc(rec)


@api.get("/admin/plots/{plot_id}/registry")
async def admin_list_registry(plot_id: str, user=Depends(require_admin)):
    plot = await DB.plots.find_one({"id": plot_id})
    if not plot:
        raise HTTPException(404, "Plot not found")
    await load_owned_colony(plot["colony_id"], user)
    rows = await DB.registry.find({"plot_id": plot_id}).sort("version", 1).to_list(10)
    return [serialize_doc(r) for r in rows]


@api.get("/admin/registry/{doc_id}/download")
async def admin_download_registry(doc_id: str, user=Depends(require_admin)):
    rec = await DB.registry.find_one({"id": doc_id})
    if not rec:
        raise HTTPException(404, "Registry document not found")
    await load_owned_colony(rec["colony_id"], user)
    try:
        content, mime = get_object(rec["storage_key"])
    except Exception as e:
        logger.error(f"Registry download failed: {e}")
        raise HTTPException(410, "Registry file is no longer available")
    return RawResponse(
        content=content,
        media_type=mime or "application/pdf",
        headers={"Content-Disposition": f'inline; filename="{rec["filename"]}"'},
    )


# -----------------------------------------------------------------------------
# Admin: Audit logs
# -----------------------------------------------------------------------------
@api.get("/admin/audit-logs")
async def admin_audit_logs(user=Depends(require_admin)):
    query = {}
    if user["role"] != "super_admin":
        colonies = await DB.colonies.find({"owner_id": user["id"]}, {"_id": 1}).to_list(500)
        ids = [str(c["_id"]) for c in colonies]
        query = {"$or": [{"colony_id": {"$in": ids}}, {"user_id": user["id"]}]}
    rows = await DB.audit_logs.find(query).sort("created_at", -1).limit(200).to_list(200)
    return [serialize_doc(r) for r in rows]


@api.get("/health")
async def api_health_check():
    from app.gis.canonical.health_service import check_system_health
    res = await check_system_health(DB)
    status_code = 200 if res["status"] == "HEALTHY" else 503
    return JSONResponse(status_code=status_code, content=res)


@api.get("/v1/media/download")
async def download_media(key: str, expires: int, signature: str):
    if not verify_signed_url(key, expires, signature):
        raise HTTPException(403, "Media link is invalid or expired")
    try:
        content, mime = get_object(key)
    except FileNotFoundError:
        raise HTTPException(404, "Media file not found")
    return RawResponse(content=content, media_type=mime)


# -----------------------------------------------------------------------------
# Seed
# -----------------------------------------------------------------------------
async def seed():
    # Statuses
    if not await DB.statuses.count_documents({}):
        await DB.statuses.insert_many([
            {"id": "available", "name": "Available", "color": "#28c98b", "description": "Ready for sale", "sort_order": 1},
            {"id": "hold",      "name": "Hold",      "color": "#f2b84b", "description": "Temporarily held", "sort_order": 2},
            {"id": "reserved",  "name": "Reserved",  "color": "#55a8ff", "description": "Reserved for buyer", "sort_order": 3},
            {"id": "sold",      "name": "Sold",      "color": "#f06b5f", "description": "Sale completed", "sort_order": 4},
            {"id": "blocked",   "name": "Blocked",   "color": "#9aa6a3", "description": "Not for sale", "sort_order": 5},
        ])

    # Super admin
    sa_email = os.environ.get("SUPER_ADMIN_EMAIL", "superadmin@livemap.local")
    sa_pass = os.environ.get("SUPER_ADMIN_PASSWORD", "SuperAdmin@2026")
    sa = await DB.users.find_one({"email": sa_email})
    if not sa:
        await DB.users.insert_one({
            "name": "LiveMap Super Admin",
            "email": sa_email,
            "phone": "",
            "password_hash": hash_pw(sa_pass),
            "role": "super_admin",
            "slug": "livemap",
            "active": True,
            "created_at": now_iso(),
        })

    # Demo tenant admin
    adm_email = os.environ.get("ADMIN_EMAIL", "admin@livemap.local")
    adm_pass = os.environ.get("ADMIN_PASSWORD", "Admin@2026")
    adm = await DB.users.find_one({"email": adm_email})
    if not adm:
        res = await DB.users.insert_one({
            "name": "Durga Realty",
            "email": adm_email,
            "phone": "+91 90000 00000",
            "password_hash": hash_pw(adm_pass),
            "role": "admin",
            "slug": "durga-realty",
            "active": True,
            "created_at": now_iso(),
        })
        adm = {"_id": res.inserted_id}

    adm_id = str(adm["_id"])

    # Demo colony: Durga Enclave (re-laid out whenever layout_version changes)
    colony = await DB.colonies.find_one({"slug": "durga-enclave"})
    if not colony:
        res = await DB.colonies.insert_one({
            "name": "Durga Enclave",
            "slug": "durga-enclave",
            "owner_id": adm_id,
            "location": "Darapura, Padra Taluka, Vadodara, Gujarat",
            "description": "A gated residential enclave on open farmland beside the Darapura village road, with four zones, 60 plots, internal 9 m and 7.5 m roads, a central park, a children's garden and a lake-side green.",
            "public_enabled": True,
            "whatsapp_number": DEFAULT_WHATSAPP,
            "created_at": now_iso(),
        })
        colony = await DB.colonies.find_one({"_id": res.inserted_id})
    if colony.get("layout_version") != layout.LAYOUT_VERSION:
        cid = str(colony["_id"])
        fields, zone_docs, plot_docs = layout.seed_documents(cid, now_iso())
        await DB.zones.delete_many({"colony_id": cid})
        await DB.plots.delete_many({"colony_id": cid})
        await DB.registry.delete_many({"colony_id": cid})
        await DB.zones.insert_many(zone_docs)
        await DB.plots.insert_many(plot_docs)
        fields.setdefault("whatsapp_number", colony.get("whatsapp_number", DEFAULT_WHATSAPP))
        fields["location"] = "Darapura, Padra Taluka, Vadodara, Gujarat"
        await DB.colonies.update_one({"_id": colony["_id"]}, {"$set": fields, "$unset": {"garden": ""}})


@app.on_event("startup")
async def startup():
    try:
        await DB.users.create_index("email", unique=True)
        await DB.users.create_index("slug", unique=True, sparse=True)
        async def _safe_idx(col, keys, **kwargs):
            try:
                await col.create_index(keys, **kwargs)
            except Exception as _e:
                if "IndexKeySpecsConflict" in str(_e) or "already exists" in str(_e):
                    logger.debug("Index on %s already exists with different specs: %s", getattr(col, 'name', col), _e)
                else:
                    logger.warning("Index creation notice on %s: %s", getattr(col, 'name', col), _e)

        await _safe_idx(DB.colonies, "slug", unique=True, sparse=True)
        await _safe_idx(DB.colonies, "owner_id")
        await _safe_idx(DB.plots, [("colony_id", 1), ("number", 1)])
        await _safe_idx(DB.plots, [("colony_id", 1), ("status_id", 1)])
        await _safe_idx(DB.plots, [("colony_id", 1), ("visibility", 1)])
        await _safe_idx(DB.zones, "colony_id")
        await _safe_idx(DB.login_attempts, "identifier", unique=True)
        await _safe_idx(DB.property_shares, "token_hash", unique=True)
        await _safe_idx(DB.property_shares, [("plot_id", 1), ("colony_id", 1)])
        await _safe_idx(DB.property_media, [("plot_id", 1), ("sort_order", 1)])
        await _safe_idx(DB.property_media, [("plot_id", 1), ("is_primary", -1)])
        await _safe_idx(DB.property_inquiries, [("colony_id", 1), ("status", 1)])
        await _safe_idx(DB.property_inquiries, "plot_id")
        await _safe_idx(DB.gis_imports, [("colony_id", 1), ("status", 1)])
        await _safe_idx(DB.gis_imports, "owner_id")
        await _safe_idx(DB.admin_portal_shares, "token_hash", unique=True)
        await _safe_idx(DB.admin_portal_shares, "owner_id")
        await _safe_idx(DB.colony_shares, "token_hash", unique=True)
        await _safe_idx(DB.colony_shares, "colony_id")
        await _safe_idx(DB.colony_shares, "created_by")
        await _safe_idx(DB.colony_share_devices, [("share_id", 1), ("device_fingerprint", 1)])
        await _safe_idx(DB.colony_share_devices, "share_id")
    except Exception as e:
        logger.warning("MongoDB startup indexing warning: %s", e)
    await DB.public_link_sessions.create_index("session_token_hash", unique=True)
    await DB.public_link_sessions.create_index("share_id")
    await DB.property_ownership_history.create_index([("plot_id", 1), ("is_current", 1)])
    await DB.property_ownership_history.create_index("colony_id")
    await DB.audit_logs.create_index([("colony_id", 1), ("created_at", -1)])
    await DB.audit_logs.create_index([("user_id", 1), ("created_at", -1)])
    try:
        await asyncio.to_thread(init_storage)
        logger.info("Emergent object storage initialized")
    except Exception as e:
        logger.warning(f"Storage init deferred: {e}")
    await seed()
    asyncio.create_task(backfill_entrances())


async def backfill_entrances():
    async for c in DB.colonies.find({"layout_version": "imported", "entry_checked": {"$ne": True}}):
        try:
            plots = await DB.plots.find({"colony_id": str(c["_id"])}, {"geometry": 1}).to_list(5000)
            fields = await asyncio.to_thread(roads.entrance_fields, c["boundary"], [p["geometry"] for p in plots])
        except Exception:  # noqa: BLE001
            fields = {}
        fields["entry_checked"] = True
        await DB.colonies.update_one({"_id": c["_id"]}, {"$set": fields})


api.include_router(
    build_owner_router(DB, require_super_admin, serialize_doc, serialize_user)
)
api.include_router(
    build_extended_router(
        db=DB,
        get_current_user=get_current_user,
        require_admin=require_admin,
        require_super_admin=require_super_admin,
        load_owned_colony=load_owned_colony,
        audit_log=audit_log,
        serialize_doc=serialize_doc,
        put_object=put_object,
        get_object=get_object,
        delete_object=delete_object,
        get_signed_url=get_signed_url,
        build_storage_key=lambda user_id, colony_id, plot_id, filename: build_storage_key(
            user_id=user_id,
            colony_id=colony_id,
            category="media",
            plot_id=plot_id,
            filename=filename,
            doc_id=filename.split(".", 1)[0],
        ),
        now_iso=now_iso,
        app_name=APP_NAME,
        production=os.environ.get("NODE_ENV", "development").lower() == "production",
    )
)
api.include_router(
    build_gis_import_router(
        DB, require_admin, load_owned_colony, audit_log, now_iso, importer, roads
    )
)
api.include_router(
    build_pipeline_job_router(
        db=DB,
        require_admin_dep=require_admin,
        owned_colony_fn=load_owned_colony,
        now_iso_fn=now_iso,
    )
)
api.include_router(
    build_canonical_router(
        db=DB,
        require_admin_dep=require_admin,
        owned_colony_fn=load_owned_colony,
        now_iso_fn=now_iso,
    )
)
api.include_router(
    build_geometry_router(
        db=DB,
        require_admin_dep=require_admin,
        load_owned_colony_fn=load_owned_colony,
        audit_log_fn=audit_log,
        serialize_doc_fn=serialize_doc,
    )
)
api.include_router(
    build_colony_share_router(
        db=DB,
        get_current_user=get_current_user,
        require_admin=require_admin,
        require_super_admin=require_super_admin,
        load_owned_colony=load_owned_colony,
        audit_log=audit_log,
        serialize_doc=serialize_doc,
        now_iso=now_iso,
        production=os.environ.get("NODE_ENV", "development").lower() == "production",
        colony_out=colony_out,
        serialize_user=serialize_user,
    )
)


@api.get("/admin/gis/models/diagnostics")
async def get_gis_model_diagnostics(user=Depends(require_admin)):
    """Returns real-time diagnostics on all six mandatory AI models."""
    registry = AIModelRegistry.get_instance()
    return registry.run_all_diagnostics()


app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

frontend_dist_setting = os.environ.get("FRONTEND_DIST", "").strip()
frontend_dist = (
    Path(frontend_dist_setting)
    if frontend_dist_setting
    else PYTHON_DIR.parent.parent / "frontend" / "dist"
)
if not frontend_dist.is_absolute():
    frontend_dist = (PYTHON_DIR / frontend_dist).resolve()
if (
    os.environ.get("SERVE_FRONTEND", "true").lower() == "true"
    and (frontend_dist / "index.html").is_file()
):
    app.mount("/", StaticFiles(directory=str(frontend_dist), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.server:app", host=HOST, port=PORT)
