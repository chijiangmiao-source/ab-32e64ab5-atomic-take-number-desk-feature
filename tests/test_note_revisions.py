"""Acceptance tests for mutable, revisioned operation notes.

Covered guarantees:

* a database written by the pre-revision release is migrated automatically on
  startup (no manual step); the issuance notes become the immutable request
  fingerprint and revision 1 of the history;
* the same client_op_id retried with the original issuance notes always
  replays the original number, even after the notes were revised;
* two clerks editing different lines from the same base revision auto-merge
  into exactly one new revision;
* overlapping edits return 409 with three-way fragments and leave the database
  untouched; after reconciling against the current revision the save succeeds;
* a failed note save can be retried safely (no phantom revisions);
* note revisions never move a scene counter, a shot number or a client_op_id.
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
    base_url: str,
    op_id: str,
    *,
    base_revision: int,
    new_notes: str,
) -> httpx.Response:
    return httpx.patch(
        f"{base_url}/api/operations/{op_id}/notes",
        json={"base_revision": base_revision, "new_notes": new_notes},
        timeout=10.0,
    )


def revisions_of(base_url: str, op_id: str) -> list[dict]:
    resp = httpx.get(
        f"{base_url}/api/operations/{op_id}/note-revisions", timeout=10.0
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _create_legacy_database(path: Path, scene: str) -> list[tuple[str, str, int]]:
    """Write a database file using the OLD schema (single notes column)."""
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
                scene_id TEXT NOT NULL,
                notes TEXT NOT NULL,
                shot_number INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX idx_operations_scene ON operations (scene_id, shot_number);
            """
        )
        rows = [
            ("legacy-op-1", "迁移备注一", 1),
            ("legacy-op-2", "迁移备注二", 2),
        ]
        conn.execute(
            "INSERT INTO scene_counters (scene_id, last_value) VALUES (?, ?)",
            (scene, len(rows)),
        )
        for index, (op_id, notes, number) in enumerate(rows, start=1):
            conn.execute(
                "INSERT INTO operations (client_op_id, scene_id, notes, shot_number, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (op_id, scene, notes, number, f"2026-01-0{index}T00:00:00.000Z"),
            )
        conn.commit()
    finally:
        conn.close()
    return rows


def test_legacy_database_migrates_and_original_request_replays(tmp_path: Path):
    scene = "MIG-1"
    db_path = tmp_path / "legacy.db"
    legacy_rows = _create_legacy_database(db_path, scene)

    # The service starts against the old file and migrates it itself; no manual
    # preparation is required.
    with ApiServer(db_path) as server:
        # Same client_op_id + the original issuance notes still replays the
        # original number (fingerprint survived the migration).
        replay = httpx.post(
            f"{server.base_url}/api/shot-numbers",
            json={
                "scene_id": scene,
                "client_op_id": "legacy-op-1",
                "notes": "迁移备注一",
            },
            timeout=10.0,
        )
        assert replay.status_code == 200
        assert replay.json()["shot_number"] == 1
        assert replay.json()["replayed"] is True
        assert replay.json()["notes_revision"] == 1
        assert replay.json()["notes"] == "迁移备注一"

        # Different payload on the same id is still a conflict.
        conflict = httpx.post(
            f"{server.base_url}/api/shot-numbers",
            json={
                "scene_id": scene,
                "client_op_id": "legacy-op-1",
                "notes": "被改掉的指纹",
            },
            timeout=10.0,
        )
        assert conflict.status_code == 409

        # History was seeded with revision 1 equal to the issuance notes.
        history = revisions_of(server.base_url, "legacy-op-2")
        assert [h["revision"] for h in history] == [1]
        assert history[0]["notes"] == "迁移备注二"

        # The board still lists exactly the legacy numbers in order.
        board = httpx.get(
            f"{server.base_url}/api/scenes/{scene}/operations", timeout=10.0
        )
        assert [op["shot_number"] for op in board.json()] == [1, 2]

        # A brand-new issue continues the legacy counter at 3.
        nxt = issue_ok(server.base_url, scene, notes="迁移后新镜头")
        assert nxt["shot_number"] == 3

    # Restarting again on the already-migrated database must be idempotent.
    with ApiServer(db_path) as restarted:
        replay = httpx.post(
            f"{restarted.base_url}/api/shot-numbers",
            json={
                "scene_id": scene,
                "client_op_id": "legacy-op-1",
                "notes": "迁移备注一",
            },
            timeout=10.0,
        )
        assert replay.status_code == 200
        assert replay.json()["shot_number"] == 1
        board = httpx.get(
            f"{restarted.base_url}/api/scenes/{scene}/operations", timeout=10.0
        )
        assert [op["shot_number"] for op in board.json()] == [1, 2, 3]
        # No duplicate revision-1 rows from a second migration.
        assert len(revisions_of(restarted.base_url, "legacy-op-1")) == 1


