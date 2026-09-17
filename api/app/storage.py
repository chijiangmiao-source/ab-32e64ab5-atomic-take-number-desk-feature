"""Persistent storage for shot-number issuance.

The database is the single source of truth for:

* ``operations``      — the client_op_id -> shot_number mapping (idempotency
                        log), plus the *revisable* note currently shown on
                        the scene board;
* ``scene_counters``  — the last issued shot number per scene;
* ``note_revisions``  — immutable history of every note version.

Immutable request fingerprint
-----------------------------
Only ``scene_id`` and ``notes_fingerprint`` participate in idempotency
conflict detection.  The fingerprint is fixed at issuance time and never
changes afterwards; ``notes`` is freely revisable through
``Storage.update_notes``.  Therefore editing a note after the shot number
was handed out can never turn a retried issuance into a 409.

Transaction boundaries
----------------------
``Storage.issue`` performs exactly one database transaction::

    BEGIN IMMEDIATE
      SELECT operations WHERE client_op_id = ?      -- idempotent replay / conflict check
      INSERT INTO scene_counters ... ON CONFLICT    -- atomic counter increment
        DO UPDATE ... RETURNING last_value
      INSERT INTO operations ...                    -- durable operation mapping
      INSERT INTO note_revisions ... (revision 0)   -- issuance note = first revision
    COMMIT

``Storage.update_notes`` also performs exactly one transaction: the new
``operations`` row state (notes + revision counter) and the appended
``note_revisions`` row commit or roll back together.  It never touches the
scene counter, the shot number or ``client_op_id``.

* ``BEGIN IMMEDIATE`` acquires the database write lock up front, so at most one
  writer transaction runs at any moment.  Concurrent requests are serialized
  and assigned numbers follow the transaction commit order.
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

from .merge import MergeResult, three_way_merge

SCHEMA = """
CREATE TABLE IF NOT EXISTS scene_counters (
    scene_id   TEXT PRIMARY KEY,
    last_value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
    client_op_id      TEXT PRIMARY KEY,
    scene_id          TEXT NOT NULL,
    -- Immutable issuance-time note: the idempotency request fingerprint.
    notes_fingerprint TEXT NOT NULL,
    -- Current (revisable) note and its monotonically increasing revision.
    notes             TEXT NOT NULL,
    notes_revision    INTEGER NOT NULL DEFAULT 0,
    shot_number       INTEGER NOT NULL,
    created_at        TEXT NOT NULL,
    notes_updated_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_operations_scene
    ON operations (scene_id, shot_number);

CREATE TABLE IF NOT EXISTS note_revisions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    client_op_id   TEXT NOT NULL REFERENCES operations(client_op_id),
    revision       INTEGER NOT NULL,
    notes          TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    UNIQUE (client_op_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_note_revisions_op
    ON note_revisions (client_op_id, revision);
"""

# Outcome statuses returned by Storage.issue
ISSUED = "issued"        # a brand-new number was allocated and committed
REPLAYED = "replayed"    # same client_op_id + same content: original number returned
CONFLICT = "conflict"    # same client_op_id but different content

# Outcome statuses returned by Storage.update_notes
UPDATED = "updated"      # one new revision was committed
STALE_MERGED = "merged"  # base revision was behind; disjoint edits merged, one new revision
NOTES_CONFLICT = "notes_conflict"  # overlapping edits: three-way fragments returned
NOT_FOUND = "not_found"


@dataclass(frozen=True)
class Operation:
    client_op_id: str
    scene_id: str
    notes: str
    shot_number: int
    created_at: str
    notes_revision: int = 0
    notes_fingerprint: str = ""
    notes_updated_at: Optional[str] = None

    def as_dict(self) -> dict:
        return {
            "client_op_id": self.client_op_id,
            "scene_id": self.scene_id,
            "notes": self.notes,
            "shot_number": self.shot_number,
            "created_at": self.created_at,
            "notes_revision": self.notes_revision,
        }


@dataclass(frozen=True)
class NoteRevision:
    revision: int
    notes: str
    created_at: str

    def as_dict(self) -> dict:
        return {
            "revision": self.revision,
            "notes": self.notes,
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class IssueOutcome:
    status: str  # ISSUED | REPLAYED | CONFLICT
    operation: Optional[Operation] = None  # the stored operation (new or existing)


@dataclass(frozen=True)
class UpdateNotesOutcome:
    status: str  # UPDATED | STALE_MERGED | NOTES_CONFLICT | NOT_FOUND
    operation: Optional[Operation] = None
    merge: Optional[MergeResult] = None


_OPERATION_COLUMNS = (
    "client_op_id, scene_id, notes_fingerprint, notes, notes_revision,"
    " shot_number, created_at, notes_updated_at"
)


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
            self._migrate_legacy_database()

    @staticmethod
    def _row_to_operation(row: sqlite3.Row) -> Operation:
        return Operation(
            client_op_id=row["client_op_id"],
            scene_id=row["scene_id"],
            notes=row["notes"],
            shot_number=row["shot_number"],
            created_at=row["created_at"],
            notes_revision=row["notes_revision"],
            notes_fingerprint=row["notes_fingerprint"],
            notes_updated_at=row["notes_updated_at"],
        )

    def _migrate_legacy_database(self) -> None:
        """Upgrade a pre-revision database in place (idempotent).

        Old databases only had ``operations.notes`` and no revision tables.
        The migration preserves the issuance note *verbatim* as the immutable
        fingerprint and seeds revision 0 of the history with it, so:

        * retries carrying the original notes still replay the same number;
        * old deployments start on the new code with no manual intervention.
        """
        columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(operations)").fetchall()
        }
        if "notes_fingerprint" in columns:
            return  # already migrated

        self._conn.execute("BEGIN IMMEDIATE")
        try:
            self._conn.execute(
                "ALTER TABLE operations ADD COLUMN notes_fingerprint TEXT NOT NULL DEFAULT ''"
            )
            self._conn.execute(
                "ALTER TABLE operations ADD COLUMN notes_revision INTEGER NOT NULL DEFAULT 0"
            )
            self._conn.execute("ALTER TABLE operations ADD COLUMN notes_updated_at TEXT")
            # The existing notes column *is* the immutable issuance payload.
            self._conn.execute(
                "UPDATE operations SET notes_fingerprint = notes"
                " WHERE notes_fingerprint = ''"
            )
            # Seed history: every legacy note becomes revision 0, timestamped
            # with the original issuance time.
            self._conn.execute(
                "INSERT INTO note_revisions (client_op_id, revision, notes, created_at)"
                " SELECT client_op_id, 0, notes, created_at FROM operations"
            )
            self._conn.execute("COMMIT")
        except Exception:
            self._conn.execute("ROLLBACK")
            raise

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
                    f"SELECT {_OPERATION_COLUMNS} FROM operations"
                    " WHERE client_op_id = ?",
                    (client_op_id,),
                ).fetchone()

                if row is not None:
                    existing = self._row_to_operation(row)
                    # Idempotency compares against the immutable issuance
                    # fingerprint, never against the current (revised) note.
                    if (
                        existing.scene_id == scene_id
                        and existing.notes_fingerprint == notes
                    ):
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
                    " (client_op_id, scene_id, notes_fingerprint, notes,"
                    "  notes_revision, shot_number, created_at, notes_updated_at)"
                    " VALUES (?, ?, ?, ?, 0, ?, ?, NULL)",
                    (client_op_id, scene_id, notes, notes, last_value, created_at),
                )
                # The issuance note is revision 0 of the revisable history.
                cur.execute(
                    "INSERT INTO note_revisions (client_op_id, revision, notes, created_at)"
                    " VALUES (?, 0, ?, ?)",
                    (client_op_id, notes, created_at),
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
                        notes_revision=0,
                        notes_fingerprint=notes,
                        notes_updated_at=None,
                    ),
                )
            except sqlite3.IntegrityError:
                # Defensive path for multi-process deployments: another writer
                # committed the same client_op_id between our check and insert.
                cur.execute("ROLLBACK")
                row = self._conn.execute(
                    f"SELECT {_OPERATION_COLUMNS} FROM operations"
                    " WHERE client_op_id = ?",
                    (client_op_id,),
                ).fetchone()
                existing = self._row_to_operation(row)
                if existing.scene_id == scene_id and existing.notes_fingerprint == notes:
                    return IssueOutcome(REPLAYED, existing)
                return IssueOutcome(CONFLICT, existing)
            except Exception:
                cur.execute("ROLLBACK")
                raise

    def update_notes(
        self, *, client_op_id: str, base_revision: int, notes: str
    ) -> UpdateNotesOutcome:
        """Revise a shot's note with optimistic concurrency.

        One transaction either commits exactly one new revision (alongside the
        updated ``operations`` row) or leaves the database untouched.

        * ``base_revision == current``: the new note becomes current+1.
        * ``base_revision < current``: a deterministic three-way merge runs
          between the base note, the caller's edit and the current note.
          Disjoint edits auto-merge into one new revision; overlapping edits
          return NOTES_CONFLICT with the three fragments and nothing changes.
        * ``base_revision > current`` or negative: NOTES_CONFLICT-style reject
          (the caller is against a history this server never saw).
        """
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                row = cur.execute(
                    f"SELECT {_OPERATION_COLUMNS} FROM operations"
                    " WHERE client_op_id = ?",
                    (client_op_id,),
                ).fetchone()
                if row is None:
                    cur.execute("ROLLBACK")
                    return UpdateNotesOutcome(NOT_FOUND)

                current = self._row_to_operation(row)

                if base_revision < 0 or base_revision > current.notes_revision:
                    cur.execute("ROLLBACK")
                    return UpdateNotesOutcome(NOTES_CONFLICT, current)

                if base_revision == current.notes_revision:
                    new_text = notes
                    merged = None
                    if notes == current.notes:
                        # No actual change: report success without a new row.
                        cur.execute("COMMIT")
                        return UpdateNotesOutcome(UPDATED, current)
                else:
                    base_row = cur.execute(
                        "SELECT notes FROM note_revisions"
                        " WHERE client_op_id = ? AND revision = ?",
                        (client_op_id, base_revision),
                    ).fetchone()
                    base_text = base_row["notes"]
                    theirs_text = current.notes
                    merged = three_way_merge(base_text, notes, theirs_text)
                    if not merged.clean:
                        # Overlapping edits: return fragments and change nothing.
                        cur.execute("ROLLBACK")
                        return UpdateNotesOutcome(NOTES_CONFLICT, current, merged)
                    new_text = merged.merged_text
                    if new_text == current.notes:
                        # The merge collapsed to what is already current.
                        cur.execute("COMMIT")
                        return UpdateNotesOutcome(STALE_MERGED, current)

                next_revision = current.notes_revision + 1
                updated_at = cur.execute(
                    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')"
                ).fetchone()[0]
                cur.execute(
                    "UPDATE operations SET notes = ?, notes_revision = ?,"
                    " notes_updated_at = ? WHERE client_op_id = ?",
                    (new_text, next_revision, updated_at, client_op_id),
                )
                cur.execute(
                    "INSERT INTO note_revisions (client_op_id, revision, notes, created_at)"
                    " VALUES (?, ?, ?, ?)",
                    (client_op_id, next_revision, new_text, updated_at),
                )
                cur.execute("COMMIT")
                updated = Operation(
                    client_op_id=current.client_op_id,
                    scene_id=current.scene_id,
                    notes=new_text,
                    shot_number=current.shot_number,
                    created_at=current.created_at,
                    notes_revision=next_revision,
                    notes_fingerprint=current.notes_fingerprint,
                    notes_updated_at=updated_at,
                )
                status = STALE_MERGED if merged is not None else UPDATED
                return UpdateNotesOutcome(status, updated, merged)
            except Exception:
                cur.execute("ROLLBACK")
                raise

    def list_note_revisions(self, client_op_id: str) -> Optional[list[NoteRevision]]:
        """Full note history of an operation (oldest first), or None if missing."""
        with self._lock:
            exists = self._conn.execute(
                "SELECT 1 FROM operations WHERE client_op_id = ?", (client_op_id,)
            ).fetchone()
            if exists is None:
                return None
            rows = self._conn.execute(
                "SELECT revision, notes, created_at FROM note_revisions"
                " WHERE client_op_id = ? ORDER BY revision",
                (client_op_id,),
            ).fetchall()
        return [
            NoteRevision(revision=r["revision"], notes=r["notes"], created_at=r["created_at"])
            for r in rows
        ]

    def list_operations(self, scene_id: str) -> list[Operation]:
        """All issued operations of a scene, ordered by shot number."""
        with self._lock:
            rows = self._conn.execute(
                f"SELECT {_OPERATION_COLUMNS} FROM operations"
                " WHERE scene_id = ? ORDER BY shot_number",
                (scene_id,),
            ).fetchall()
        return [self._row_to_operation(row) for row in rows]

    def get_operation(self, client_op_id: str) -> Optional[Operation]:
        with self._lock:
            row = self._conn.execute(
                f"SELECT {_OPERATION_COLUMNS} FROM operations"
                " WHERE client_op_id = ?",
                (client_op_id,),
            ).fetchone()
        return self._row_to_operation(row) if row is not None else None

    def close(self) -> None:
        with self._lock:
            self._conn.close()
