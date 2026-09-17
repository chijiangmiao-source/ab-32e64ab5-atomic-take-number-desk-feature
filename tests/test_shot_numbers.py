"""Acceptance tests for the shot-number issuance API.

Covered guarantees:

* 20 concurrent operations -> exactly the numbers 1..20, no duplicates, no gaps
* same client_op_id + same content -> always the original number
* same client_op_id + different content -> 409
* process restart -> mappings and counters survive
* inject_failure_after_commit -> 503 after the durable commit, retry replays
"""

from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx

from conftest import ApiServer


def post_issue(base_url: str, **payload) -> httpx.Response:
    return httpx.post(f"{base_url}/api/shot-numbers", json=payload, timeout=10.0)


def issue_ok(base_url: str, scene: str, notes: str = "", op_id: str | None = None) -> dict:
    resp = post_issue(
        base_url,
        scene_id=scene,
        client_op_id=op_id or uuid.uuid4().hex,
        notes=notes,
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


def scene_numbers(base_url: str, scene: str) -> list[int]:
    resp = httpx.get(f"{base_url}/api/scenes/{scene}/operations", timeout=10.0)
    assert resp.status_code == 200, resp.text
    return [op["shot_number"] for op in resp.json()]


def test_concurrent_issue_twenty_operations_no_gaps(api_server):
    scene = "A-12"
    op_ids = [uuid.uuid4().hex for _ in range(20)]

    with ThreadPoolExecutor(max_workers=20) as pool:
        responses = list(
            pool.map(
                lambda op_id: post_issue(
                    api_server.base_url,
                    scene_id=scene,
                    client_op_id=op_id,
                    notes=f"镜头 {op_id[:8]}",
                ),
                op_ids,
            )
        )

    assert all(r.status_code == 201 for r in responses)
    numbers = sorted(r.json()["shot_number"] for r in responses)
    assert numbers == list(range(1, 21)), "号码必须无重复、无缺口"
    # The scene board agrees with what was handed out.
    assert scene_numbers(api_server.base_url, scene) == list(range(1, 21))


def test_concurrent_duplicate_submissions_return_same_number(api_server):
    op_id = uuid.uuid4().hex
    payload = {"scene_id": "B-3", "client_op_id": op_id, "notes": "雨夜追车"}

    with ThreadPoolExecutor(max_workers=10) as pool:
        responses = list(
            pool.map(lambda _: post_issue(api_server.base_url, **payload), range(10))
        )

    assert all(r.status_code in (200, 201) for r in responses)
    numbers = {r.json()["shot_number"] for r in responses}
    assert len(numbers) == 1, "同一操作标识无论并发多少都只能得到一个号码"
    assert scene_numbers(api_server.base_url, "B-3") == [numbers.pop()]


def test_sequential_retry_returns_same_number(api_server):
    op_id = uuid.uuid4().hex
    first = issue_ok(api_server.base_url, "C-1", notes="开场", op_id=op_id)
    assert first["replayed"] is False

    for _ in range(3):
        again = issue_ok(api_server.base_url, "C-1", notes="开场", op_id=op_id)
        assert again["shot_number"] == first["shot_number"]
        assert again["replayed"] is True

    assert scene_numbers(api_server.base_url, "C-1") == [first["shot_number"]]


def test_same_id_with_different_content_returns_409(api_server):
    op_id = uuid.uuid4().hex
    first = issue_ok(api_server.base_url, "D-5", notes="原始备注", op_id=op_id)

    resp = post_issue(
        api_server.base_url,
        scene_id="D-5",
        client_op_id=op_id,
        notes="被改动的备注",
    )
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["error"] == "client_op_id_conflict"
    assert detail["existing"]["shot_number"] == first["shot_number"]

    # A different scene with the same id is also a conflict.
    resp = post_issue(
        api_server.base_url,
        scene_id="D-6",
        client_op_id=op_id,
        notes="原始备注",
    )
    assert resp.status_code == 409

    # The conflict must not consume a number: the next fresh op continues the
    # sequence without a gap.
    nxt = issue_ok(api_server.base_url, "D-5", notes="下一条")
    assert nxt["shot_number"] == first["shot_number"] + 1


def test_restart_preserves_mapping_and_counter(api_server):
    ops = [issue_ok(api_server.base_url, "E-7", notes=f"第{i}条") for i in range(3)]
    assert [op["shot_number"] for op in ops] == [1, 2, 3]

    # Simulate a crash: kill the process, then start a brand-new one against
    # the same database file.
    api_server.stop()
    with ApiServer(api_server.db_path) as restarted:
        # Retrying an old operation replays the committed number.
        replay = post_issue(
            restarted.base_url,
            scene_id="E-7",
            client_op_id=ops[1]["client_op_id"],
            notes="第1条",
        )
        assert replay.status_code == 200
        assert replay.json()["shot_number"] == 2
        assert replay.json()["replayed"] is True

        # New operations continue the sequence exactly where it stopped.
        fresh = issue_ok(restarted.base_url, "E-7", notes="重启后的第一条")
        assert fresh["shot_number"] == 4
        assert scene_numbers(restarted.base_url, "E-7") == [1, 2, 3, 4]


def test_inject_failure_after_commit_then_retry(api_server):
    op_id = uuid.uuid4().hex
    payload = {"scene_id": "F-9", "client_op_id": op_id, "notes": "爆破长镜头"}

    # First attempt: the number is committed, but the client only sees a 503.
    resp = post_issue(api_server.base_url, **payload, inject_failure_after_commit=True)
    assert resp.status_code == 503
    assert resp.json()["detail"]["error"] == "injected_failure_after_commit"

    # Despite the 503 the operation was durably committed.
    assert scene_numbers(api_server.base_url, "F-9") == [1]

    # Retry with the same identifier: the original number comes back and the
    # failure is NOT triggered again.
    retry = post_issue(api_server.base_url, **payload)
    assert retry.status_code == 200
    assert retry.json()["shot_number"] == 1
    assert retry.json()["replayed"] is True

    # Even if the retry itself carries the injection flag, a replay never fails.
    retry2 = post_issue(api_server.base_url, **payload, inject_failure_after_commit=True)
    assert retry2.status_code == 200
    assert retry2.json()["shot_number"] == 1

    # The next distinct operation gets the next number — the injected failure
    # did not burn or skip anything.
    nxt = issue_ok(api_server.base_url, "F-9", notes="下一条")
    assert nxt["shot_number"] == 2
    assert scene_numbers(api_server.base_url, "F-9") == [1, 2]


def test_scenes_have_independent_sequences(api_server):
    a1 = issue_ok(api_server.base_url, "G-1", notes="a1")
    a2 = issue_ok(api_server.base_url, "G-1", notes="a2")
    b1 = issue_ok(api_server.base_url, "G-2", notes="b1")

    assert (a1["shot_number"], a2["shot_number"], b1["shot_number"]) == (1, 2, 1)
    assert scene_numbers(api_server.base_url, "G-1") == [1, 2]
    assert scene_numbers(api_server.base_url, "G-2") == [1]


def test_concurrent_mixed_scenes_each_sequence_tight(api_server):
    tasks = [
        ("H-1" if i % 2 == 0 else "H-2", uuid.uuid4().hex, f"镜头{i}")
        for i in range(20)
    ]

    with ThreadPoolExecutor(max_workers=20) as pool:
        responses = list(
            pool.map(
                lambda t: post_issue(
                    api_server.base_url, scene_id=t[0], client_op_id=t[1], notes=t[2]
                ),
                tasks,
            )
        )

    assert all(r.status_code == 201 for r in responses)
    assert scene_numbers(api_server.base_url, "H-1") == list(range(1, 11))
    assert scene_numbers(api_server.base_url, "H-2") == list(range(1, 11))