def test_revised_notes_do_not_change_issuance_fingerprint_or_sequence(api_server):
    scene = "REV-1"
    first = issue_ok(api_server.base_url, scene, notes="发放时备注")
    op_id = first["client_op_id"]
    assert first["notes_revision"] == 1

    saved = patch_notes(
        api_server.base_url,
        op_id,
        base_revision=1,
        new_notes="场记修订后的备注",
    )
    assert saved.status_code == 200
    assert saved.json()["notes_revision"] == 2
    assert saved.json()["notes"] == "场记修订后的备注"
    assert saved.json()["shot_number"] == first["shot_number"]

    # Retrying the ORIGINAL issuance request verbatim still returns the same
    # number — the revised notes do not participate in idempotency.
    replay = httpx.post(
        f"{api_server.base_url}/api/shot-numbers",
        json={"scene_id": scene, "client_op_id": op_id, "notes": "发放时备注"},
        timeout=10.0,
    )
    assert replay.status_code == 200
    assert replay.json()["shot_number"] == first["shot_number"]
    assert replay.json()["replayed"] is True
    # The replay returns the *current* editable notes.
    assert replay.json()["notes"] == "场记修订后的备注"
    assert replay.json()["notes_revision"] == 2

    # History holds both versions; revision 1 is the immutable issuance text.
    history = revisions_of(api_server.base_url, op_id)
    assert [h["revision"] for h in history] == [1, 2]
    assert history[0]["notes"] == "发放时备注"
    assert history[1]["notes"] == "场记修订后的备注"

    # Revisions never burn a number: the next issue is exactly number 2.
    nxt = issue_ok(api_server.base_url, scene, notes="下一条")
    assert nxt["shot_number"] == 2


def test_two_terminals_disjoint_edits_auto_merge_into_one_revision(api_server):
    scene = "MERGE-1"
    op = issue_ok(
        api_server.base_url,
        scene,
        notes="第一段\n第二段\n第三段\n",
    )
    op_id = op["client_op_id"]

    # Terminal B saves first (bases on r1).
    b_save = patch_notes(
        api_server.base_url,
        op_id,
        base_revision=1,
        new_notes="第一段\n第二段\n第三段（终端乙补光说明）\n",
    )
    assert b_save.status_code == 200
    assert b_save.json()["notes_revision"] == 2
    assert b_save.json()["merged"] is False

    # Terminal A still holds r1 and edits a different line.
    a_save = patch_notes(
        api_server.base_url,
        op_id,
        base_revision=1,
        new_notes="第一段（终端甲改景别）\n第二段\n第三段\n",
    )
    assert a_save.status_code == 200, a_save.text
    body = a_save.json()
    assert body["merged"] is True
    # Exactly one new revision was produced by the merge.
    assert body["notes_revision"] == 3
    assert body["notes"] == (
        "第一段（终端甲改景别）\n第二段\n第三段（终端乙补光说明）\n"
    )

    history = revisions_of(api_server.base_url, op_id)
    assert [h["revision"] for h in history] == [1, 2, 3]
    assert history[2]["notes"] == (
        "第一段（终端甲改景别）\n第二段\n第三段（终端乙补光说明）\n"
    )

    # Only the single issued number exists for the scene; merges add no numbers.
    board = httpx.get(
        f"{api_server.base_url}/api/scenes/{scene}/operations", timeout=10.0
    )
    assert [row["shot_number"] for row in board.json()] == [1]


def test_overlapping_edits_return_409_with_fragments_and_then_resolve(api_server):
    scene = "CONFLICT-1"
    op = issue_ok(api_server.base_url, scene, notes="行一\n行二\n行三\n")
    op_id = op["client_op_id"]

    b_save = patch_notes(
        api_server.base_url,
        op_id,
        base_revision=1,
        new_notes="行一-乙\n行二\n行三\n",
    )
    assert b_save.status_code == 200
    assert b_save.json()["notes_revision"] == 2

    # Terminal A edits the SAME line while still basing on r1.
    conflict_resp = patch_notes(
        api_server.base_url,
        op_id,
        base_revision=1,
        new_notes="行一-甲\n行二\n行三\n",
    )
    assert conflict_resp.status_code == 409
    detail = conflict_resp.json()["detail"]
    assert detail["error"] == "notes_revision_conflict"
    assert detail["base_revision"] == 1
    assert detail["current_revision"] == 2
    assert detail["current_notes"] == "行一-乙\n行二\n行三\n"
    overlapping = [f for f in detail["fragments"] if f["base"].startswith("行一")]
    assert overlapping and overlapping[0]["current"].startswith("行一-乙")
    assert overlapping[0]["incoming"].startswith("行一-甲")

    # The conflict left the database exactly as it was: still r2, no new row.
    current = httpx.get(
        f"{api_server.base_url}/api/operations/{op_id}", timeout=10.0
    ).json()
    assert current["notes_revision"] == 2
    assert current["notes"] == "行一-乙\n行二\n行三\n"
    assert [h["revision"] for h in revisions_of(api_server.base_url, op_id)] == [1, 2]

    # The clerk reconciles server text with the local draft and saves again,
    # now basing the edit on the current revision r2.
    resolved = patch_notes(
        api_server.base_url,
        op_id,
        base_revision=2,
        new_notes="行一-甲乙定稿\n行二\n行三\n",
    )
    assert resolved.status_code == 200
    assert resolved.json()["notes_revision"] == 3
    assert resolved.json()["notes"] == "行一-甲乙定稿\n行二\n行三\n"
    assert [h["revision"] for h in revisions_of(api_server.base_url, op_id)] == [
        1,
        2,
        3,
    ]


