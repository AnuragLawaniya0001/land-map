"""Colony Share Studio routes: Secure, device-restricted colony map sharing for Superadmins and Admins."""

import asyncio
import hashlib
import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


def hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.strip().encode("utf-8")).hexdigest()


def generate_raw_token() -> str:
    return secrets.token_urlsafe(24)


def parse_user_agent(ua: str) -> dict:
    ua_str = ua or ""
    # Detect device type
    if re.search(r"iPad|Tablet|PlayBook|Silk", ua_str, re.IGNORECASE):
        device_type = "Tablet"
    elif re.search(r"Mobile|Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini", ua_str, re.IGNORECASE):
        device_type = "Mobile"
    else:
        device_type = "Desktop"

    # Detect OS
    if "iPhone" in ua_str:
        os_name = "iOS (iPhone)"
    elif "iPad" in ua_str:
        os_name = "iPadOS"
    elif "Android" in ua_str:
        os_name = "Android"
    elif "Windows NT 10.0" in ua_str or "Windows 11" in ua_str:
        os_name = "Windows 10/11"
    elif "Windows" in ua_str:
        os_name = "Windows"
    elif "Macintosh" in ua_str or "Mac OS X" in ua_str:
        os_name = "macOS"
    elif "Linux" in ua_str:
        os_name = "Linux"
    else:
        os_name = "Unknown OS"

    # Detect Browser
    if "Edg/" in ua_str:
        browser_name = "Microsoft Edge"
    elif "Chrome/" in ua_str:
        browser_name = "Google Chrome"
    elif "Safari/" in ua_str and "Chrome/" not in ua_str:
        browser_name = "Apple Safari"
    elif "Firefox/" in ua_str:
        browser_name = "Mozilla Firefox"
    elif "OPR/" in ua_str or "Opera" in ua_str:
        browser_name = "Opera"
    else:
        browser_name = "Web Browser"

    device_name = f"{os_name} • {browser_name}"
    return {
        "device_type": device_type,
        "os": os_name,
        "browser": browser_name,
        "device_name": device_name,
    }


def get_client_ip(request: Request) -> str:
    x_forwarded = request.headers.get("x-forwarded-for")
    if x_forwarded:
        return x_forwarded.split(",")[0].strip()
    x_real_ip = request.headers.get("x-real-ip")
    if x_real_ip:
        return x_real_ip.strip()
    return request.client.host if request.client else "127.0.0.1"


# Pydantic Schemas
class CreateColonyShareIn(BaseModel):
    colony_id: str
    client_label: Optional[str] = ""
    max_devices: int = Field(default=5, ge=1, le=100)
    expires_in_days: Optional[float] = None


class VerifyDeviceIn(BaseModel):
    device_uid: Optional[str] = ""
    device_name: Optional[str] = ""
    os: Optional[str] = ""
    browser: Optional[str] = ""
    screen_resolution: Optional[str] = ""


