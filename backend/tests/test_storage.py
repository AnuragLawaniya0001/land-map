from pathlib import Path

import pytest

from app import storage


def test_local_storage_round_trip_uses_safe_configured_path(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "STORAGE_DRIVER", "local")
    monkeypatch.setenv("LOCAL_STORAGE_PATH", str(tmp_path))
    key = storage.build_storage_key(
        user_id="user",
        colony_id="colony",
        category="registry",
        plot_id="plot",
        filename="registry final.pdf",
        version=1,
        doc_id="document",
    )

    result = storage.put_object(key, b"%PDF-test", "application/pdf")

    assert result["path"] == key
    assert storage.get_object(key) == (b"%PDF-test", "application/pdf")
    assert Path(tmp_path, key + ".meta.json").is_file()
    assert storage.delete_object(key) == {"deleted": True}
    with pytest.raises(FileNotFoundError):
        storage.get_object(key)


def test_local_storage_rejects_path_traversal(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "STORAGE_DRIVER", "local")
    monkeypatch.setenv("LOCAL_STORAGE_PATH", str(tmp_path))

    with pytest.raises(ValueError, match="escapes"):
        storage.put_object("../outside.txt", b"private", "text/plain")


def test_media_url_signature_expires_and_is_bound_to_key(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    url = storage.get_signed_url("users/u/colonies/c/media/image.jpg", 60)
    query = url.split("?", 1)[1]
    params = dict(part.split("=", 1) for part in query.split("&"))

    assert storage.verify_signed_url(
        "users/u/colonies/c/media/image.jpg",
        int(params["expires"]),
        params["signature"],
    )
    assert not storage.verify_signed_url(
        "users/u/colonies/c/media/other.jpg",
        int(params["expires"]),
        params["signature"],
    )
