"""FastAPI equivalents for property shares, media, inquiries, portals and ownership.

The router is deliberately dependency-injected so it can be mounted by the
existing application without importing its global database or auth helpers.
Storage functions use the Python backend's ``(path, bytes, content_type)``
upload contract; signed URLs remain an injected integration concern.
"""
from __future__ import annotations

import asyncio
import hashlib
import inspect
import logging
import math
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pymongo import ReturnDocument

logger = logging.getLogger(__name__)

ALLOWED_IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024
INVALID_SHARE = "This property link is invalid or no longer available."


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_raw_token() -> str:
    return secrets.token_hex(32)


def validate_image_buffer(content: bytes, mime: str) -> bool:
    if not content or len(content) < 8:
        return False
    if mime == "image/jpeg":
        return content[:3] == b"\xff\xd8\xff"
    if mime == "image/png":
        return content[:4] == b"\x89PNG"
    if mime == "image/webp":
        return content[:4] == b"RIFF" and content[8:12] == b"WEBP"
    return False


def is_valid_indian_phone(phone: Any) -> bool:
    if not isinstance(phone, str) or not phone:
        return False
    digits = re.sub(r"[^0-9]", "", phone)
    return 10 <= len(digits) <= 12


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _oid_valid(value: Any) -> bool:
    try:
        return ObjectId.is_valid(value)
    except (TypeError, ValueError):
        return False


def _ip_hash(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",", 1)[0].strip()
    if not ip and request.client:
        ip = request.client.host
    return hashlib.sha256(ip.encode("utf-8")).hexdigest()[:16]