def test_failed_note_save_retries_without_duplicate_revisions(api_server):
    scene = "RETRY-NOTES-1"
    op = issue_ok(api_server.base_url, scene, notes="原始备注")
    op_id = op["client_op_id"]

    # A request that fails on the network may or may not have landed.  Retrying
    # the identical (base_revision, text) pair must converge to one revision.
    first = patch_notes(
        api_server.base_url, op_id, base_revision=1, new_notes="第一次修订"
    )
    assert first.status_code == 200
    assert first.json()["notes_revision"] == 2

    # Pretend the client never saw that response and retries verbatim: the
    # desired text already equals the server text, so no revision is added.
    retry = patch_notes(
        api_server.base_url, op_id, base_revision=1, new_notes="第一次修订"
    )
    assert retry.status_code == 200
    assert retry.json()["notes_revision"] == 2

    # A retry that genuinely failed (server never committed it) lands normally.
    # Simulate with a fresh edit based on the current revision, attempted twice
    # with identical payloads: only the first creates a revision.
    attempt = patch_notes(
        api_server.base_url, op_id, base_revision=2, new_notes="第二次修订"
    )
    assert attempt.status_code == 200 and attempt.json()["notes_revision"] == 3
    duplicate = patch_notes(
        api_server.base_url, op_id, base_revision=2, new_notes="第二次修订"
    )
    assert duplicate.status_code == 200
    assert duplicate.json()["notes_revision"] == 3
    assert [h["revision"] for h in revisions_of(api_server.base_url, op_id)] == [
        1,
        2,
        3,
    ]


def test_unknown_or_impossible_base_revision_rejected(api_server):
    op = issue_ok(api_server.base_url, "BASE-1", notes="备注")

    missing = patch_notes(
        api_server.base_url, "no-such-op", base_revision=1, new_notes="x"
    )
    assert missing.status_code == 404

    too_new = patch_notes(
        api_server.base_url,
        op["client_op_id"],
        base_revision=42,
        new_notes="x",
    )
    assert too_new.status_code == 400
    assert too_new.json()["detail"]["error"] == "base_revision_unknown"
    assert too_new.json()["detail"]["current_revision"] == 1
    # The rejected base did not create a revision.
    assert len(revisions_of(api_server.base_url, op["client_op_id"])) == 1


def test_note_revisions_never_touch_scene_shot_or_counter(api_server):
    scene = "SEQ-1"
    ops = [issue_ok(api_server.base_url, scene, notes=f"镜头{i}") for i in range(3)]
    assert [o["shot_number"] for o in ops] == [1, 2, 3]

    # Revise notes many times, including a merge.
    target = ops[0]["client_op_id"]
    assert patch_notes(
        api_server.base_url, target, base_revision=1, new_notes="改a"
    ).json()["notes_revision"] == 2
    assert patch_notes(
        api_server.base_url, target, base_revision=2, new_notes="改b"
    ).json()["notes_revision"] == 3

    board = httpx.get(
        f"{api_server.base_url}/api/scenes/{scene}/operations", timeout=10.0
    ).json()
    assert [row["shot_number"] for row in board] == [1, 2, 3]
    assert [row["client_op_id"] for row in board] == [o["client_op_id"] for o in ops]
    # Shot numbers and scene ids on the revised row are unchanged.
    revised_row = next(row for row in board if row["client_op_id"] == target)
    assert revised_row["shot_number"] == 1
    assert revised_row["scene_id"] == scene
    assert revised_row["notes"] == "改b"

    # The next fresh issuance continues the sequence with no gap.
    assert issue_ok(api_server.base_url, scene, notes="镜头3")["shot_number"] == 4
