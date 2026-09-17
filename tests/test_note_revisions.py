"""Acceptance tests for revisable shot notes.

Covered guarantees:

* legacy database migration: the issuance note is preserved verbatim as the
  immutable request fingerprint (revision 0), no manual intervention needed;
* retrying an issuance with the original client_op_id + original notes still
  replays the original number *after* the note has been revised;
* two terminals editing disjoint regions from the same base revision auto-
  merge into exactly one new revision;
* overlapping edits return 409 with three-way fragments and leave the
  database untouched; resolving and retrying commits the reconciled text;
* a retried (possibly already-committed) note update never double-counts a
  revision;
* note revisions never move the scene counter or the shot number.
"""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import httpx

from conftest import ApiServer


def issue_ok(base_url: str, scene: str, notes: str = "", op_id: str | None = None) -> dict:
    resp = httpx.post(
        f"{base_url}/api/shot-numbers",
        json={
            "scene_id": scene,
            "client_op_id": op_id or uuid.uuid4().hex,
            "notes": notes,
        },
        timeout=10.0,
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


def patch_notes(
    base_url: str, op_id: str, base_revision: int, notes: str
) -> httpx.Response:
    return httpx.patch(
        f"{base_url}/api/operations/{op_id}/notes",
        json={
            "client_op_id": op_id,
            "base_revision": base_revision,
            "notes": notes,
        },
        timeout=10.0,
    )


def revisions_of(base_url: str, op_id: str) -> list[dict]:
    resp = httpx.get(
        f"{base_url}/api/operations/{op_id}/note-revisions", timeout=10.0
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _create_legacy_database(path: Path) -> None:
    """Write a database file with the PRE-revision v1 schema."""
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE scene_counters (
                scene_id TEXT PRIMARY KEY,
                last_value INTEGER NOT NULL
            );
            CREATE TABLE operations (
                client_op_id TEXT PRIMARY KEY,
                scene_id     TEXT NOT NULL,
                notes        TEXT NOT NULL,
                shot_number  INTEGER NOT NULL,
                created_at   TEXT NOT NULL
            );
            CREATE INDEX idx_operations_scene ON operations (scene_id, shot_number);
            """
        )
        conn.execute("INSERT INTO scene_counters VALUES ('MIG-SCENE', 2)")
        conn.execute(
            "INSERT INTO operations VALUES"
            " ('legacy-op-1', 'MIG-SCENE', '发放备注一', 1, '2026-01-01T00:00:00.000Z')"
        )
        conn.execute(
            "INSERT INTO operations VALUES"
            " ('legacy-op-2', 'MIG-SCENE', '发放备注二', 2, '2026-01-02T00:00:00.000Z')"
        )
        conn.commit()
    finally:
        conn.close()


def test_legacy_database_migrates_and_original_notes_still_replay(tmp_path):
    db_path = tmp_path / "legacy.db"
    _create_legacy_database(db_path)

    # Starting the new service against the old file must work unattended.
    with ApiServer(db_path) as server:
        base = server.base_url

        # Retrying an issuance with the same client_op_id AND the original
        # issuance notes still replays the original shot number.
        replay = httpx.post(
            f"{base}/api/shot-numbers",
            json={
                "scene_id": "MIG-SCENE",
                "client_op_id": "legacy-op-1",
                "notes": "发放备注一",
            },
            timeout=10.0,
        )
        assert replay.status_code == 200
        body = replay.json()
        assert body["shot_number"] == 1
        assert body["replayed"] is True
        assert body["notes_revision"] == 0

        # Same id with different issuance content is still a fingerprint conflict.
        clash = httpx.post(
            f"{base}/api/shot-numbers",
            json={
                "scene_id": "MIG-SCENE",
                "client_op_id": "legacy-op-1",
                "notes": "偷换的发放内容",
            },
            timeout=10.0,
        )
        assert clash.status_code == 409

        # Migrated rows have revision 0 seeded in history.
        revs = revisions_of(base, "legacy-op-1")
        assert [r["revision"] for r in revs] == [0]
        assert revs[0]["notes"] == "发放备注一"

        # Revising a migrated note works; afterwards the ORIGINAL notes still
        # replay the original number (fingerprint never changes).
        saved = patch_notes(base, "legacy-op-1", 0, "场记事后补充的备注")
        assert saved.status_code == 200
        assert saved.json()["notes_revision"] == 1

        replay2 = httpx.post(
            f"{base}/api/shot-numbers",
            json={
                "scene_id": "MIG-SCENE",
                "client_op_id": "legacy-op-1",
                "notes": "发放备注一",
            },
            timeout=10.0,
        )
        assert replay2.status_code == 200
        assert replay2.json()["shot_number"] == 1
        assert replay2.json()["replayed"] is True

        # The counter survived migration untouched: the next issue is #3.
        nxt = issue_ok(base, "MIG-SCENE", notes="迁移后新发")
        assert nxt["shot_number"] == 3


def test_update_creates_incrementing_revisions_and_keeps_shot_number(api_server):
    base = api_server.base_url
    op = issue_ok(base, "NOTE-1", notes="初始备注")
    op_id = op["client_op_id"]
    assert op["notes_revision"] == 0

    r1 = patch_notes(base, op_id, 0, "第一次修订")
    assert r1.status_code == 200
    assert r1.json()["merge_status"] == "updated"
    assert r1.json()["notes_revision"] == 1
    assert r1.json()["shot_number"] == 1

    r2 = patch_notes(base, op_id, 1, "第二次修订")
    assert r2.status_code == 200
    assert r2.json()["notes_revision"] == 2

    history = revisions_of(base, op_id)
    assert [r["revision"] for r in history] == [0, 1, 2]
    assert [r["notes"] for r in history] == ["初始备注", "第一次修订", "第二次修订"]

    # The GET endpoints show the current note with its revision.
    listing = httpx.get(f"{base}/api/scenes/NOTE-1/operations", timeout=10.0).json()
    assert listing[0]["notes"] == "第二次修订"
    assert listing[0]["notes_revision"] == 2
    single = httpx.get(f"{base}/api/operations/{op_id}", timeout=10.0).json()
    assert single["notes"] == "第二次修订"


def test_two_terminals_disjoint_edits_auto_merge_into_one_revision(api_server):
    base = api_server.base_url
    op = issue_ok(base, "MERGE-D", notes="第一段\n第二段\n第三段\n")
    op_id = op["client_op_id"]

    # Terminal B commits first (both terminals started from revision 0).
    b = patch_notes(base, op_id, 0, "第一段\n第二段\n第三段（B改）\n")
    assert b.status_code == 200
    assert b.json()["notes_revision"] == 1

    # Terminal A saves against the now-stale base 0 but edits a disjoint line.
    a = patch_notes(base, op_id, 0, "第一段（A改）\n第二段\n第三段\n")
    assert a.status_code == 200, a.text
    body = a.json()
    assert body["merge_status"] == "merged"
    # Exactly one new revision was produced.
    assert body["notes_revision"] == 2
    assert body["notes"] == "第一段（A改）\n第二段\n第三段（B改）\n"

    history = revisions_of(base, op_id)
    assert [r["revision"] for r in history] == [0, 1, 2]


def test_overlapping_edits_return_409_with_three_way_fragments_and_change_nothing(
    api_server,
):
    base = api_server.base_url
    op = issue_ok(base, "CONFLICT-N", notes="开场镜头\n待定备注\n结尾\n")
    op_id = op["client_op_id"]

    # Terminal B wins revision 1 by editing the middle line.
    assert patch_notes(base, op_id, 0, "开场镜头\nB 的备注\n结尾\n").status_code == 200

    # Terminal A edits the same middle line from stale base 0.
    resp = patch_notes(base, op_id, 0, "开场镜头\nA 的备注\n结尾\n")
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["error"] == "notes_conflict"
    assert detail["current"]["notes_revision"] == 1
    fragments = detail["conflicts"]
    assert len(fragments) == 1
    assert fragments[0]["base"] == "待定备注\n"
    assert fragments[0]["mine"] == "A 的备注\n"
    assert fragments[0]["theirs"] == "B 的备注\n"

    # The database is untouched: still revision 1 with terminal B's text.
    current = httpx.get(f"{base}/api/operations/{op_id}", timeout=10.0).json()
    assert current["notes_revision"] == 1
    assert current["notes"] == "开场镜头\nB 的备注\n结尾\n"
    assert [r["revision"] for r in revisions_of(base, op_id)] == [0, 1]

    # The script supervisor reconciles against the server's current revision
    # and saves again: this becomes revision 2.
    resolved = patch_notes(
        base, op_id, 1, "开场镜头\nA+B 合并后的备注\n结尾\n"
    )
    assert resolved.status_code == 200
    assert resolved.json()["notes_revision"] == 2
    assert resolved.json()["notes"] == "开场镜头\nA+B 合并后的备注\n结尾\n"


def test_identical_concurrent_updates_commit_once_and_safe_retry_doubles_nothing(
    api_server,
):
    base = api_server.base_url
    op = issue_ok(base, "RETRY-N", notes="原文\n")
    op_id = op["client_op_id"]

    first = patch_notes(base, op_id, 0, "新文本\n")
    assert first.status_code == 200
    assert first.json()["notes_revision"] == 1

    # The first response was lost (network failure): the client retries the
    # very same request (same base revision 0, same text).  It must not create
    # a second revision.
    retry = patch_notes(base, op_id, 0, "新文本\n")
    assert retry.status_code == 200
    assert retry.json()["merge_status"] == "merged"
    assert retry.json()["notes_revision"] == 1
    assert retry.json()["notes"] == "新文本\n"
    assert [r["revision"] for r in revisions_of(base, op_id)] == [0, 1]


def test_note_revisions_survive_process_restart(api_server):
    base = api_server.base_url
    op = issue_ok(base, "RESTART-N", notes="发放备注")
    op_id = op["client_op_id"]
    assert patch_notes(base, op_id, 0, "重启前的修订").status_code == 200

    # Kill and restart against the same database file.
    api_server.stop()
    with ApiServer(api_server.db_path) as restarted:
        rbase = restarted.base_url
        current = httpx.get(f"{rbase}/api/operations/{op_id}", timeout=10.0).json()
        assert current["notes"] == "重启前的修订"
        assert current["notes_revision"] == 1
        # History is intact and revision continues exactly from 1.
        again = patch_notes(rbase, op_id, 1, "重启后的修订")
        assert again.status_code == 200
        assert again.json()["notes_revision"] == 2
        revs = revisions_of(rbase, op_id)
        assert [r["notes"] for r in revs] == ["发放备注", "重启前的修订", "重启后的修订"]
        # Issuance replay with the ORIGINAL fingerprint still works.
        replay = httpx.post(
            f"{rbase}/api/shot-numbers",
            json={"scene_id": "RESTART-N", "client_op_id": op_id, "notes": "发放备注"},
            timeout=10.0,
        )
        assert replay.status_code == 200
        assert replay.json()["shot_number"] == 1
        assert replay.json()["replayed"] is True


def test_note_conflicts_and_revisions_never_move_shot_sequence(api_server):
    base = api_server.base_url
    scene = "SEQ-N"
    op1 = issue_ok(base, scene, notes="第一条")
    op2 = issue_ok(base, scene, notes="第二条")
    assert (op1["shot_number"], op2["shot_number"]) == (1, 2)

    # Revisions...
    patch_notes(base, op1["client_op_id"], 0, "第一条 r1")
    # ...a rejected stale base (beyond history)...
    bad_base = patch_notes(base, op1["client_op_id"], 99, "乱序基础号")
    assert bad_base.status_code == 409
    # ...and an overlapping conflict.
    assert patch_notes(base, op1["client_op_id"], 0, "撞车内容").status_code == 409

    # The next issuance is exactly #3: nothing burned a number or moved counters.
    op3 = issue_ok(base, scene, notes="第三条")
    assert op3["shot_number"] == 3
    listing = httpx.get(f"{base}/api/scenes/{scene}/operations", timeout=10.0).json()
    assert [op["shot_number"] for op in listing] == [1, 2, 3]

    # Unknown operation id on the notes endpoint is a clean 404.
    assert patch_notes(base, uuid.uuid4().hex, 0, "x").status_code == 404
