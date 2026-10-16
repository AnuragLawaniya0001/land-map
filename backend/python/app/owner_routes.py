"""Platform-owner routes, mounted by the main FastAPI application."""

import asyncio
import re
from datetime import datetime, timezone
from typing import Any, Callable

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request


def _valid_object_id(value: str) -> bool:
    return ObjectId.is_valid(value)


def _as_object_id(value: str) -> ObjectId:
    return ObjectId(value)


def _js_parse_int(value: Any, default: int) -> int:
    """Match JavaScript parseInt(value, 10) for owner audit pagination."""
    match = re.match(r"^[\s]*([+-]?\d+)", str(value))
    if not match:
        return default
    try:
        return int(match.group(1), 10)
    except ValueError:
        return default


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def build_owner_router(
    db: Any,
    require_super_admin_dep: Callable,
    serialize_doc: Callable[[dict], dict],
    serialize_user: Callable[[dict], dict],
) -> APIRouter:
    """Create the owner API router using the app's DB, auth and serializers."""
    router = APIRouter()

    @router.get("/owner/dashboard")
    async def owner_dashboard(user=Depends(require_super_admin_dep)):
        total_admins = await db["users"].count_documents({"role": "admin"})
        total_colonies = await db["colonies"].count_documents({})
        total_plots = await db["plots"].count_documents({})

        statuses = (
            await db["statuses"].find({}).sort("sort_order", 1).to_list(length=None)
        )
        status_counts = {status["id"]: 0 for status in statuses}
        async for plot in db["plots"].find({}, {"status_id": 1}):
            status_id = plot.get("status_id") or "available"
            status_counts[status_id] = status_counts.get(status_id, 0) + 1

        inquiry_new = await db["property_inquiries"].count_documents({"status": "NEW"})
        inquiry_contacted = await db["property_inquiries"].count_documents(
            {"status": "CONTACTED"}
        )
        inquiry_closed = await db["property_inquiries"].count_documents(
            {"status": "CLOSED"}
        )
        inquiry_total = inquiry_new + inquiry_contacted + inquiry_closed

        active_shares = await db["property_shares"].count_documents(
            {"status": "ACTIVE", "revoked_at": None}
        )
        total_shares = await db["property_shares"].count_documents({})
        registry_total = await db["registry"].count_documents({})
        media_total = await db["property_media"].count_documents({})
        recent_audit = await (
            db["audit_logs"]
            .find({})
            .sort("created_at", -1)
            .limit(10)
            .to_list(length=10)
        )

        return {
            "role": user["role"],
            "user": serialize_user(user),
            "totals": {
                "admins": total_admins,
                "colonies": total_colonies,
                "plots": total_plots,
                "registry_docs": registry_total,
                "media_total": media_total,
            },
            "status_counts": status_counts,
            "inventory": {
                "totalPlots": total_plots,
                "availablePlots": status_counts.get("available", 0),
                "reservedPlots": status_counts.get("reserved", 0),
                "holdPlots": status_counts.get("hold", 0),
                "soldPlots": status_counts.get("sold", 0),
                "blockedPlots": status_counts.get("blocked", 0),
            },
            "statuses": [serialize_doc(status) for status in statuses],
            "inquiries": {
                "total": inquiry_total,
                "totalInquiries": inquiry_total,
                "new": inquiry_new,
                "newInquiries": inquiry_new,
                "contacted": inquiry_contacted,
                "contactedInquiries": inquiry_contacted,
                "closed": inquiry_closed,
                "closedInquiries": inquiry_closed,
            },
            "shares": {"active": active_shares, "total": total_shares},
            "recent_activity": [serialize_doc(record) for record in recent_audit],
        }

    @router.get("/owner/admins")
    async def owner_admins(user=Depends(require_super_admin_dep)):
        admins = await (
            db["users"]
            .find({"role": {"$in": ["admin", "super_admin"]}})
            .sort("created_at", -1)
            .to_list(length=None)
        )
        if not admins:
            return {"admins": []}

        admin_ids_str = [str(a["_id"]) for a in admins]
        colony_docs = await db["colonies"].find(
            {"owner_id": {"$in": admin_ids_str}},
            {"_id": 1, "owner_id": 1}
        ).to_list(length=5000)

        # Map owner_id -> list of colony_ids
        admin_colony_map = {aid: [] for aid in admin_ids_str}
        all_colony_ids = []
        for c in colony_docs:
            cid = str(c["_id"])
            oid = str(c.get("owner_id", ""))
            if oid in admin_colony_map:
                admin_colony_map[oid].append(cid)
            all_colony_ids.append(cid)

        # Batch aggregate plot stats, inquiries, shares
        plot_stats_agg = []
        inquiries_agg = []
        shares_agg = []
        if all_colony_ids:
            p_pipe = [
                {"$match": {"colony_id": {"$in": all_colony_ids}}},
                {"$group": {"_id": {"colony_id": "$colony_id", "status": {"$ifNull": ["$status_id", "$status"]}}, "count": {"$sum": 1}}}
            ]
            inq_pipe = [
                {"$match": {"colony_id": {"$in": all_colony_ids}}},
                {"$group": {"_id": "$colony_id", "count": {"$sum": 1}}}
            ]
            shares_pipe = [
                {"$match": {"colony_id": {"$in": all_colony_ids}, "status": "ACTIVE", "revoked_at": None}},
                {"$group": {"_id": "$colony_id", "count": {"$sum": 1}}}
            ]
            plot_stats_agg, inquiries_agg, shares_agg = await asyncio.gather(
                db["plots"].aggregate(p_pipe).to_list(length=10000),
                db["property_inquiries"].aggregate(inq_pipe).to_list(length=10000),
                db["property_shares"].aggregate(shares_pipe).to_list(length=10000),
            )

        colony_plot_counts = {}
        for item in (plot_stats_agg or []):
            gid = item.get("_id") or {}
            cid = str(gid.get("colony_id", ""))
            status = str(gid.get("status", "")).lower()
            cnt = int(item.get("count", 0))
            if cid not in colony_plot_counts:
                colony_plot_counts[cid] = {"total": 0, "available": 0, "sold": 0}
            colony_plot_counts[cid]["total"] += cnt
            if status in ("available", "active"):
                colony_plot_counts[cid]["available"] += cnt
            elif status == "sold":
                colony_plot_counts[cid]["sold"] += cnt

        colony_inq_counts = {str(item["_id"]): int(item.get("count", 0)) for item in (inquiries_agg or []) if item.get("_id")}
        colony_share_counts = {str(item["_id"]): int(item.get("count", 0)) for item in (shares_agg or []) if item.get("_id")}

        result = []
        for admin in admins:
            serialized = serialize_user(admin)
            aid = str(admin["_id"])
            cids = admin_colony_map.get(aid, [])
            colony_count = len(cids)
            plot_count = sum(colony_plot_counts.get(cid, {}).get("total", 0) for cid in cids)
            available_plots = sum(colony_plot_counts.get(cid, {}).get("available", 0) for cid in cids)
            sold_plots = sum(colony_plot_counts.get(cid, {}).get("sold", 0) for cid in cids)
            inquiry_count = sum(colony_inq_counts.get(cid, 0) for cid in cids)
            active_shares = sum(colony_share_counts.get(cid, 0) for cid in cids)

            serialized.update({
                "colony_count": colony_count,
                "plot_count": plot_count,
                "available_plots": available_plots,
                "sold_plots": sold_plots,
                "inquiry_count": inquiry_count,
                "active_shares": active_shares,
                "metrics": {
                    "coloniesCount": colony_count,
                    "totalPlots": plot_count,
                    "availablePlots": available_plots,
                    "soldPlots": sold_plots,
                    "inquiriesCount": inquiry_count,
                    "activeSharesCount": active_shares,
                },
            })
            result.append(serialized)
        return {"admins": result}

    @router.patch("/owner/admins/{uid}/status")
    async def set_admin_status(
        uid: str, request: Request, user=Depends(require_super_admin_dep)
    ):
        body = (
            await request.json()
            if request.headers.get("content-length", "0") != "0"
            else {}
        )
        body = body or {}
        active = body.get("active") if isinstance(body, dict) else None
        if not isinstance(active, bool):
            raise HTTPException(400, "Field 'active' boolean required")
        if not _valid_object_id(uid):
            raise HTTPException(404, "Admin account not found")
        if uid == user["id"]:
            raise HTTPException(400, "Cannot deactivate your own super admin account")
        target = await db["users"].find_one({"_id": _as_object_id(uid)})
        if not target:
            raise HTTPException(404, "Admin account not found")
        await db["users"].update_one(
            {"_id": _as_object_id(uid)}, {"$set": {"active": active}}
        )
        await db["audit_logs"].insert_one(
            {
                "user_id": user["id"],
                "user_name": user["name"],
                "role": user["role"],
                "action": "ADMIN_ACTIVATED" if active else "ADMIN_DEACTIVATED",
                "entity_type": "user",
                "entity_id": uid,
                "metadata": {"target_email": target.get("email"), "active": active},
                "created_at": _now_iso(),
            }
        )
        updated = await db["users"].find_one({"_id": _as_object_id(uid)})
        return serialize_user(updated)

    @router.get("/owner/colonies")
    async def owner_colonies(user=Depends(require_super_admin_dep)):
        colonies = await (
            db["colonies"].find({}).sort("created_at", -1).to_list(length=1000)
        )
        if not colonies:
            return {"colonies": []}

        colony_ids = [str(c["_id"]) for c in colonies]

        # Collect all user IDs (owners and partners)
        user_ids = set()
        for c in colonies:
            oid = str(c.get("owner_id") or "")
            if oid and _valid_object_id(oid):
                user_ids.add(_as_object_id(oid))
            pid = str(c.get("partner_admin_id") or "")
            if pid and _valid_object_id(pid):
                user_ids.add(_as_object_id(pid))

        # Batch fetch users concurrently with aggregation for plots & inquiries
        users_task = db["users"].find({"_id": {"$in": list(user_ids)}}).to_list(length=1000) if user_ids else asyncio.sleep(0, result=[])
        
        plots_agg_pipe = [
            {"$match": {"colony_id": {"$in": colony_ids}}},
            {
                "$group": {
                    "_id": {
                        "colony_id": "$colony_id",
                        "status": {"$ifNull": ["$status_id", "$status"]}
                    },
                    "count": {"$sum": 1}
                }
            }
        ]
        plots_agg_task = db["plots"].aggregate(plots_agg_pipe).to_list(length=10000)

        inquiries_agg_pipe = [
            {"$match": {"colony_id": {"$in": colony_ids}}},
            {"$group": {"_id": "$colony_id", "count": {"$sum": 1}}}
        ]
        inquiries_agg_task = db["property_inquiries"].aggregate(inquiries_agg_pipe).to_list(length=10000)

        users_list, plots_agg, inquiries_agg = await asyncio.gather(
            users_task, plots_agg_task, inquiries_agg_task
        )

        user_map = {str(u["_id"]): u for u in (users_list or [])}

        plot_stats_map = {
            cid: {"total": 0, "available": 0, "reserved": 0, "hold": 0, "sold": 0, "blocked": 0}
            for cid in colony_ids
        }
        for item in (plots_agg or []):
            group_id = item.get("_id") or {}
            cid = str(group_id.get("colony_id", ""))
            status = str(group_id.get("status", "")).lower()
            cnt = int(item.get("count", 0))
            if cid in plot_stats_map:
                plot_stats_map[cid]["total"] += cnt
                if status in plot_stats_map[cid]:
                    plot_stats_map[cid][status] += cnt
                elif status == "active":
                    plot_stats_map[cid]["available"] += cnt

        inquiry_map = {str(item["_id"]): int(item.get("count", 0)) for item in (inquiries_agg or []) if item.get("_id")}

        result = []
        for colony in colonies:
            colony_id = str(colony["_id"])
            owner_id = str(colony.get("owner_id") or "")
            owner = user_map.get(owner_id)

            partner_id = str(colony.get("partner_admin_id") or "")
            partner = user_map.get(partner_id)

            c_stats = plot_stats_map.get(colony_id, {"total": 0, "available": 0, "reserved": 0, "hold": 0, "sold": 0, "blocked": 0})
            total_plots = c_stats["total"]
            status_counts = {
                "available": c_stats["available"],
                "reserved": c_stats["reserved"],
                "hold": c_stats["hold"],
                "sold": c_stats["sold"],
                "blocked": c_stats["blocked"],
            }
            inquiry_count = inquiry_map.get(colony_id, 0)

            import_source = colony.get("import_source")
            pdf_plot_count = (
                import_source.get("pdf_plot_count")
                if isinstance(import_source, dict)
                else None
            )
            source_files = (
                import_source.get("sources")
                if isinstance(import_source, dict)
                else None
            ) or None

            result.append(
                {
                    "_id": colony_id,
                    "id": colony_id,
                    "slug": colony.get("slug"),
                    "name": colony.get("name"),
                    "colony_id": colony.get("name") or colony_id,
                    "location": colony.get("location") or "",
                    "description": colony.get("description") or "",
                    "source_files": source_files,
                    "public_enabled": bool(colony.get("public_enabled")),
                    "is_public": colony.get("public_enabled") is not False,
                    "created_at": colony.get("created_at"),
                    "adminName": owner.get("name") if owner else "System",
                    "adminEmail": owner.get("email") if owner else "N/A",
                    "owner": serialize_user(owner) if owner else None,
                    "partner_admin_id": colony.get("partner_admin_id") or None,
                    "partnerAdminName": partner.get("name") if partner else None,
                    "partnerAdminEmail": partner.get("email") if partner else None,
                    "preview_token": colony.get("preview_token") or None,
                    "stats": {
                        "total_plots": total_plots,
                        "pdf_detected_plots": pdf_plot_count,
                        **status_counts,
                        "inquiries": inquiry_count,
                    },
                    "metrics": {
                        "totalPlots": total_plots,
                        "pdfDetectedPlots": pdf_plot_count,
                        **status_counts,
                        "inquiries": inquiry_count,
                    },
                }
            )
        return {"colonies": result}

    @router.get("/owner/inspection/admins/{admin_id}")
    async def inspect_admin(admin_id: str, user=Depends(require_super_admin_dep)):
        if not _valid_object_id(admin_id):
            raise HTTPException(404, "Target Admin not found")
        target_admin = await db["users"].find_one({"_id": _as_object_id(admin_id)})
        if not target_admin:
            raise HTTPException(404, "Target Admin not found")
        colonies = (
            await db["colonies"]
            .find({"owner_id": admin_id}, {"_id": 1})
            .to_list(length=None)
        )
        colony_ids = [str(colony["_id"]) for colony in colonies]
        scope = {"colony_id": {"$in": colony_ids}}
        stats = {
            "colony_count": len(colony_ids),
            "plot_count": await db["plots"].count_documents(scope) if colony_ids else 0,
            "available_plots": (
                await db["plots"].count_documents(
                    {"colony_id": {"$in": colony_ids}, "status_id": "available"}
                )
                if colony_ids
                else 0
            ),
            "sold_plots": (
                await db["plots"].count_documents(
                    {"colony_id": {"$in": colony_ids}, "status_id": "sold"}
                )
                if colony_ids
                else 0
            ),
            "inquiry_count": (
                await db["property_inquiries"].count_documents(scope)
                if colony_ids
                else 0
            ),
            "active_shares": (
                await db["property_shares"].count_documents(
                    {
                        "colony_id": {"$in": colony_ids},
                        "status": "ACTIVE",
                        "revoked_at": None,
                    }
                )
                if colony_ids
                else 0
            ),
        }
        await db["audit_logs"].insert_one(
            {
                "user_id": user["id"],
                "user_name": user["name"],
                "role": user["role"],
                "action": "OWNER_INSPECTION_STARTED",
                "entity_type": "user",
                "entity_id": admin_id,
                "metadata": {"target_email": target_admin.get("email")},
                "created_at": _now_iso(),
            }
        )
        return {"admin": serialize_user(target_admin), "stats": stats}

    @router.get("/owner/inspection/admins/{admin_id}/colonies")
    async def inspect_admin_colonies(
        admin_id: str, user=Depends(require_super_admin_dep)
    ):
        if not _valid_object_id(admin_id):
            raise HTTPException(404, "Target Admin not found")
        target_admin = await db["users"].find_one({"_id": _as_object_id(admin_id)})
        if not target_admin:
            raise HTTPException(404, "Target Admin not found")
        colonies = await (
            db["colonies"]
            .find({"owner_id": admin_id})
            .sort("created_at", -1)
            .to_list(length=None)
        )
        result = []
        for colony in colonies:
            colony_id = str(colony["_id"])
            result.append(
                {
                    "id": colony_id,
                    "slug": colony.get("slug"),
                    "name": colony.get("name"),
                    "location": colony.get("location") or "",
                    "description": colony.get("description") or "",
                    "public_enabled": bool(colony.get("public_enabled")),
                    "created_at": colony.get("created_at"),
                    "stats": {
                        "total_plots": await db["plots"].count_documents(
                            {"colony_id": colony_id}
                        ),
                        "available": await db["plots"].count_documents(
                            {"colony_id": colony_id, "status_id": "available"}
                        ),
                        "sold": await db["plots"].count_documents(
                            {"colony_id": colony_id, "status_id": "sold"}
                        ),
                        "inquiries": await db["property_inquiries"].count_documents(
                            {"colony_id": colony_id}
                        ),
                    },
                }
            )
        return {"admin": serialize_user(target_admin), "colonies": result}

    @router.get("/owner/inspection/colonies/{colony_id}")
    async def inspect_colony(colony_id: str, user=Depends(require_super_admin_dep)):
        if not _valid_object_id(colony_id):
            raise HTTPException(404, "Colony not found")
        colony = await db["colonies"].find_one({"_id": _as_object_id(colony_id)})
        if not colony:
            raise HTTPException(404, "Colony not found")
        owner_id = colony.get("owner_id") or ""
        owner = (
            await db["users"].find_one({"_id": _as_object_id(owner_id)})
            if _valid_object_id(owner_id)
            else None
        )
        actual_id = str(colony["_id"])
        total_plots = await db["plots"].count_documents({"colony_id": actual_id})
        available = await db["plots"].count_documents(
            {"colony_id": actual_id, "status_id": "available"}
        )
        sold = await db["plots"].count_documents(
            {"colony_id": actual_id, "status_id": "sold"}
        )
        inquiries = await db["property_inquiries"].count_documents(
            {"colony_id": actual_id}
        )
        await db["audit_logs"].insert_one(
            {
                "user_id": user["id"],
                "user_name": user["name"],
                "role": user["role"],
                "action": "OWNER_INSPECTION_VIEWED",
                "entity_type": "colony",
                "entity_id": actual_id,
                "colony_id": actual_id,
                "metadata": {
                    "colony_name": colony.get("name"),
                    "owner_id": colony.get("owner_id"),
                },
                "created_at": _now_iso(),
            }
        )
        return {
            "colony": serialize_doc(colony),
            "owner": serialize_user(owner) if owner else None,
            "stats": {
                "total_plots": total_plots,
                "available": available,
                "sold": sold,
                "inquiries": inquiries,
            },
        }

    @router.get("/owner/inspection/colonies/{colony_id}/plots")
    async def inspect_colony_plots(
        colony_id: str, user=Depends(require_super_admin_dep)
    ):
        if not _valid_object_id(colony_id):
            raise HTTPException(404, "Colony not found")
        colony = await db["colonies"].find_one({"_id": _as_object_id(colony_id)})
        if not colony:
            raise HTTPException(404, "Colony not found")
        actual_id = str(colony["_id"])
        plots = await db["plots"].find({"colony_id": actual_id}).to_list(length=None)
        return {
            "colony": {
                "id": actual_id,
                "name": colony.get("name"),
                "slug": colony.get("slug"),
            },
            "plots": [serialize_doc(plot) for plot in plots],
        }

    @router.get("/owner/inspection/plots/{plot_id}")
    async def inspect_plot(plot_id: str, user=Depends(require_super_admin_dep)):
        if not _valid_object_id(plot_id):
            raise HTTPException(404, "Plot not found")
        plot = await db["plots"].find_one({"_id": _as_object_id(plot_id)})
        if not plot:
            raise HTTPException(404, "Plot not found")
        colony = await db["colonies"].find_one(
            {"_id": _as_object_id(plot["colony_id"])}
        )
        if not colony:
            raise HTTPException(404, "Plot not found")
        owner_id = colony.get("owner_id") or ""
        owner = (
            await db["users"].find_one({"_id": _as_object_id(owner_id)})
            if _valid_object_id(owner_id)
            else None
        )
        registry = await db["registry"].find_one({"plot_id": str(plot["_id"])})
        registry_metadata = (
            {
                "id": str(registry["_id"]),
                "filename": registry.get("filename") or "deed.pdf",
                "version": registry.get("version") or 1,
                "created_at": registry.get("created_at"),
                "has_file": True,
            }
            if registry
            else None
        )
        media_docs = (
            await db["property_media"]
            .find({"plot_id": str(plot["_id"])})
            .to_list(length=None)
        )
        safe_media = [
            {
                "id": str(media["_id"]),
                "title": media.get("title") or "",
                "is_primary": bool(media.get("is_primary")),
                "created_at": media.get("created_at"),
            }
            for media in media_docs
        ]
        share_docs = (
            await db["property_shares"]
            .find({"plot_id": str(plot["_id"])})
            .to_list(length=None)
        )
        safe_shares = [
            {
                "id": str(share["_id"]),
                "status": share.get("status"),
                "view_count": share.get("view_count") or 0,
                "max_views": share.get("max_views") or None,
                "expires_at": share.get("expires_at") or None,
                "revoked_at": share.get("revoked_at") or None,
                "created_at": share.get("created_at"),
            }
            for share in share_docs
        ]
        return {
            "plot": serialize_doc(plot),
            "colony": {
                "id": str(colony["_id"]),
                "name": colony.get("name"),
                "slug": colony.get("slug"),
            },
            "owner": serialize_user(owner) if owner else None,
            "registry": registry_metadata,
            "media": safe_media,
            "shares": safe_shares,
        }

    @router.get("/owner/inspection/colonies/{colony_id}/inquiries")
    async def inspect_colony_inquiries(
        colony_id: str, user=Depends(require_super_admin_dep)
    ):
        if not _valid_object_id(colony_id):
            raise HTTPException(404, "Colony not found")
        colony = await db["colonies"].find_one({"_id": _as_object_id(colony_id)})
        if not colony:
            raise HTTPException(404, "Colony not found")
        actual_id = str(colony["_id"])
        inquiries = await (
            db["property_inquiries"]
            .find({"colony_id": actual_id})
            .sort("created_at", -1)
            .to_list(length=None)
        )
        return {
            "colony": {"id": actual_id, "name": colony.get("name")},
            "inquiries": [serialize_doc(inquiry) for inquiry in inquiries],
        }

    @router.get("/owner/audit-logs")
    async def owner_audit_logs(
        page: str = "1", limit: str = "25", user=Depends(require_super_admin_dep)
    ):
        page_num = max(1, _js_parse_int(page, 1))
        limit_num = min(100, max(1, _js_parse_int(limit, 25)))
        skip = (page_num - 1) * limit_num
        total = await db["audit_logs"].count_documents({})
        rows = await (
            db["audit_logs"]
            .find({})
            .sort("created_at", -1)
            .skip(skip)
            .limit(limit_num)
            .to_list(length=limit_num)
        )
        total_pages = (total + limit_num - 1) // limit_num or 1
        logs = []
        for row in rows:
            doc = serialize_doc(row)
            doc.update(
                {
                    "timestamp": row.get("created_at") or row.get("timestamp"),
                    "user_email": row.get("user_name")
                    or row.get("user_id")
                    or "System",
                    "user_role": row.get("role") or "system",
                    "resource_type": row.get("entity_type"),
                    "resource_id": row.get("entity_id"),
                    "status": "SUCCESS",
                }
            )
            logs.append(doc)
        return {
            "total": total,
            "auditLogs": logs,
            "pagination": {
                "page": page_num,
                "limit": limit_num,
                "totalPages": total_pages,
            },
        }

    @router.get("/owner/inquiries")
    async def owner_inquiries(
        status: str | None = None,
        colony_id: str | None = None,
        user=Depends(require_super_admin_dep),
    ):
        query = {}
        if status:
            query["status"] = str(status)
        if colony_id:
            query["colony_id"] = str(colony_id)
        rows = await (
            db["property_inquiries"]
            .find(query)
            .sort("created_at", -1)
            .limit(300)
            .to_list(length=300)
        )
        return [serialize_doc(row) for row in rows]

    return router
