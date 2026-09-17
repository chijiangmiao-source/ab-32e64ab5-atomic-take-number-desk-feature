"""Persistent storage for shot-number issuance.

The database is the single source of truth for two things:

* ``operations``      — the client_op_id -> shot_number mapping (idempotency log)
* ``scene_counters``  — the last issued shot number per scene

Transaction boundary
--------------------
``Storage.issue`` performs exactly one database transaction::

    BEGIN IMMEDIATE
      SELECT operations WHERE client_op_id = ?      -- idempotent replay / conflict check
      INSERT INTO scene_counters ... ON CONFLICT    -- atomic counter increment
        DO UPDATE ... RETURNING last_value
      INSERT INTO operations ...                    -- durable operation mapping
    COMMIT

* ``BEGIN IMMEDIATE`` acquires the database write lock up front, so at most one
  issuance transaction runs at any moment.  Concurrent requests are serialized
  and the assigned numbers follow the transaction commit order.
* The counter increment and the operation insert commit or roll back together,
  therefore a failed/aborted request can never leave a gap in the sequence.
* A committed row in ``operations`` is what makes retries safe: after a crash
  (or an injected post-commit failure) the same ``client_op_id`` simply replays
  the committed number.

SQLite is opened in WAL mode with ``synchronous=FULL`` so a committed
transaction survives an OS/process crash before any response is sent.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from dataclasses import dataclass
from typing import Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS scene_counters (
    scene_id   TEXT PRIMARY KEY,
    last_value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
    client_op_id TEXT PRIMARY KEY,
    scene_id     TEXT NOT NULL,
    notes        TEXT NOT NULL,
    shot_number  INTEGER NOT NULL,
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operations_scene
    ON operations (scene_id, shot_number);
"""

# Outcome statuses returned by Storage.issue
ISSUED = "issued"        # a brand-new number was allocated and committed
REPLAYED = "replayed"    # same client_op_id + same content: original number returned
CONFLICT = "conflict"    # same client_op_id but different content


@dataclass(frozen=True)
class Operation:
    client_op_id: str
    scene_id: str
    notes: str
    shot_number: int
    created_at: str

    def as_dict(self) -> dict:
        return {
            "client_op_id": self.client_op_id,
            "scene_id": self.scene_id,
            "notes": self.notes,
            "shot_number": self.shot_number,
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class IssueOutcome:
    status: str  # ISSUED | REPLAYED | CONFLICT
    operation: Optional[Operation] = None  # the stored operation (new or existing)


class Storage:
    """Thread-safe SQLite-backed issuer.

    A single connection guarded by a lock gives us strict serialization of
    writers inside the process; ``BEGIN IMMEDIATE`` + ``busy_timeout`` keep the
    same guarantee even if several processes share the database file.
    """

    def __init__(self, path: str):
        if path != ":memory:":
            directory = os.path.dirname(os.path.abspath(path))
            os.makedirs(directory, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=FULL")
            self._conn.execute("PRAGMA busy_timeout=10000")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.executescript(SCHEMA)

    @staticmethod
    def _row_to_operation(row: sqlite3.Row) -> Operation:
        return Operation(
            client_op_id=row["client_op_id"],
            scene_id=row["scene_id"],
            notes=row["notes"],
            shot_number=row["shot_number"],
            created_at=row["created_at"],
        )

    def issue(self, *, scene_id: str, client_op_id: str, notes: str) -> IssueOutcome:
        """Allocate the next shot number for ``scene_id`` or replay an existing one.

        Everything below happens inside ONE transaction; the shot number becomes
        visible to any other connection only after COMMIT.
        """
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                row = cur.execute(
                    "SELECT client_op_id, scene_id, notes, shot_number, created_at"
                    " FROM operations WHERE client_op_id = ?",
                    (client_op_id,),
                ).fetchone()

                if row is not None:
                    existing = self._row_to_operation(row)
                    if existing.scene_id == scene_id and existing.notes == notes:
                        # Idempotent replay: no counter movement, return the
                        # originally committed number.
                        cur.execute("COMMIT")
                        return IssueOutcome(REPLAYED, existing)
                    # Same identifier, different payload: reject without
                    # touching the counter.
                    cur.execute("ROLLBACK")
                    return IssueOutcome(CONFLICT, existing)

                last_value = cur.execute(
                    "INSERT INTO scene_counters (scene_id, last_value) VALUES (?, 1)"
                    " ON CONFLICT(scene_id) DO UPDATE SET last_value = last_value + 1"
                    " RETURNING last_value",
                    (scene_id,),
                ).fetchone()[0]

                created_at = cur.execute(
                    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')"
                ).fetchone()[0]
                cur.execute(
                    "INSERT INTO operations"
                    " (client_op_id, scene_id, notes, shot_number, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (client_op_id, scene_id, notes, last_value, created_at),
                )
                cur.execute("COMMIT")
                return IssueOutcome(
                    ISSUED,
                    Operation(
                        client_op_id=client_op_id,
                        scene_id=scene_id,
                        notes=notes,
                        shot_number=last_value,
                        created_at=created_at,
                    ),
                )
            except sqlite3.IntegrityError:
                # Defensive path for multi-process deployments: another writer
                # committed the same client_op_id between our check and insert.
                cur.execute("ROLLBACK")
                row = self._conn.execute(
                    "SELECT client_op_id, scene_id, notes, shot_number, created_at"
                    " FROM operations WHERE client_op_id = ?",
                    (client_op_id,),
                ).fetchone()
                existing = self._row_to_operation(row)
                if existing.scene_id == scene_id and existing.notes == notes:
                    return IssueOutcome(REPLAYED, existing)
                return IssueOutcome(CONFLICT, existing)
            except Exception:
                cur.execute("ROLLBACK")
                raise

    def list_operations(self, scene_id: str) -> list[Operation]:
        """All issued operations of a scene, ordered by shot number."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT client_op_id, scene_id, notes, shot_number, created_at"
                " FROM operations WHERE scene_id = ? ORDER BY shot_number",
                (scene_id,),
            ).fetchall()
        return [self._row_to_operation(row) for row in rows]

    def get_operation(self, client_op_id: str) -> Optional[Operation]:
        with self._lock:
            row = self._conn.execute(
                "SELECT client_op_id, scene_id, notes, shot_number, created_at"
                " FROM operations WHERE client_op_id = ?",
                (client_op_id,),
            ).fetchone()
        return self._row_to_operation(row) if row is not None else None

    def close(self) -> None:
        with self._lock:
            self._conn.close()
