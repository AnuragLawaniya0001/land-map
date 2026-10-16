"""Storage compatibility layer for the migrated Python API."""
import json
import hashlib
import hmac
import os
import re
import time
from pathlib import Path
from urllib.parse import quote

import requests

BACKEND_DIR = Path(__file__).resolve().parents[2]
DEFAULT_STORAGE_DIR = BACKEND_DIR / "node" / "storage"
STORAGE_DRIVER = os.environ.get("STORAGE_DRIVER", "local").strip().lower()
STORAGE_BASE = (os.environ.get("INTEGRATION_PROXY_URL") or "").strip() or "https://integrations.emergentagent.com"
STORAGE_URL = STORAGE_BASE.rstrip("/") + "/objstore/api/v1/storage"
EMERGENT_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
_storage_key = None


def _normalize_path(p: Path | str) -> Path:
    s = str(Path(p).resolve())
    if s.startswith("\\\\?\\"):
        s = s[4:]
    return Path(s)


def _storage_dir() -> Path:
    configured = os.environ.get("LOCAL_STORAGE_PATH", "").strip()
    if not configured:
        return _normalize_path(DEFAULT_STORAGE_DIR)
    path = Path(configured)
    base = (BACKEND_DIR / path) if not path.is_absolute() else path
    return _normalize_path(base)


def _safe_path(key: str) -> Path:
    if not isinstance(key, str) or not key or "\0" in key:
        raise ValueError("Storage key must be a non-empty string")
    root = _storage_dir()
    target = _normalize_path(root / key)
    root_str = os.path.normcase(str(root))
    target_str = os.path.normcase(str(target))
    try:
        common = os.path.commonpath([root_str, target_str])
        if common != root_str:
            raise ValueError("Storage key escapes the configured storage directory")
    except ValueError as exc:
        raise ValueError("Storage key escapes the configured storage directory") from exc
    return target


def sanitize_filename(filename: str) -> str:
    cleaned = Path(str(filename or "file").replace("\0", "").replace("\r", "_").replace("\n", "_")).name
    cleaned = re.sub(r"[^a-zA-Z0-9._-]", "_", cleaned)
    return cleaned if cleaned not in ("", ".", "..") else "file"


def build_storage_key(user_id: str, colony_id: str, category: str, filename: str,
                      plot_id: str = "", version: int = 1, doc_id: str = "") -> str:
    safe_name = sanitize_filename(filename)
    base = f"users/{user_id}/colonies/{colony_id}"
    if category == "registry":
        return f"{base}/registry/{plot_id}/v{version}-{doc_id}-{safe_name}"
    if category in ("media", "colony_media", "plot_media"):
        return f"{base}/media/{doc_id}-{safe_name}"
    return f"{base}/{category}/{doc_id}-{safe_name}"


def init_storage(force: bool = False) -> str:
    global _storage_key
    if STORAGE_DRIVER == "local":
        _storage_dir().mkdir(parents=True, exist_ok=True)
        return ""
    if STORAGE_DRIVER != "emergent":
        raise RuntimeError(f"Unsupported STORAGE_DRIVER: {STORAGE_DRIVER}")
    if _storage_key and not force:
        return _storage_key
    response = requests.post(
        f"{STORAGE_URL}/init", json={"emergent_key": EMERGENT_KEY}, timeout=5
    )
    response.raise_for_status()
    _storage_key = response.json()["storage_key"]
    return _storage_key


def put_object(key: str, data: bytes, content_type: str = "application/octet-stream") -> dict:
    if STORAGE_DRIVER == "local":
        path = _safe_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.with_name(path.name + ".meta.json").write_text(
            json.dumps({"mime": content_type, "size": len(data)}), encoding="utf-8"
        )
        return {"path": key, "size": len(data), "mime": content_type}
    storage_key = init_storage()
    response = requests.put(
        f"{STORAGE_URL}/objects/{quote(key, safe='/')}",
        headers={"X-Storage-Key": storage_key, "Content-Type": content_type},
        data=data,
        timeout=120,
    )
    if response.status_code == 404:
        storage_key = init_storage(force=True)
        response = requests.put(
            f"{STORAGE_URL}/objects/{quote(key, safe='/')}",
            headers={"X-Storage-Key": storage_key, "Content-Type": content_type},
            data=data,
            timeout=120,
        )
    response.raise_for_status()
    return response.json()


def get_object(key: str) -> tuple[bytes, str]:
    if STORAGE_DRIVER == "local":
        path = _safe_path(key)
        content = path.read_bytes()
        mime = "application/octet-stream"
        metadata_path = path.with_name(path.name + ".meta.json")
        if metadata_path.exists():
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            mime = metadata.get("mime", mime)
        return content, mime
    storage_key = init_storage()
    response = requests.get(
        f"{STORAGE_URL}/objects/{quote(key, safe='/')}",
        headers={"X-Storage-Key": storage_key},
        timeout=60,
    )
    if response.status_code == 404:
        storage_key = init_storage(force=True)
        response = requests.get(
            f"{STORAGE_URL}/objects/{quote(key, safe='/')}",
            headers={"X-Storage-Key": storage_key},
            timeout=60,
        )
    response.raise_for_status()
    return response.content, response.headers.get("Content-Type", "application/pdf")


def delete_object(key: str) -> dict:
    if STORAGE_DRIVER == "local":
        path = _safe_path(key)
        path.unlink(missing_ok=True)
        path.with_name(path.name + ".meta.json").unlink(missing_ok=True)
        return {"deleted": True}
    storage_key = init_storage()
    response = requests.delete(
        f"{STORAGE_URL}/objects/{quote(key, safe='/')}",
        headers={"X-Storage-Key": storage_key},
        timeout=60,
    )
    response.raise_for_status()
    return {"deleted": True}


def _signature(key: str, expires: int) -> str:
    secret = os.environ.get("JWT_SECRET", "livemap-dev-secret-change-in-prod")
    message = f"{key}:{expires}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def get_signed_url(key: str, expires_in_seconds: int = 3600) -> str:
    expires = int(time.time()) + expires_in_seconds
    signature = _signature(key, expires)
    return (
        f"/api/v1/media/download?key={quote(key, safe='')}"
        f"&expires={expires}&signature={signature}"
    )


def verify_signed_url(key: str, expires: int, signature: str) -> bool:
    current_time = int(time.time())
    return (
        current_time <= expires <= current_time + 86400
        and hmac.compare_digest(_signature(key, expires), signature)
    )