async def _invoke(callback: Callable, *args, **kwargs):
    """Invoke either async application callbacks or the Python server's sync storage helpers."""
    if inspect.iscoroutinefunction(callback):
        return await callback(*args, **kwargs)
    result = await asyncio.to_thread(callback, *args, **kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


def build_extended_router(
    *,
    db,
    get_current_user: Callable,
    require_admin: Callable,
    require_super_admin: Callable,
    load_owned_colony: Callable,
    audit_log: Callable,
    serialize_doc: Callable,
    put_object: Optional[Callable] = None,
    get_object: Optional[Callable] = None,
    delete_object: Optional[Callable] = None,
    get_signed_url: Optional[Callable] = None,
    build_storage_key: Optional[Callable] = None,
    now_iso: Optional[Callable] = None,
    app_name: str = "livemap",
    production: bool = False,
) -> APIRouter:
    """Build routes corresponding to the five Node route modules.

    Auth helper contract: current/admin/super-admin dependencies return the
    authenticated user dictionary (or raise HTTPException); ownership has
    ``load_owned_colony(colony_id, user)`` semantics. ``audit_log`` follows
    the Python server helper signature, including keyword-only context:
    ``audit_log(user, action, entity_type, entity_id, colony_id=...,
    metadata=..., request=...)``.
    """
    router = APIRouter()
    timestamp = now_iso or _now_iso

    async def admin_auth(user=Depends(get_current_user)):
        result = await _invoke(require_admin, user)
        return result if isinstance(result, dict) else user

    async def super_admin_auth(user=Depends(get_current_user)):
        result = await _invoke(require_super_admin, user)
        return result if isinstance(result, dict) else user

    async def own(colony_id: str, user: dict):
        return await _invoke(load_owned_colony, colony_id, user)

    async def audit(user, action, entity_type, entity_id, request, colony_id=None, metadata=None):
        await _invoke(
            audit_log,
            user,
            action,
            entity_type,
            entity_id,
            colony_id=colony_id,
            metadata=metadata or {},
            request=request,
        )

    def serialized(doc):
        return serialize_doc(doc)

    async def signed_url(key):
        if not get_signed_url:
            raise HTTPException(500, "Signed URL storage callback is not configured")
        try:
            return await _invoke(get_signed_url, key)
        except Exception as exc:
            logger.exception("Signed URL generation failed")
            raise HTTPException(500, "Could not create media URL") from exc

    # Property shares
    @router.post("/admin/plots/{plot_id}/shares")
    async def create_share(plot_id: str, request: Request, user=Depends(admin_auth)):
        plot = await db.collection("plots").find_one({"id": plot_id})
        if not plot:
            raise HTTPException(404, "Plot not found")
        await own(plot["colony_id"], user)
        body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
        raw_token = generate_raw_token()
        expires_at = None
        expires_in_days = body.get("expires_in_days")
        try:
            days = float(expires_in_days) if expires_in_days else 0
        except (TypeError, ValueError):
            days = 0
        if days > 0:
            expires_at = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
        max_views = None
        if body.get("max_views") not in (None, ""):
            try:
                requested = float(body["max_views"])
                if requested > 0:
                    max_views = math.floor(requested)
            except (TypeError, ValueError):
                pass
        created_at = timestamp()
        share = {
            "id": f"share-{uuid.uuid4()}",
            "plot_id": plot_id,
            "colony_id": plot["colony_id"],
            "token_hash": hash_token(raw_token),
            "created_by": user["id"],
            "created_by_name": user.get("name", ""),
            "created_at": created_at,
            "expires_at": expires_at,
            "max_views": max_views,
            "view_count": 0,
            "revoked_at": None,
            "status": "ACTIVE",
        }
        await db.collection("property_shares").insert_one(share)
        await audit(
            user, "PROPERTY_SHARE_CREATED", "plot", plot_id, request,
            colony_id=plot["colony_id"],
            metadata={"share_id": share["id"], "expires_at": expires_at, "max_views": max_views},
        )
        return {"share": {
            "id": share["id"], "plot_id": plot_id, "colony_id": plot["colony_id"],
            "raw_token": raw_token, "share_url": f"/share/{raw_token}",
            "created_at": created_at, "expires_at": expires_at, "max_views": max_views,
            "view_count": 0, "status": "ACTIVE",
        }}

    @router.get("/admin/plots/{plot_id}/shares")
    async def list_shares(plot_id: str, user=Depends(admin_auth)):
        plot = await db.collection("plots").find_one({"id": plot_id})
        if not plot:
            raise HTTPException(404, "Plot not found")
        await own(plot["colony_id"], user)
        shares = await db.collection("property_shares").find({"plot_id": plot_id}).sort("created_at", -1).to_list(None)
        now = timestamp()
        result = []
        for share in shares:
            status = share.get("status") or "ACTIVE"
            if share.get("revoked_at"):
                status = "REVOKED"
            elif share.get("expires_at") and now >= share["expires_at"]:
                status = "EXPIRED"
            elif share.get("max_views") is not None and share.get("view_count", 0) >= share["max_views"]:
                status = "EXHAUSTED"
            result.append({
                "id": share.get("id"), "plot_id": share.get("plot_id"), "colony_id": share.get("colony_id"),
                "created_at": share.get("created_at"), "created_by_name": share.get("created_by_name"),
                "expires_at": share.get("expires_at"), "revoked_at": share.get("revoked_at"),
                "max_views": share.get("max_views"), "view_count": share.get("view_count", 0),
                "status": status,
            })
        return result

    @router.delete("/admin/shares/{share_id}")
    async def revoke_share(share_id: str, request: Request, user=Depends(admin_auth)):
        share = await db.collection("property_shares").find_one({"id": share_id})
        if not share:
            raise HTTPException(404, "Share record not found")
        await own(share["colony_id"], user)
        if share.get("revoked_at"):
            return {"ok": True, "message": "Share is already revoked"}
        revoked_at = timestamp()
        await db.collection("property_shares").update_one(
            {"id": share_id}, {"$set": {"revoked_at": revoked_at, "status": "REVOKED"}}
        )
        await audit(
            user, "PROPERTY_SHARE_REVOKED", "plot", share["plot_id"], request,
            colony_id=share["colony_id"], metadata={"share_id": share_id},
        )
        return {"ok": True, "status": "REVOKED", "revoked_at": revoked_at}

    @router.get("/share/{token}")
    async def public_share(token: str, request: Request):
        token = token.strip()
        if len(token) < 16:
            raise HTTPException(404, INVALID_SHARE)
        shares = db.collection("property_shares")
        share = await shares.find_one({"token_hash": hash_token(token)})
        if not share:
            raise HTTPException(404, INVALID_SHARE)
        now = timestamp()
        if (
            share.get("revoked_at")
            or (share.get("expires_at") and now >= share["expires_at"])
            or (share.get("max_views") is not None and share.get("view_count", 0) >= share["max_views"])
        ):
            raise HTTPException(404, INVALID_SHARE)
        # Use one atomic predicate for expiry, revocation, and view-limit checks.
        updated = await shares.find_one_and_update(
            {
                "_id": share["_id"],
                "revoked_at": None,
                "$and": [
                    {"$or": [{"expires_at": None}, {"expires_at": {"$gt": now}}]},
                    {"$or": [
                        {"max_views": None},
                        {"$expr": {"$lt": ["$view_count", "$max_views"]}},
                    ]},
                ],
            },
            {"$inc": {"view_count": 1}},
            return_document=ReturnDocument.AFTER,
        )
        if not updated:
            raise HTTPException(404, INVALID_SHARE)
        try:
            await db.collection("share_access_logs").insert_one({
                "share_id": share.get("id"), "plot_id": share.get("plot_id"),
                "colony_id": share.get("colony_id"), "accessed_at": now,
                "ip_hash": _ip_hash(request), "user_agent": request.headers.get("user-agent", "")[:150],
                "status": "SUCCESS",
            })
        except Exception:
            pass
        plot = await db.collection("plots").find_one({"id": share["plot_id"]})
        if not plot:
            raise HTTPException(404, INVALID_SHARE)
        colony_id = plot.get("colony_id")
        colony = await db.collection("colonies").find_one({"_id": ObjectId(colony_id)}) if _oid_valid(colony_id) else None
        if not colony:
            raise HTTPException(404, INVALID_SHARE)
        zone = await db.collection("zones").find_one({"id": plot.get("zone_id")})
        status = await db.collection("statuses").find_one({"id": plot.get("status_id")})
        public_plot = {
            "id": plot.get("id"), "number": plot.get("number"), "title": plot.get("title") or "",
            "description": plot.get("description") or "", "price": plot.get("price"),
            "price_per_sqft": plot.get("price_per_sqft"), "facing": plot.get("facing") or "",
            "visibility": plot.get("visibility") or "SHARED", "area_sqm": plot.get("area_sqm"),
            "area_sqft": plot.get("area_sqft"), "area_sqyd": plot.get("area_sqyd"),
            "dimensions": plot.get("dimensions"), "shape": plot.get("shape"),
            "status_id": plot.get("status_id"), "geometry": plot.get("geometry"),
            "zone": {"name": zone.get("name"), "color": zone.get("color"), "code": zone.get("code")} if zone else None,
            "status": {"name": status.get("name"), "color": status.get("color")} if status else None,
        }
        public_colony = {
            "name": colony.get("name"), "location": colony.get("location") or "",
            "whatsapp_number": colony.get("whatsapp_number") or "",
            "map_center": colony.get("map_center"), "boundary": colony.get("boundary"),
        }
        media = await db.collection("property_media").find({"plot_id": plot["id"]}).sort(
            [("is_primary", -1), ("sort_order", 1), ("created_at", 1)]
        ).to_list(None)
        public_media = [{
            "id": item.get("id"), "title": item.get("title") or "", "alt_text": item.get("alt_text") or "",
            "is_primary": bool(item.get("is_primary")), "sort_order": item.get("sort_order") or 1,
            "url": await signed_url(item.get("storage_key")),
        } for item in media]
        return {"property": public_plot, "colony": public_colony, "media": public_media}

    # Property media
    @router.post("/admin/plots/{plot_id}/media")
    async def upload_media(
        plot_id: str,
        request: Request,
        file: Optional[UploadFile] = File(None),
        title: str = Form(""),
        alt_text: str = Form(""),
        user=Depends(admin_auth),
    ):
        if not file:
            raise HTTPException(422, "Image file required")
        plot = await db.collection("plots").find_one({"id": plot_id})
        if not plot:
            raise HTTPException(404, "Plot not found")
        await own(plot["colony_id"], user)
        content = await file.read()
        if not content:
            raise HTTPException(400, "Empty image file")
        if len(content) > MAX_IMAGE_BYTES:
            raise HTTPException(400, "Image exceeds maximum allowed size of 10 MB")
        mime = (file.content_type or "").lower()
        if mime not in ALLOWED_IMAGE_MIMES:
            raise HTTPException(400, "Invalid image format. Allowed: JPEG, PNG, WEBP")
        if not validate_image_buffer(content, mime):
            raise HTTPException(400, "Image content signature mismatch")
        collection = db.collection("property_media")
        count = await collection.count_documents({"plot_id": plot_id})
        media_id = str(uuid.uuid4())
        extension = { "image/png": ".png", "image/webp": ".webp" }.get(mime, ".jpg")
        safe_name = re.sub(r"[^a-zA-Z0-9._-]", "_", file.filename or "property.jpg")
        storage_path = (
            build_storage_key(user["id"], plot["colony_id"], plot_id, f"{media_id}{extension}")
            if build_storage_key else
            f"{app_name}/media/{user['id']}/{plot['colony_id']}/{plot_id}/{media_id}{extension}"
        )
        if not put_object:
            raise HTTPException(500, "Object storage upload callback is not configured")
        try:
            uploaded = await _invoke(put_object, storage_path, content, mime)
        except Exception as exc:
            logger.exception("Property media upload failed")
            raise HTTPException(500, "Could not store property image") from exc
        created = timestamp()
        record = {
            "id": media_id, "plot_id": plot_id, "colony_id": plot["colony_id"],
            "filename": safe_name, "mime": mime, "size": len(content),
            "checksum": hashlib.sha256(content).hexdigest(),
            "storage_key": (uploaded or {}).get("path", storage_path),
            "title": title or "", "alt_text": alt_text or "", "sort_order": count + 1,
            "is_primary": count == 0, "uploaded_by": user["id"],
            "created_at": created, "updated_at": created,
        }
        await collection.insert_one(record)
        await audit(
            user, "PROPERTY_MEDIA_UPLOADED", "property_media", media_id, request,
            colony_id=plot["colony_id"],
            metadata={"plot_id": plot_id, "size": len(content), "mime": mime},
        )
        return {**serialized(record), "url": await signed_url(record["storage_key"])}

    @router.get("/admin/plots/{plot_id}/media")
    async def list_media(plot_id: str, user=Depends(admin_auth)):
        plot = await db.collection("plots").find_one({"id": plot_id})
        if not plot:
            raise HTTPException(404, "Plot not found")
        await own(plot["colony_id"], user)
        rows = await db.collection("property_media").find({"plot_id": plot_id}).sort(
            [("is_primary", -1), ("sort_order", 1), ("created_at", 1)]
        ).to_list(None)
        return [{**serialized(item), "url": await signed_url(item.get("storage_key"))} for item in rows]

    @router.patch("/admin/media/{media_id}")
    async def update_media(media_id: str, request: Request, user=Depends(admin_auth)):
        media = await db.collection("property_media").find_one({"id": media_id})
        if not media:
            raise HTTPException(404, "Property media not found")
        await own(media["colony_id"], user)
        body = await request.json()
        updates = {"updated_at": timestamp()}
        if body.get("title") is not None:
            updates["title"] = str(body["title"])[:150]
        if body.get("alt_text") is not None:
            updates["alt_text"] = str(body["alt_text"])[:150]
        if body.get("sort_order") is not None:
            try:
                updates["sort_order"] = float(body["sort_order"])
                if updates["sort_order"].is_integer():
                    updates["sort_order"] = int(updates["sort_order"])
            except (TypeError, ValueError):
                pass
        if body.get("is_primary") is True:
            await db.collection("property_media").update_many(
                {"plot_id": media["plot_id"]}, {"$set": {"is_primary": False}}
            )
            updates["is_primary"] = True
        await db.collection("property_media").update_one({"id": media_id}, {"$set": updates})
        updated = await db.collection("property_media").find_one({"id": media_id})
        await audit(
            user, "PROPERTY_MEDIA_UPDATED", "property_media", media_id, request,
            colony_id=media["colony_id"], metadata={"plot_id": media["plot_id"], "updates": updates},
        )
        return {**serialized(updated), "url": await signed_url(updated.get("storage_key"))}

    @router.delete("/admin/media/{media_id}")
    async def delete_media(media_id: str, request: Request, user=Depends(admin_auth)):
        media = await db.collection("property_media").find_one({"id": media_id})
        if not media:
            raise HTTPException(404, "Property media not found")
        await own(media["colony_id"], user)
        if delete_object:
            try:
                await _invoke(delete_object, media["storage_key"])
            except Exception as exc:
                logger.warning("Storage object deletion failed or file missing: %s", exc)
        else:
            logger.warning("Object storage delete callback is not configured; removing media metadata only")
        await db.collection("property_media").delete_one({"id": media_id})
        if media.get("is_primary"):
            next_rows = await db.collection("property_media").find({"plot_id": media["plot_id"]}).sort(
                [("sort_order", 1), ("created_at", 1)]
            ).limit(1).to_list(1)
            if next_rows:
                await db.collection("property_media").update_one(
                    {"id": next_rows[0]["id"]}, {"$set": {"is_primary": True}}
                )
        await audit(
            user, "PROPERTY_MEDIA_DELETED", "property_media", media_id, request,
            colony_id=media["colony_id"],
            metadata={"plot_id": media["plot_id"], "filename": media["filename"]},
        )
        return {"ok": True, "id": media_id}

    # Property inquiries
    @router.post("/public/inquiries")
    async def submit_inquiry(request: Request):
        body = await request.json()
        if body.get("fax_number") or body.get("website_url"):
            return {"ok": True, "message": "Thank you. Your inquiry has been received."}
        share_token = body.get("share_token")
        name, phone, email, message = (
            body.get("name"), body.get("phone"), body.get("email"), body.get("message")
        )
        name_value = name.strip() if isinstance(name, str) and name else "Interested Buyer"
        if not phone or not is_valid_indian_phone(phone):
            raise HTTPException(400, "Valid 10-digit phone number is required")
        if not isinstance(message, str) or not message.strip():
            raise HTTPException(400, "Message content is required")
        plot_id, colony_id, share_id = body.get("plot_id"), body.get("colony_id"), None
        if share_token:
            share = await db.collection("property_shares").find_one({"token_hash": hash_token(str(share_token))})
            if not share or share.get("revoked_at"):
                raise HTTPException(404, "Invalid or unavailable property link")
            plot_id, colony_id, share_id = share["plot_id"], share["colony_id"], share.get("id")
        if not plot_id or not colony_id:
            raise HTTPException(400, "Target property must be specified")
        ip_hash = _ip_hash(request)
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
        recent = await db.collection("property_inquiries").count_documents({
            "ip_hash": ip_hash, "created_at": {"$gt": cutoff},
        })
        if recent >= 5:
            raise HTTPException(429, "Too many inquiry submissions. Please try again in 15 minutes.")
        created = timestamp()
        record = {
            "id": str(uuid.uuid4()), "plot_id": str(plot_id), "colony_id": str(colony_id),
            "share_id": share_id, "name": name_value[:100],
            "phone": re.sub(r"[^0-9+]", "", phone)[:15],
            "email": str(email).strip()[:100] if email else "",
            "message": message.strip()[:1000], "status": "NEW", "ip_hash": ip_hash,
            "created_at": created, "updated_at": created,
        }
        await db.collection("property_inquiries").insert_one(record)
        return {"ok": True, "message": "Thank you. Your inquiry has been submitted successfully."}

    @router.get("/admin/inquiries")
    async def list_inquiries(request: Request, user=Depends(admin_auth)):
        colony_id, status, plot_id = (
            request.query_params.get("colony_id"), request.query_params.get("status"),
            request.query_params.get("plot_id"),
        )
        query = {}
        if colony_id:
            await own(str(colony_id), user)
            query["colony_id"] = str(colony_id)
        elif user.get("role") != "super_admin":
            colonies = await db.collection("colonies").find({"owner_id": user["id"]}).to_list(None)
            query["colony_id"] = {"$in": [str(c["_id"]) for c in colonies]}
        if status:
            query["status"] = str(status)
        if plot_id:
            query["plot_id"] = str(plot_id)
        rows = await db.collection("property_inquiries").find(query).sort("created_at", -1).limit(200).to_list(200)
        return [serialized(row) for row in rows]

    @router.patch("/admin/inquiries/{inquiry_id}")
    async def update_inquiry(inquiry_id: str, request: Request, user=Depends(admin_auth)):
        inquiry = await db.collection("property_inquiries").find_one({"id": inquiry_id})
        if not inquiry:
            raise HTTPException(404, "Inquiry not found")
        await own(inquiry["colony_id"], user)
        status = (await request.json()).get("status")
        if status not in ("NEW", "CONTACTED", "CLOSED"):
            raise HTTPException(400, "Invalid status. Allowed: NEW, CONTACTED, CLOSED")
        await db.collection("property_inquiries").update_one(
            {"id": inquiry_id}, {"$set": {"status": status, "updated_at": timestamp()}}
        )
        await audit(
            user, "PROPERTY_INQUIRY_STATUS_UPDATED", "property_inquiries", inquiry_id, request,
            colony_id=inquiry["colony_id"],
            metadata={"plot_id": inquiry["plot_id"], "old_status": inquiry["status"], "new_status": status},
        )
        return serialized(await db.collection("property_inquiries").find_one({"id": inquiry_id}))

    # Admin public portal and session-restricted portal/preview endpoints.
    @router.get("/admin/public-portal")
    async def get_admin_portal(user=Depends(admin_auth)):
        portal = await db.collection("admin_portal_shares").find_one({
            "admin_id": user["id"], "status": {"$in": ["ACTIVE", "EXPIRED", "DEVICE_LIMIT_BREACHED"]},
        })
        if not portal:
            return {"portal": None}
        count = await db.collection("public_link_sessions").count_documents({
            "portal_share_id": str(portal["_id"]), "status": "ACTIVE",
        })
        return {"portal": {
            "id": str(portal["_id"]), "status": portal.get("status"),
            "access_mode": portal.get("access_mode"), "duration_minutes": portal.get("duration_minutes"),
            "max_devices": portal.get("max_devices"), "created_at": portal.get("created_at"),
            "expires_at": portal.get("expires_at"), "active_sessions_count": count,
        }}

    @router.post("/admin/public-portal", status_code=201)
    async def create_admin_portal(request: Request, user=Depends(admin_auth)):
        body = await request.json()
        mode = "DEVICE_BASED" if body.get("access_mode") == "DEVICE_BASED" else "TIME_BASED"
        try:
            duration = float(body.get("duration_minutes") or 10)
        except (TypeError, ValueError):
            duration = 10
        try:
            devices = float(body.get("max_devices") or 5)
        except (TypeError, ValueError):
            devices = 5
        now = timestamp()
        existing = await db.collection("admin_portal_shares").find(
            {"admin_id": user["id"], "status": "ACTIVE"}
        ).to_list(None)
        for old in existing:
            await db.collection("admin_portal_shares").update_one(
                {"_id": old["_id"]}, {"$set": {"status": "REVOKED", "revoked_at": now}}
            )
            await db.collection("public_link_sessions").update_many(
                {"portal_share_id": str(old["_id"])}, {"$set": {"status": "REVOKED", "revoked_at": now}}
            )
        raw_token = generate_raw_token()
        expires = (datetime.now(timezone.utc) + timedelta(minutes=duration)).isoformat() if mode == "TIME_BASED" else None
        portal = {
            "admin_id": user["id"], "owner_id": user["id"], "token_hash": hash_token(raw_token),
            "status": "ACTIVE", "access_mode": mode, "duration_minutes": duration, "max_devices": devices,
            "created_at": now, "expires_at": expires, "revoked_at": None,
            "created_by": user.get("name") or user.get("email"),
        }
        inserted = await db.collection("admin_portal_shares").insert_one(portal)
        portal_id = str(inserted.inserted_id)
        await audit(
            user, "PUBLIC_PORTAL_CREATED", "admin_portal_share", portal_id, request,
            metadata={"access_mode": mode, "duration_minutes": duration, "max_devices": devices},
        )
        return {"portal": {
            "id": portal_id, "raw_token": raw_token, "portal_url": f"/portal/{raw_token}",
            "status": "ACTIVE", "access_mode": mode, "duration_minutes": duration,
            "max_devices": devices, "created_at": now, "expires_at": expires,
        }}

    @router.post("/admin/public-portal/revoke")
    async def revoke_admin_portal(request: Request, user=Depends(admin_auth)):
        now = timestamp()
        portals = await db.collection("admin_portal_shares").find(
            {"admin_id": user["id"], "status": "ACTIVE"}
        ).to_list(None)
        for portal in portals:
            await db.collection("admin_portal_shares").update_one(
                {"_id": portal["_id"]}, {"$set": {"status": "REVOKED", "revoked_at": now}}
            )
            await db.collection("public_link_sessions").update_many(
                {"portal_share_id": str(portal["_id"])}, {"$set": {"status": "REVOKED", "revoked_at": now}}
            )
            await audit(user, "PUBLIC_PORTAL_REVOKED", "admin_portal_share", str(portal["_id"]), request)
        return {"success": True, "message": "Public portal link revoked successfully"}

    async def validate_portal_session(request: Request):
        token = request.cookies.get("portal_session_token")
        if not token and request.headers.get("authorization", "").startswith("Bearer "):
            token = request.headers["authorization"][7:]
        if not token:
            raise HTTPException(401, "No active portal session found")
        session = await db.collection("public_link_sessions").find_one({"session_token_hash": hash_token(token)})
        if not session or session.get("status") != "ACTIVE":
            raise HTTPException(403, "Public portal session is invalid or expired")
        portal_id = session.get("portal_share_id")
        portal = await db.collection("admin_portal_shares").find_one(
            {"_id": ObjectId(portal_id)} if _oid_valid(portal_id) else {"_id": portal_id}
        )
        if not portal or portal.get("status") != "ACTIVE":
            raise HTTPException(403, "Public portal access has been revoked or invalidated")
        now = timestamp()
        if portal.get("access_mode") == "TIME_BASED" and portal.get("expires_at") and portal["expires_at"] < now:
            raise HTTPException(403, "Public portal session has expired")
        return session, portal

    @router.post("/public/portal/{token}/session")
    async def create_portal_session(token: str, response: Response):
        portal = await db.collection("admin_portal_shares").find_one({"token_hash": hash_token(token)})
        if not portal:
            raise HTTPException(404, "Public portal link is invalid or expired")
        now = timestamp()
        if portal.get("status") in ("REVOKED", "DEVICE_LIMIT_BREACHED"):
            raise HTTPException(403, "Public portal link has been revoked or invalidated")
        if portal.get("access_mode") == "TIME_BASED" and portal.get("expires_at") and portal["expires_at"] < now:
            await db.collection("admin_portal_shares").update_one(
                {"_id": portal["_id"]}, {"$set": {"status": "EXPIRED"}}
            )
            raise HTTPException(403, "Public portal session link has expired")
        portal_id = str(portal["_id"])
        count = await db.collection("public_link_sessions").count_documents({
            "portal_share_id": portal_id, "status": "ACTIVE",
        })
        if count >= portal["max_devices"]:
            await db.collection("admin_portal_shares").update_one(
                {"_id": portal["_id"]},
                {"$set": {"status": "DEVICE_LIMIT_BREACHED", "revoked_at": now}},
            )
            await db.collection("public_link_sessions").update_many(
                {"portal_share_id": portal_id},
                {"$set": {"status": "DEVICE_LIMIT_BREACHED", "revoked_at": now}},
            )
            raise HTTPException(403, "Maximum device limit reached. Public portal link has been globally invalidated.")
        raw = generate_raw_token()
        await db.collection("public_link_sessions").insert_one({
            "portal_share_id": portal_id, "admin_id": portal.get("admin_id"),
            "session_token_hash": hash_token(raw), "status": "ACTIVE", "created_at": now,
            "last_seen_at": now, "expires_at": portal.get("expires_at"),
        })
        response.set_cookie(
            "portal_session_token", raw, httponly=True, secure=production,
            samesite="lax", max_age=3600,
        )
        return {"success": True, "session_token": raw, "portal": {
            "admin_id": portal.get("admin_id"), "access_mode": portal.get("access_mode"),
            "expires_at": portal.get("expires_at"),
        }}

    @router.get("/public/portal/session/colonies")
    async def portal_colonies(request: Request):
        _, portal = await validate_portal_session(request)
        rows = await db.collection("colonies").find({
            "owner_id": portal["admin_id"], "public_enabled": True,
        }).sort("created_at", -1).to_list(None)
        result = []
        for colony in rows:
            cid = str(colony["_id"])
            count = await db.collection("plots").count_documents({"colony_id": cid, "status_id": "available"})
            result.append({
                "id": cid, "name": colony.get("name"), "slug": colony.get("slug"),
                "location": colony.get("location") or "", "description": colony.get("description") or "",
                "available_plots": count,
            })
        return {"colonies": result}

    @router.get("/public/portal/session/colonies/{colony_id}/plots")
    async def portal_colony_plots(colony_id: str, request: Request):
        _, portal = await validate_portal_session(request)
        if not _oid_valid(colony_id):
            raise HTTPException(404, "Colony not found")
        colony = await db.collection("colonies").find_one({
            "_id": ObjectId(colony_id), "owner_id": portal["admin_id"], "public_enabled": True,
        })
        if not colony:
            raise HTTPException(404, "Colony not found")
        cid = str(colony["_id"])
        plots = await db.collection("plots").find({"colony_id": cid}).to_list(None)
        return {
            "colony": {"id": cid, "name": colony.get("name"), "location": colony.get("location")},
            "plots": [{
                "id": str(plot["_id"]), "number": plot.get("number") or plot.get("plot_number"),
                "status_id": plot.get("status_id"), "area_sqft": plot.get("area_sqft"),
                "price": plot.get("price") or None, "facing": plot.get("facing") or None,
                "geometry": plot.get("geometry"),
            } for plot in plots],
        }

    @router.post("/admin/colonies/{colony_id}/preview-session")
    async def create_preview_session(colony_id: str, request: Request, response: Response, user=Depends(admin_auth)):
        colony = await own(colony_id, user)
        cid = str(colony["_id"])
        preview_token = colony.get("preview_token")
        if not preview_token:
            preview_token = secrets.token_hex(16)
            await db.collection("colonies").update_one(
                {"_id": colony["_id"]}, {"$set": {"preview_token": preview_token}}
            )
        now = timestamp()
        raw = generate_raw_token()
        await db.collection("preview_link_sessions").insert_one({
            "colony_id": cid, "user_id": user["id"], "user_role": user["role"],
            "preview_token": preview_token, "session_token_hash": hash_token(raw),
            "status": "ACTIVE", "created_at": now, "last_seen_at": now,
        })
        response.set_cookie(
            "preview_session_token", raw, httponly=True, secure=production,
            samesite="lax", max_age=86400,
        )
        await audit(
            user, "PREVIEW_AUTHORIZED", "colony", cid, request, colony_id=cid,
            metadata={"preview_token": preview_token},
        )
        return {"success": True, "preview_token": preview_token, "preview_url": f"/preview/{preview_token}"}

    async def validate_preview(request: Request, preview_token: str):
        token = request.cookies.get("preview_session_token")
        if not token and request.headers.get("authorization", "").startswith("Bearer "):
            token = request.headers["authorization"][7:]
        if not token:
            raise HTTPException(403, "Preview access denied. Please click Preview from your panel.")
        session = await db.collection("preview_link_sessions").find_one({
            "session_token_hash": hash_token(token), "status": "ACTIVE",
        })
        if not session:
            raise HTTPException(403, "Preview session is invalid or expired")
        colony = await db.collection("colonies").find_one({"preview_token": preview_token})
        if not colony:
            raise HTTPException(404, "Preview property not found")
        if session.get("colony_id") != str(colony["_id"]):
            raise HTTPException(403, "Preview session does not authorize access to this property")
        return colony

    @router.get("/preview/{preview_token}")
    async def preview_info(preview_token: str, request: Request):
        colony = await validate_preview(request, preview_token)
        return {
            "success": True, "colony_id": str(colony["_id"]), "slug": colony.get("slug"),
            "name": colony.get("name"), "location": colony.get("location"),
        }

    @router.get("/preview/{preview_token}/data")
    async def preview_data(preview_token: str, request: Request):
        colony = await validate_preview(request, preview_token)
        cid = str(colony["_id"])
        zones = await db.collection("zones").find({"colony_id": cid}).to_list(None)
        plots = await db.collection("plots").find(
            {"colony_id": cid}, projection={"notes": 0}
        ).to_list(None)
        statuses = await db.collection("statuses").find({}).sort("sort_order", 1).to_list(None)
        owner_id = colony.get("owner_id") or ""
        owner = await db.collection("users").find_one({"_id": ObjectId(owner_id)}) if _oid_valid(owner_id) else None
        return {
            "colony": {
                "id": cid, "name": colony.get("name"), "slug": colony.get("slug"),
                "map_center": colony.get("map_center"), "boundary": colony.get("boundary"),
                "entry_road": colony.get("entry_road"), "entrance": colony.get("entrance"),
                "entry_centerline": colony.get("entry_centerline"), "roads": colony.get("roads") or [],
                "greens": colony.get("greens") or [], "location": colony.get("location") or "",
                "whatsapp_number": colony.get("whatsapp_number"),
                "pdf_overlay": (
                    {
                        "url": get_signed_url((colony.get("pdf_overlay") or {}).get("storage_key"), 86400),
                        "bounds": (colony.get("pdf_overlay") or {}).get("bounds"),
                        "plot_regions": (colony.get("pdf_overlay") or {}).get("plot_regions") or [],
                        "plot_count": (colony.get("pdf_overlay") or {}).get("plot_count"),
                        "transform": (colony.get("pdf_overlay") or {}).get("transform") or {
                            "rotation_deg": 0,
                            "scale_x": 1,
                            "scale_y": 1,
                            "translation_x_m": 0,
                            "translation_y_m": 0,
                        },
                    }
                    if get_signed_url and (colony.get("pdf_overlay") or {}).get("storage_key")
                    else None
                ),
            },
            "zones": [serialized(row) for row in zones],
            "plots": [serialized(row) for row in plots],
            "statuses": [serialized(row) for row in statuses],
            "owner": {"name": owner.get("name"), "email": owner.get("email"), "slug": owner.get("slug")} if owner else None,
        }

    # Ownership lineage
    @router.get("/admin/plots/{plot_id}/ownership")
    async def get_ownership(plot_id: str, user=Depends(admin_auth)):
        plot = await db.collection("plots").find_one({"id": plot_id})
        if not plot:
            raise HTTPException(404, "Plot not found")
        await own(plot["colony_id"], user)
        history = await db.collection("property_ownership_history").find(
            {"plot_id": plot_id}
        ).sort("created_at", 1).to_list(None)
        current = next((row for row in history if row.get("effective_to") is None), history[-1] if history else None)
        return {
            "plot_id": plot_id, "colony_id": plot["colony_id"],
            "current_owner": {
                "party_name": current.get("party_name"), "party_phone": current.get("party_phone"),
                "party_email": current.get("party_email"), "ownership_type": current.get("ownership_type"),
                "effective_from": current.get("effective_from"),
            } if current else None,
            "history": [{
                "id": str(row["_id"]), "ownership_type": row.get("ownership_type"),
                "transaction_type": row.get("transaction_type"), "party_name": row.get("party_name"),
                "party_phone": row.get("party_phone") or "", "party_email": row.get("party_email") or "",
                "effective_from": row.get("effective_from"), "effective_to": row.get("effective_to"),
                "previous_ownership_id": row.get("previous_ownership_id") or None,
                "registry_id": row.get("registry_id") or None, "registry_version": row.get("registry_version") or None,
                "created_by_name": row.get("created_by_name") or "", "created_at": row.get("created_at"),
            } for row in history],
        }

    @router.post("/admin/plots/{plot_id}/ownership/transfer", status_code=201)
    async def transfer_ownership(plot_id: str, request: Request, user=Depends(admin_auth)):
        plot = await db.collection("plots").find_one({"id": plot_id})
        if not plot:
            raise HTTPException(404, "Plot not found")
        await own(plot["colony_id"], user)
        body = await request.json()
        party_name = str(body.get("party_name") or "").strip()
        if not party_name:
            raise HTTPException(400, "New owner name is required")
        party_phone = str(body.get("party_phone") or "").strip()
        party_email = str(body.get("party_email") or "").strip()
        transaction_type = body.get("transaction_type") or "RESALE"
        effective_from = body.get("effective_from") or timestamp()
        registry_id = body.get("registry_id") or None
        history = await db.collection("property_ownership_history").find(
            {"plot_id": plot_id}
        ).sort("created_at", 1).to_list(None)
        previous = next((row for row in history if row.get("effective_to") is None), history[-1] if history else None)
        ownership_type = "RESELLER" if previous else "ORIGINAL_BUYER"
        now = timestamp()
        new_id = ObjectId()
        if previous:
            await db.collection("property_ownership_history").update_one(
                {"_id": previous["_id"]}, {"$set": {"effective_to": effective_from, "updated_at": now}}
            )
        registry_version = None
        if registry_id:
            registry = await db.collection("registry").find_one({"id": registry_id, "plot_id": plot_id})
            if registry:
                registry_version = registry.get("version")
                await db.collection("registry").update_one(
                    {"id": registry_id}, {"$set": {"ownership_id": str(new_id)}}
                )
        record = {
            "_id": new_id, "plot_id": plot_id, "colony_id": plot["colony_id"],
            "ownership_type": ownership_type, "transaction_type": transaction_type,
            "party_name": party_name, "party_phone": party_phone, "party_email": party_email,
            "previous_ownership_id": str(previous["_id"]) if previous else None,
            "registry_id": registry_id, "registry_version": registry_version,
            "effective_from": effective_from, "effective_to": None,
            "created_by": user["id"], "created_by_name": user.get("name", ""), "created_at": now,
        }
        await db.collection("property_ownership_history").insert_one(record)
        await db.collection("plots").update_one(
            {"id": plot_id},
            {"$set": {
                "current_owner": {
                    "party_name": party_name, "party_phone": party_phone, "party_email": party_email,
                    "ownership_type": ownership_type, "effective_from": effective_from,
                },
                "updated_at": now,
            }},
        )
        action = "OWNERSHIP_CREATED" if ownership_type == "ORIGINAL_BUYER" else "OWNERSHIP_TRANSFERRED"
        await audit(
            user, action, "plot", plot_id, request, colony_id=plot["colony_id"],
            metadata={
                "previous_owner": previous.get("party_name") if previous else None,
                "new_owner": party_name, "transaction_type": transaction_type,
            },
        )
        return {"success": True, "ownership": {
            "id": str(new_id), "plot_id": plot_id, "colony_id": plot["colony_id"],
            "ownership_type": ownership_type, "transaction_type": transaction_type,
            "party_name": party_name, "party_phone": party_phone, "party_email": party_email,
            "effective_from": effective_from, "effective_to": None,
            "previous_ownership_id": str(previous["_id"]) if previous else None, "created_at": now,
        }}

    @router.get("/owner/inspection/plots/{plot_id}/ownership")
    async def inspect_ownership(plot_id: str, user=Depends(super_admin_auth)):
        plot = await db.collection("plots").find_one({"id": plot_id})
        if not plot:
            raise HTTPException(404, "Plot not found")
        colony_id = plot.get("colony_id")
        colony = await db.collection("colonies").find_one(
            {"_id": ObjectId(colony_id)} if _oid_valid(colony_id) else {"_id": colony_id}
        )
        if not colony:
            raise HTTPException(404, "Plot not found")
        history = await db.collection("property_ownership_history").find(
            {"plot_id": plot_id}
        ).sort("created_at", 1).to_list(None)
        return {
            "plot_id": plot_id, "colony": {"id": str(colony["_id"]), "name": colony.get("name")},
            "history": [{
                "id": str(row["_id"]), "ownership_type": row.get("ownership_type"),
                "transaction_type": row.get("transaction_type"), "party_name": row.get("party_name"),
                "effective_from": row.get("effective_from"), "effective_to": row.get("effective_to"),
                "previous_ownership_id": row.get("previous_ownership_id") or None,
                "registry_version": row.get("registry_version") or None, "created_at": row.get("created_at"),
            } for row in history],
        }

    return router