def build_colony_share_router(
    db,
    get_current_user: Callable,
    require_admin: Callable,
    require_super_admin: Callable,
    load_owned_colony: Callable,
    audit_log: Callable,
    serialize_doc: Callable,
    now_iso: Callable,
    production: bool = False,
    colony_out: Optional[Callable] = None,
    serialize_user: Optional[Callable] = None,
):
    router = APIRouter(tags=["colony-shares"])

    async def admin_auth(user=Depends(get_current_user)):
        if asyncio.iscoroutinefunction(require_admin):
            return await require_admin(user)
        res = require_admin(user)
        if asyncio.iscoroutine(res):
            return await res
        return res if isinstance(res, dict) else user

    async def own_colony(colony_id: str, user: dict):
        return await load_owned_colony(colony_id, user)

    # -------------------------------------------------------------------------
    # 1. LIST ACCESSIBLE COLONIES FOR DROPDOWN
    # -------------------------------------------------------------------------
    @router.get("/admin/colony-shares/colonies")
    async def list_shareable_colonies(user=Depends(admin_auth)):
        if user["role"] == "super_admin":
            cursor = db.colonies.find({}, {"name": 1, "slug": 1, "location": 1, "boundary": 1}).sort("name", 1)
        else:
            uid = user["id"]
            uids = [str(uid)]
            if ObjectId.is_valid(str(uid)):
                uids.append(ObjectId(str(uid)))
            cursor = db.colonies.find(
                {
                    "$or": [
                        {"owner_id": {"$in": uids}},
                        {"partner_admin_id": {"$in": uids}},
                        {"collab_admin_ids": {"$in": uids}},
                    ]
                },
                {"name": 1, "slug": 1, "location": 1, "boundary": 1},
            ).sort("name", 1)

        colonies = await cursor.to_list(length=1000)
        return {
            "colonies": [
                {
                    "id": str(c["_id"]),
                    "name": c.get("name", "Untitled Colony"),
                    "slug": c.get("slug", ""),
                    "location": c.get("location", ""),
                    "has_boundary": bool(c.get("boundary")),
                }
                for c in colonies
            ]
        }

    # -------------------------------------------------------------------------
    # 2. LIST ALL SHARES
    # -------------------------------------------------------------------------
    @router.get("/admin/colony-shares")
    async def list_colony_shares(
        colony_id: Optional[str] = None,
        status: Optional[str] = None,
        user=Depends(admin_auth),
    ):
        query = {}
        if user["role"] != "super_admin":
            query["created_by"] = user["id"]

        if colony_id:
            query["colony_id"] = colony_id

        if status and status != "ALL":
            query["status"] = status

        shares = await db.colony_shares.find(query).sort("created_at", -1).to_list(length=1000)
        now = now_iso()

        result = []
        for s in shares:
            st = s.get("status", "ACTIVE")
            # Auto-detect expiry on the fly
            if st == "ACTIVE" and s.get("expires_at") and now > s["expires_at"]:
                st = "EXPIRED"
                await db.colony_shares.update_one({"_id": s["_id"]}, {"$set": {"status": "EXPIRED"}})

            token_val = s.get("raw_token") or s.get("raw_token_prefix", "")
            result.append({
                "id": s.get("id"),
                "colony_id": s.get("colony_id"),
                "colony_name": s.get("colony_name", "Colony"),
                "colony_slug": s.get("colony_slug", ""),
                "client_label": s.get("client_label", ""),
                "created_by": s.get("created_by"),
                "created_by_name": s.get("created_by_name", "Admin"),
                "created_by_role": s.get("created_by_role", "admin"),
                "raw_token": token_val,
                "raw_token_prefix": s.get("raw_token_prefix", ""),
                "share_url": f"/c/share/{token_val}",
                "max_devices": s.get("max_devices", 5),
                "registered_devices_count": s.get("registered_devices_count", 0),
                "status": st,
                "expires_at": s.get("expires_at"),
                "revoked_at": s.get("revoked_at"),
                "breached_at": s.get("breached_at"),
                "created_at": s.get("created_at"),
                "last_accessed_at": s.get("last_accessed_at"),
            })

        return {"shares": result}

    # -------------------------------------------------------------------------
    # 3. CREATE NEW SHARE LINK
    # -------------------------------------------------------------------------
    @router.post("/admin/colony-shares", status_code=201)
    async def create_colony_share(data: CreateColonyShareIn, request: Request, user=Depends(admin_auth)):
        colony = await own_colony(data.colony_id, user)
        cid = str(colony["_id"])

        raw_token = generate_raw_token()
        now = now_iso()
        expires_at = None
        if data.expires_in_days and data.expires_in_days > 0:
            expires_at = (datetime.now(timezone.utc) + timedelta(days=float(data.expires_in_days))).isoformat()

        client_label = (data.client_label or "").strip()
        if not client_label:
            client_label = f"Client Link ({data.max_devices} Devices)"

        share_doc = {
            "id": f"csh-{uuid.uuid4().hex[:12]}",
            "colony_id": cid,
            "colony_name": colony.get("name", "Colony"),
            "colony_slug": colony.get("slug", ""),
            "created_by": user["id"],
            "created_by_name": user.get("name") or user.get("email", "Admin"),
            "created_by_role": user.get("role", "admin"),
            "client_label": client_label,
            "raw_token": raw_token,
            "token_hash": hash_token(raw_token),
            "raw_token_prefix": raw_token[:8],
            "max_devices": max(1, min(100, data.max_devices)),
            "registered_devices_count": 0,
            "status": "ACTIVE",
            "expires_at": expires_at,
            "revoked_at": None,
            "breached_at": None,
            "created_at": now,
            "last_accessed_at": None,
        }

        await db.colony_shares.insert_one(share_doc)

        await audit_log(
            user,
            "COLONY_SHARE_CREATED",
            "colony_share",
            share_doc["id"],
            colony_id=cid,
            metadata={
                "client_label": client_label,
                "max_devices": share_doc["max_devices"],
                "expires_at": expires_at,
            },
            request=request,
        )

        share_response = dict(share_doc)
        share_response.pop("_id", None)
        share_response["raw_token"] = raw_token
        share_response["share_url"] = f"/c/share/{raw_token}"

        return {"share": share_response}

    # -------------------------------------------------------------------------
    # 4. VIEW REGISTERED DEVICES TELEMETRY FOR A SHARE LINK
    # -------------------------------------------------------------------------
    @router.get("/admin/colony-shares/{share_id}/devices")
    async def list_share_devices(share_id: str, user=Depends(admin_auth)):
        share = await db.colony_shares.find_one({"id": share_id})
        if not share:
            raise HTTPException(404, "Colony share link not found")

        if user["role"] != "super_admin" and share.get("created_by") != user["id"]:
            # Check if user has ownership of the colony
            await own_colony(share["colony_id"], user)

        devices = (
            await db.colony_share_devices.find({"share_id": share_id})
            .sort("first_opened_at", -1)
            .to_list(length=500)
        )

        serialized_devices = []
        for d in devices:
            serialized_devices.append({
                "id": str(d.get("_id", "")),
                "device_name": d.get("device_name", "Unknown Device"),
                "device_type": d.get("device_type", "Desktop"),
                "os": d.get("os", "Unknown OS"),
                "browser": d.get("browser", "Unknown Browser"),
                "screen_resolution": d.get("screen_resolution", "N/A"),
                "ip_address": d.get("ip_address", "N/A"),
                "first_opened_at": d.get("first_opened_at"),
                "last_active_at": d.get("last_active_at"),
                "total_views": d.get("total_views", 1),
                "status": d.get("status", "REGISTERED"),
            })

        return {
            "share": {
                "id": share["id"],
                "colony_name": share.get("colony_name"),
                "client_label": share.get("client_label"),
                "status": share.get("status"),
                "max_devices": share.get("max_devices", 5),
                "registered_devices_count": share.get("registered_devices_count", 0),
                "breached_at": share.get("breached_at"),
            },
            "devices": serialized_devices,
        }

    # -------------------------------------------------------------------------
    # 5. REVOKE SHARE LINK
    # -------------------------------------------------------------------------
    @router.post("/admin/colony-shares/{share_id}/revoke")
    async def revoke_colony_share(share_id: str, request: Request, user=Depends(admin_auth)):
        share = await db.colony_shares.find_one({"id": share_id})
        if not share:
            raise HTTPException(404, "Colony share link not found")

        if user["role"] != "super_admin" and share.get("created_by") != user["id"]:
            await own_colony(share["colony_id"], user)

        now = now_iso()
        await db.colony_shares.update_one(
            {"id": share_id},
            {"$set": {"status": "REVOKED", "revoked_at": now}},
        )

        await audit_log(
            user,
            "COLONY_SHARE_REVOKED",
            "colony_share",
            share_id,
            colony_id=share.get("colony_id"),
            metadata={"client_label": share.get("client_label")},
            request=request,
        )

        return {"success": True, "message": "Share link revoked successfully", "status": "REVOKED"}

    # -------------------------------------------------------------------------
    # 6. REGENERATE SHARE LINK
    # -------------------------------------------------------------------------
    @router.post("/admin/colony-shares/{share_id}/regenerate")
    async def regenerate_colony_share(share_id: str, request: Request, user=Depends(admin_auth)):
        old_share = await db.colony_shares.find_one({"id": share_id})
        if not old_share:
            raise HTTPException(404, "Colony share link not found")

        if user["role"] != "super_admin" and old_share.get("created_by") != user["id"]:
            await own_colony(old_share["colony_id"], user)

        now = now_iso()
        # Revoke old one if it was still active
        if old_share.get("status") == "ACTIVE":
            await db.colony_shares.update_one(
                {"id": share_id},
                {"$set": {"status": "REVOKED", "revoked_at": now}},
            )

        raw_token = generate_raw_token()
        new_share = {
            "id": f"csh-{uuid.uuid4().hex[:12]}",
            "colony_id": old_share["colony_id"],
            "colony_name": old_share.get("colony_name", "Colony"),
            "colony_slug": old_share.get("colony_slug", ""),
            "created_by": user["id"],
            "created_by_name": user.get("name") or user.get("email", "Admin"),
            "created_by_role": user.get("role", "admin"),
            "client_label": old_share.get("client_label", "") or "Regenerated Share",
            "raw_token": raw_token,
            "token_hash": hash_token(raw_token),
            "raw_token_prefix": raw_token[:8],
            "max_devices": old_share.get("max_devices", 5),
            "registered_devices_count": 0,
            "status": "ACTIVE",
            "expires_at": old_share.get("expires_at"),
            "revoked_at": None,
            "breached_at": None,
            "created_at": now,
            "last_accessed_at": None,
        }

        await db.colony_shares.insert_one(new_share)

        await audit_log(
            user,
            "COLONY_SHARE_REGENERATED",
            "colony_share",
            new_share["id"],
            colony_id=new_share["colony_id"],
            metadata={"replaces_share_id": share_id},
            request=request,
        )

        res = dict(new_share)
        res.pop("_id", None)
        res["raw_token"] = raw_token
        res["share_url"] = f"/c/share/{raw_token}"
        return {"share": res}

    # =========================================================================
    # PUBLIC CLIENT ENDPOINTS (Device Verification & Read-Only Map Data)
    # =========================================================================

    # -------------------------------------------------------------------------
    # 7. PUBLIC: VERIFY CLIENT DEVICE & ENFORCE STRICT DEVICE LIMIT
    # -------------------------------------------------------------------------
    @router.post("/public/colony-share/{token}/verify")
    async def verify_client_device(token: str, data: VerifyDeviceIn, request: Request, response: Response):
        token_clean = (token or "").strip()
        if len(token_clean) < 6:
            raise HTTPException(404, "Invalid colony share token")

        t_hash = hash_token(token_clean)
        share = await db.colony_shares.find_one({
            "$or": [
                {"token_hash": t_hash},
                {"raw_token": token_clean},
                {"raw_token_prefix": token_clean},
            ]
        })
        if not share:
            raise HTTPException(404, "Colony share link does not exist or has expired")

        now = now_iso()

        # Check status flags
        if share.get("status") == "REVOKED":
            raise HTTPException(403, "This share link has been revoked by the property administrator.")

        if share.get("status") == "DEVICE_LIMIT_BREACHED":
            raise HTTPException(
                403,
                f"Device Limit Exceeded ({share.get('max_devices', 5)} Devices Allowed). "
                "This link was accessed from an unauthorized device and has been permanently locked.",
            )

        if share.get("expires_at") and now > share["expires_at"]:
            await db.colony_shares.update_one({"_id": share["_id"]}, {"$set": {"status": "EXPIRED"}})
            raise HTTPException(403, "This share link has expired.")

        # Extract Client Device Telemetry
        user_agent = request.headers.get("user-agent", "")
        parsed_ua = parse_user_agent(user_agent)
        client_ip = get_client_ip(request)
        device_uid = (data.device_uid or "").strip()

        # Combined unique device fingerprint
        fp_raw = f"{share['id']}_{device_uid}_{parsed_ua['os']}_{parsed_ua['browser']}_{data.screen_resolution}_{client_ip}"
        device_fingerprint = hashlib.sha256(fp_raw.encode("utf-8")).hexdigest()

        # Check if this device is already registered for this share link
        existing_device = await db.colony_share_devices.find_one({
            "share_id": share["id"],
            "device_fingerprint": device_fingerprint,
        })

        if existing_device:
            # Same device re-opening! Update last active and view count
            await db.colony_share_devices.update_one(
                {"_id": existing_device["_id"]},
                {
                    "$set": {"last_active_at": now},
                    "$inc": {"total_views": 1},
                },
            )
            await db.colony_shares.update_one(
                {"_id": share["_id"]},
                {"$set": {"last_accessed_at": now}},
            )
            return {
                "success": True,
                "device_status": "EXISTING_DEVICE",
                "colony_id": share["colony_id"],
                "colony_name": share.get("colony_name"),
                "client_label": share.get("client_label"),
                "max_devices": share.get("max_devices", 5),
                "devices_used": share.get("registered_devices_count", 0),
            }

        # It is a NEW device attempting to register
        max_dev = share.get("max_devices", 5)
        current_count = share.get("registered_devices_count", 0)

        if current_count >= max_dev:
            # =================================================================
            # KILLSWITCH ACTIVATED: 6th Device tried to open when max was 5!
            # =================================================================
            await db.colony_share_devices.insert_one({
                "share_id": share["id"],
                "colony_id": share["colony_id"],
                "device_fingerprint": device_fingerprint,
                "device_uid": device_uid,
                "device_type": parsed_ua["device_type"],
                "device_name": parsed_ua["device_name"],
                "os": parsed_ua["os"],
                "browser": parsed_ua["browser"],
                "screen_resolution": data.screen_resolution or "Unknown",
                "ip_address": client_ip,
                "first_opened_at": now,
                "last_active_at": now,
                "total_views": 1,
                "status": "BLOCKED_BREACH_TRIGGER",
            })

            # Globally lock and expire this share link
            await db.colony_shares.update_one(
                {"_id": share["_id"]},
                {
                    "$set": {
                        "status": "DEVICE_LIMIT_BREACHED",
                        "breached_at": now,
                    }
                },
            )

            raise HTTPException(
                403,
                f"Device limit exceeded! This link was configured for a maximum of {max_dev} devices. "
                "Because an additional device attempted access, this link has been permanently expired.",
            )

        # Allow new device registration
        new_count = current_count + 1
        await db.colony_share_devices.insert_one({
            "share_id": share["id"],
            "colony_id": share["colony_id"],
            "device_fingerprint": device_fingerprint,
            "device_uid": device_uid,
            "device_type": parsed_ua["device_type"],
            "device_name": parsed_ua["device_name"],
            "os": parsed_ua["os"],
            "browser": parsed_ua["browser"],
            "screen_resolution": data.screen_resolution or "Unknown",
            "ip_address": client_ip,
            "first_opened_at": now,
            "last_active_at": now,
            "total_views": 1,
            "status": "REGISTERED",
        })

        await db.colony_shares.update_one(
            {"_id": share["_id"]},
            {
                "$set": {
                    "registered_devices_count": new_count,
                    "last_accessed_at": now,
                }
            },
        )

        return {
            "success": True,
            "device_status": "REGISTERED_NEW",
            "colony_id": share["colony_id"],
            "colony_name": share.get("colony_name"),
            "client_label": share.get("client_label"),
            "max_devices": max_dev,
            "devices_used": new_count,
        }

    # -------------------------------------------------------------------------
    # 8. PUBLIC: FETCH READ-ONLY CLIENT PRESENTATION MAP DATA
    # -------------------------------------------------------------------------
    @router.get("/public/colony-share/{token}/data")
    async def get_shared_colony_data(token: str):
        token_clean = (token or "").strip()
        t_hash = hash_token(token_clean)
        share = await db.colony_shares.find_one({
            "$or": [
                {"token_hash": t_hash},
                {"raw_token": token_clean},
                {"raw_token_prefix": token_clean},
            ]
        })
        if not share:
            raise HTTPException(404, "Colony share link does not exist or has expired")

        now = now_iso()
        if share.get("status") == "REVOKED":
            raise HTTPException(403, "This share link has been revoked.")
        if share.get("status") == "DEVICE_LIMIT_BREACHED":
            raise HTTPException(403, "Access locked: Maximum device limit was exceeded.")
        if share.get("expires_at") and now > share["expires_at"]:
            raise HTTPException(403, "This share link has expired.")

        cid = share["colony_id"]
        colony = await db.colonies.find_one(
            {"_id": ObjectId(cid)} if ObjectId.is_valid(cid) else {"_id": cid}
        )
        if not colony:
            raise HTTPException(404, "Colony data not found")

        # Use full colony_out serializer so pdf_overlay, calibration, placement, transforms etc. are fully populated!
        c_out = colony_out(colony) if colony_out else serialize_doc(colony)

        # Fetch zones, statuses, and plots for this colony
        zones = [serialize_doc(z) async for z in db.zones.find({"colony_id": cid})]
        statuses = [serialize_doc(s) async for s in db.statuses.find({}).sort("sort_order", 1)]

        # Fetch plots with clean client-facing projection (hide confidential internal notes)
        plots_raw = await db.plots.find(
            {"colony_id": cid},
            {"notes": 0, "internal_cost": 0, "admin_tags": 0},
        ).to_list(length=5000)

        plots = [serialize_doc(p) for p in plots_raw]
        for p in plots:
            if not p.get("number") and p.get("plot_number"):
                p["number"] = p["plot_number"]

        # Fetch developer / owner info for contact / WhatsApp inquiry
        owner_id = colony.get("owner_id") or share.get("created_by")
        owner_doc = None
        if owner_id and ObjectId.is_valid(owner_id):
            owner_doc = await db.users.find_one({"_id": ObjectId(owner_id)})
        elif owner_id:
            owner_doc = await db.users.find_one({"_id": owner_id})

        developer_info = {
            "name": (owner_doc or {}).get("name") or "Property Developer",
            "phone": (owner_doc or {}).get("phone") or colony.get("whatsapp_number") or "",
            "whatsapp_number": colony.get("whatsapp_number") or (owner_doc or {}).get("phone") or "",
            "email": (owner_doc or {}).get("email") or "",
        }

        owner_serialized = serialize_user(owner_doc) if (serialize_user and owner_doc) else (serialize_doc(owner_doc) if owner_doc else None)

        return {
            "colony": c_out,
            "plots": plots,
            "zones": zones,
            "statuses": statuses,
            "owner": owner_serialized,
            "developer": developer_info,
            "share_info": {
                "client_label": share.get("client_label", ""),
                "max_devices": share.get("max_devices", 5),
                "devices_used": share.get("registered_devices_count", 0),
            },
        }

    return router
