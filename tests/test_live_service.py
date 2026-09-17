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
