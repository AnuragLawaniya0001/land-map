"""Idempotent persistence helpers for GIS-imported plots and zones."""


async def persist_import_documents(collection, documents, now, kind, colony_id=None):
    """Merge imported documents by stable identity while retaining plot status."""
    default_colony_id = colony_id
    inserted = 0
    updated = 0

    for source in documents:
        document = dict(source)
        document_colony_id = str(document.get("colony_id") or default_colony_id or "")
        if not document_colony_id:
            raise ValueError("GIS import documents must include a colony id")
        document["colony_id"] = document_colony_id
        number = str(document.get("number") or "").strip()
        if kind == "plot":
            if not number:
                raise ValueError("Imported plots must have a plot number")
            document["number"] = number
        document.setdefault(
            "id",
            f"{kind}-{document_colony_id}-{number.lower()}" if kind == "plot"
            else f"zone-{document_colony_id}-{str(document.get('code') or '').lower()}",
        )

        existing = await collection.find_one(
            {"id": document["id"], "colony_id": document_colony_id}
        )
        if existing is None and kind == "plot":
            existing = await collection.find_one(
                {"colony_id": document_colony_id, "number": number}
            )

        if existing:
            fields = {
                key: value
                for key, value in document.items()
                if key not in {"_id", "created_at", "status_id"}
            }
            if kind == "plot":
                fields["status_id"] = existing.get("status_id") or "available"
            fields["updated_at"] = now
            query = {"_id": existing["_id"]} if "_id" in existing else {
                "id": existing["id"],
                "colony_id": document_colony_id,
            }
            await collection.update_one(query, {"$set": fields})
            updated += 1
            continue

        if kind == "plot":
            document["status_id"] = "available"
        document["updated_at"] = now
        await collection.insert_one(document)
        inserted += 1

    return {"inserted": inserted, "updated": updated}
