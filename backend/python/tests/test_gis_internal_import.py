import asyncio
from io import BytesIO

from fastapi import UploadFile

from app import server


def test_internal_import_forwards_colony_id_and_import_timestamp(monkeypatch):
    captured = {}

    def fake_import_file(**kwargs):
        captured.update(kwargs)
        return (
            {"id": kwargs["colony_id"], "import_source": {}},
            [{"colony_id": kwargs["colony_id"]}],
            [{"colony_id": kwargs["colony_id"]}],
            [],
        )

    monkeypatch.setattr(server.importer, "import_file", fake_import_file)
    response = asyncio.run(server.internal_import(
        file=UploadFile(filename="layout.pdf", file=BytesIO(b"%PDF-test")),
        maps_link=None,
        control_points=None,
        rotation=None,
        target_boundary=None,
        colony_id="colony-real-id",
        now="2026-10-07T06:30:00Z",
    ))

    assert captured["colony_id"] == "colony-real-id"
    assert captured["now"] == "2026-10-07T06:30:00Z"
    assert response["colony"]["id"] == "colony-real-id"
    assert response["zones"][0]["colony_id"] == "colony-real-id"
    assert response["plots"][0]["colony_id"] == "colony-real-id"