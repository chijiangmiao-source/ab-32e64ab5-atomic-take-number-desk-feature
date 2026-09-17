"""pytest fixtures: run the real FastAPI service as a subprocess.

Every test talks to the service over real HTTP against a real SQLite database
file in a temporary directory — no mocks, no stubs.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

API_DIR = Path(__file__).resolve().parent.parent / "api"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ApiServer:
    """A running uvicorn process bound to a specific database file."""

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.port = _free_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.process: subprocess.Popen | None = None

    def start(self) -> "ApiServer":
        assert self.process is None, "server already running"
        env = {
            **os.environ,
            "SHOT_DB_PATH": str(self.db_path),
            "ALLOW_FAILURE_INJECTION": "true",
        }
        self.process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
            ],
            cwd=str(API_DIR),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self._wait_until_healthy()
        return self

    def _wait_until_healthy(self, timeout: float = 20.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process is not None and self.process.poll() is not None:
                raise RuntimeError("api process exited during startup")
            try:
                resp = httpx.get(f"{self.base_url}/api/health", timeout=1.0)
                if resp.status_code == 200:
                    return
            except httpx.TransportError:
                pass
            time.sleep(0.1)
        raise RuntimeError("api did not become healthy in time")

    def stop(self) -> None:
        if self.process is None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=10)
        self.process = None

    def __enter__(self) -> "ApiServer":
        return self.start()

    def __exit__(self, *exc_info) -> None:
        self.stop()


@pytest.fixture()
def api_server(tmp_path: Path):
    """A fresh service instance with an empty database (function scoped)."""
    server = ApiServer(tmp_path / "shotnumbers.db")
    server.start()
    try:
        yield server
    finally:
        server.stop()
