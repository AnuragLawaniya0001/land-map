# Production Backup, Restore, and Disaster Recovery Runbook

This guide documents the procedures for backing up, restoring, and verifying the LiveMap canonical colony datasets and MongoDB collections.

---

## 1. Overview of Persistent Collections

The canonical colony GIS platform maintains state across the following MongoDB collections:

* `canonical_datasets`: Active and historical dataset metadata, approval statuses, SHA-256 hashes, CRS metadata.
* `canonical_plots`: Validated plot records with declared and geometry-derived measurements.
* `canonical_roads`: Road corridors and width measurements.
* `canonical_dimensions`: Dimension annotations and candidate association targets.
* `canonical_relationships`: Semantic topological relations (plot-to-road, shared boundaries).
* `review_corrections`: Immutable audit log of all human reviewer edits.
* `processing_runs`: Lineage records of extraction pipeline executions.
* `colonies`: Top-level tenant colony metadata.

---

## 2. Automated Daily Backup Procedure

Use `mongodump` with gzip compression and oplog archiving to ensure atomic snapshots:

```bash
#!/bin/bash
set -euo pipefail

TIMESTAMP=$(date -u +"%Y%m%d_%H%M%SZ")
BACKUP_DIR="/var/backups/livemap/${TIMESTAMP}"
mkdir -p "${BACKUP_DIR}"

echo "Starting atomic backup at ${TIMESTAMP}..."

mongodump \
  --uri="${MONGODB_URI}" \
  --db="${MONGODB_DB:-spacer_land}" \
  --gzip \
  --archive="${BACKUP_DIR}/livemap_dump_${TIMESTAMP}.archive.gz"

echo "Backup completed successfully: ${BACKUP_DIR}/livemap_dump_${TIMESTAMP}.archive.gz"
```

---

## 3. Restoration Procedure

### 3.1 Full Database Recovery

```bash
#!/bin/bash
set -euo pipefail

ARCHIVE_FILE="$1"

if [ -z "${ARCHIVE_FILE}" ] || [ ! -f "${ARCHIVE_FILE}" ]; then
  echo "Usage: ./restore.sh <path_to_archive.gz>"
  exit 1
fi

echo "Restoring database from ${ARCHIVE_FILE}..."

mongorestore \
  --uri="${MONGODB_URI}" \
  --gzip \
  --archive="${ARCHIVE_FILE}" \
  --drop

echo "Restoration finished. Running index initialization..."
python -m app.gis.canonical.init_db_indexes
```

### 3.2 Single Colony Version Rollback

Because every canonical dataset version is persisted immutably in `canonical_datasets` and `canonical_plots`, rolling back to a previous version does NOT require restoring from disk:

1. Query available versions:
   ```bash
   curl -X GET "https://api.domain.com/api/admin/colonies/{colonyId}/canonical/versions" \
     -H "Cookie: access_token=${TOKEN}"
   ```
2. Activate desired historical version `v_{TARGET}`:
   ```python
   # Mark current version inactive, set historical version as active
   await db["canonical_datasets"].update_many(
       {"colony_id": colony_id},
       {"$set": {"is_active": False}}
   )
   await db["canonical_datasets"].update_one(
       {"colony_id": colony_id, "version": TARGET_VERSION},
       {"$set": {"is_active": True}}
   )
   ```
3. The 2D/3D map and export endpoints immediately reflect the restored version without data loss.

---

## 4. Disaster Recovery & Health Verification

After restoring, verify system readiness using the deep health check:

```bash
curl -f https://api.domain.com/api/health
```

Expected response:
```json
{
  "status": "HEALTHY",
  "checks": {
    "database": {
      "status": "UP",
      "latency_ms": 2.14,
      "engine": "MongoDB"
    },
    "storage": {
      "status": "UP",
      "free_gb": 48.2
    },
    "gis_pipeline": {
      "status": "READY"
    }
  }
}
```
