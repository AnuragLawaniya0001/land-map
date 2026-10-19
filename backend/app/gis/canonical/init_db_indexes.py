"""Database Index Verification and Initialization Script.

Verifies and creates performance and uniqueness compound indexes for canonical
colony collections in MongoDB.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

INDEX_SPECIFICATIONS: Dict[str, List[Dict[str, Any]]] = {
    "canonical_datasets": [
        {"keys": [("colony_id", 1), ("version", 1)], "unique": True},
        {"keys": [("colony_id", 1), ("is_active", 1)]},
        {"keys": [("source_sha256", 1)]},
    ],
    "canonical_plots": [
        {"keys": [("colony_id", 1), ("dataset_version", 1), ("id", 1)], "unique": True},
        {"keys": [("colony_id", 1), ("dataset_version", 1), ("original_number", 1)]},
        {"keys": [("colony_id", 1), ("dataset_version", 1), ("semantic_validation_status", 1)]},
    ],
    "canonical_roads": [
        {"keys": [("colony_id", 1), ("dataset_version", 1), ("id", 1)], "unique": True},
    ],
    "canonical_dimensions": [
        {"keys": [("colony_id", 1), ("dataset_version", 1), ("id", 1)]},
        {"keys": [("colony_id", 1), ("dataset_version", 1), ("selected_target_id", 1)]},
    ],
    "canonical_relationships": [
        {"keys": [("colony_id", 1), ("dataset_version", 1), ("relationship_type", 1)]},
    ],
    "review_corrections": [
        {"keys": [("colony_id", 1), ("dataset_version", 1), ("entity_id", 1)]},
        {"keys": [("correction_id", 1)], "unique": True},
    ],
    "processing_runs": [
        {"keys": [("colony_id", 1), ("canonical_dataset_version", 1)]},
        {"keys": [("run_id", 1)], "unique": True},
    ],
}


async def init_canonical_indexes(db: Any) -> Dict[str, int]:
    """Creates all canonical collections indexes and returns count created."""
    created_counts = {}

    for collection_name, index_list in INDEX_SPECIFICATIONS.items():
        if not hasattr(db, "__getitem__"):
            continue
        coll = db[collection_name]
        count = 0
        for spec in index_list:
            keys = spec["keys"]
            unique = spec.get("unique", False)
            try:
                if hasattr(coll, "create_index"):
                    await coll.create_index(keys, unique=unique)
                    count += 1
            except Exception as exc:
                logger.warning("Index notice on %s %s: %s", collection_name, keys, exc)
        created_counts[collection_name] = count

    return created_counts
