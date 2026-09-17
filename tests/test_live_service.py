"""Tests that run against a live, already-deployed service.

Used by the Docker Compose ``verify`` acceptance service, which sets
``API_BASE_URL=http://api:8000``.  All scenes and operation ids are unique per
run so the suite is safe to repeat against a persistent database.
"""

from __future__ import annotations

import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

BASE_URL = os.environ.get("API_BASE_URL", "").rstrip("/")

pytestmark = pytest.mark.skipif(
    not BASE_URL, reason="API_BASE_URL not set; skipping live-service tests"
)


def _scene() -> str:
    return f"live-{uuid.uuid4().hex[:12]}"


def test_live_health():
    resp = httpx.get(f"{BASE_URL}/api/health", timeout=10.0)
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_live_twenty_concurrent_operations_are_gapless():
    scene = _scene()
    op_ids = [uuid.uuid4().hex for _ in range(20)]

    with ThreadPoolExecutor(max_workers=20) as pool:
        responses = list(
            pool.map(
                lambda op_id: httpx.post(
                    f"{BASE_URL}/api/shot-numbers",
                    json={"scene_id": scene, "client_op_id": op_id, "notes": "并发"},
                    timeout=15.0,
                ),
                op_ids,
            )
        )

    assert all(r.status_code == 201 for r in responses)
    numbers = sorted(r.json()["shot_number"] for r in responses)
    assert numbers == list(range(1, 21))


def test_live_duplicate_and_conflict():
    scene = _scene()
    op_id = uuid.uuid4().hex
    payload = {"scene_id": scene, "client_op_id": op_id, "notes": "第一条"}

    first = httpx.post(f"{BASE_URL}/api/shot-numbers", json=payload, timeout=10.0)
    assert first.status_code == 201

    replay = httpx.post(f"{BASE_URL}/api/shot-numbers", json=payload, timeout=10.0)
    assert replay.status_code == 200
    assert replay.json()["shot_number"] == first.json()["shot_number"]
    assert replay.json()["replayed"] is True

    conflict = httpx.post(
        f"{BASE_URL}/api/shot-numbers",
        json={**payload, "notes": "换内容"},
        timeout=10.0,
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["error"] == "client_op_id_conflict"


def test_live_injected_failure_replays_original_number():
    scene = _scene()
    op_id = uuid.uuid4().hex
    payload = {"scene_id": scene, "client_op_id": op_id, "notes": "故障注入"}

    failed = httpx.post(
        f"{BASE_URL}/api/shot-numbers",
        json={**payload, "inject_failure_after_commit": True},
        timeout=10.0,
    )
    assert failed.status_code == 503

    retry = httpx.post(f"{BASE_URL}/api/shot-numbers", json=payload, timeout=10.0)
    assert retry.status_code == 200
    assert retry.json()["shot_number"] == 1
    assert retry.json()["replayed"] is True


def _patch_notes(op_id: str, base_revision: int, new_notes: str) -> httpx.Response:
    return httpx.patch(
        f"{BASE_URL}/api/operations/{op_id}/notes",
        json={"base_revision": base_revision, "new_notes": new_notes},
        timeout=10.0,
    )


def test_live_note_revisions_merge_conflict_and_unchanged_sequence():
    """Revisioned notes end-to-end against the deployed service.

    * issuance replay with the original notes still returns the same number
      after the notes were revised (fingerprint is immutable);
    * two terminals editing different lines auto-merge into one revision;
    * overlapping edits return a 409 with three-way fragments and nothing
      moves in the database; after reconciling, the save lands;
    * note revisions never consume shot numbers.
    """
    scene = _scene()
    first = httpx.post(
        f"{BASE_URL}/api/shot-numbers",
        json={
            "scene_id": scene,
            "client_op_id": uuid.uuid4().hex,
            "notes": "第一段\n第二段\n第三段\n",
        },
        timeout=10.0,
    )
    assert first.status_code == 201
    op_id = first.json()["client_op_id"]
    assert first.json()["notes_revision"] == 1

    # Terminal B (bases on r1) revises the third section.
    b_save = _patch_notes(op_id, 1, "第一段\n第二段\n第三段（乙补光）\n")
    assert b_save.status_code == 200
    assert b_save.json()["notes_revision"] == 2
    assert b_save.json()["merged"] is False

    # Terminal A, still on r1, revises a different section: auto-merge.
    a_save = _patch_notes(op_id, 1, "第一段（甲改景别）\n第二段\n第三段\n")
    assert a_save.status_code == 200
    merged = a_save.json()
    assert merged["merged"] is True
    assert merged["notes_revision"] == 3
    assert merged["notes"] == "第一段（甲改景别）\n第二段\n第三段（乙补光）\n"

    # A stale r1 edit touching a region B changed: 409 with fragments, DB still.
    clash = _patch_notes(op_id, 1, "第一段\n第二段\n第三段（甲也改）\n")
    assert clash.status_code == 409
    detail = clash.json()["detail"]
    assert detail["error"] == "notes_revision_conflict"
    assert detail["current_revision"] == 3
    assert len(detail["fragments"]) >= 1
    untouched = httpx.get(f"{BASE_URL}/api/operations/{op_id}", timeout=10.0)
    assert untouched.json()["notes_revision"] == 3

    # Clerk resolves against the current revision.
    resolved = _patch_notes(op_id, 3, "第一段（甲改景别）\n第二段\n第三段（定稿）\n")
    assert resolved.status_code == 200
    assert resolved.json()["notes_revision"] == 4

    # Retrying the ORIGINAL issuance request still replays number 1.
    replay = httpx.post(
        f"{BASE_URL}/api/shot-numbers",
        json={
            "scene_id": scene,
            "client_op_id": op_id,
            "notes": "第一段\n第二段\n第三段\n",
        },
        timeout=10.0,
    )
    assert replay.status_code == 200
    assert replay.json()["shot_number"] == 1
    assert replay.json()["replayed"] is True
    assert replay.json()["notes_revision"] == 4

    # History: revision 1 is the immutable issuance text.
    history = httpx.get(
        f"{BASE_URL}/api/operations/{op_id}/note-revisions", timeout=10.0
    )
    assert history.status_code == 200
    revisions = history.json()
    assert [r["revision"] for r in revisions] == [1, 2, 3, 4]
    assert revisions[0]["notes"] == "第一段\n第二段\n第三段\n"

    # The next fresh issuance is number 2 — revisions never touched the counter.
    nxt = httpx.post(
        f"{BASE_URL}/api/shot-numbers",
        json={"scene_id": scene, "client_op_id": uuid.uuid4().hex, "notes": "新镜头"},
        timeout=10.0,
    )
    assert nxt.status_code == 201
    assert nxt.json()["shot_number"] == 2
    board = httpx.get(f"{BASE_URL}/api/scenes/{scene}/operations", timeout=10.0)
    assert [row["shot_number"] for row in board.json()] == [1, 2]
