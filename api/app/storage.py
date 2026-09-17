"""Persistent storage for shot-number issuance and note revisions.

The database is the single source of truth for:

* ``scene_counters``  — the last issued shot number per scene
* ``operations``      — the client_op_id -> shot_number mapping (idempotency log)
* ``note_revisions``  — every version of the mutable notes, oldest first

Two note columns live on ``operations``:

* ``issue_notes``    — the notes carried by the *issuance* request.  They are
  written once and never change; together with ``scene_id`` they are the
  idempotency fingerprint.  A retried issuance request with the same
  ``client_op_id`` and the same original notes therefore always replays the
  same number, no matter how the editable notes were revised afterwards.
* ``notes`` / ``notes_revision`` — the current, script-clerk-editable text and
  its monotonically increasing revision number (1 = the issuance text).

Transaction boundaries
----------------------
``issue`` performs exactly one database transaction::

    BEGIN IMMEDIATE
      SELECT operations WHERE client_op_id = ?      -- replay / conflict check
      INSERT INTO scene_counters ... ON CONFLICT    -- atomic counter increment
      INSERT INTO operations ...                    -- durable mapping
      INSERT INTO note_revisions ... (revision 1)
    COMMIT

``update_notes`` likewise performs exactly one transaction: it may insert one
new ``note_revisions`` row and update ``operations.notes`` together, or it may
roll everything back (overlapping edits -> 409).  It never touches a scene, a
shot number, a counter or a ``client_op_id``.

``BEGIN IMMEDIATE`` acquires the database write lock up front, so at most one
writer runs at any moment.  SQLite runs in WAL mode with
``synchronous=FULL`` so a committed transaction survives an OS/process crash
before any response is sent.

Databases created by the pre-revision version of the service are migrated
automatically on startup (see ``_migrate_legacy_schema``); no manual step is
required.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from dataclasses import dataclass, field
from typing import Optional

from .merge import ConflictFragment, MergeResult, three_way_merge

SCHEMA = """
CREATE TABLE IF NOT EXISTS scene_counters (
    scene_id   TEXT PRIMARY KEY,
    last_value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
    client_op_id   TEXT PRIMARY KEY,
    scene_id       TEXT NOT NULL,
    shot_number    INTEGER NOT NULL,
    created_at     TEXT NOT NULL,
    issue_notes    TEXT NOT NULL,
    notes          TEXT NOT NULL,
    notes_revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_operations_scene
    ON operations (scene_id, shot_number);

CREATE TABLE IF NOT EXISTS note_revisions (
    client_op_id TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    notes        TEXT NOT NULL,
    revised_at   TEXT NOT NULL,
    PRIMARY KEY (client_op_id, revision),
    FOREIGN KEY (client_op_id) REFERENCES operations(client_op_id)
);
"""

# Outcome statuses returned by Storage.issue
ISSUED = "issued"        # a brand-new number was allocated and committed
REPLAYED = "replayed"    # same client_op_id + same fingerprint: original number
CONFLICT = "conflict"    # same client_op_id but different scene/issuance notes

# Outcome statuses returned by Storage.update_notes
UPDATED = "updated"            # base was current: saved as one new revision
MERGED = "merged"              # stale base, disjoint edits: auto-merged revision
UNCHANGED = "unchanged"        # submitted text already equals the server text
NOTES_CONFLICT = "notes_conflict"  # stale base, overlapping edits: rolled back
OP_NOT_FOUND = "not_found"
BASE_INVALID = "base_invalid"      # base revision does not exist (too new/old)


@dataclass(frozen=True)
class Operation:
    client_op_id: str
    scene_id: str
    notes: str
    shot_number: int
    created_at: str
    notes_revision: int = 1
    issue_notes: str = ""

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
class IssueOutcome:
    status: str  # ISSUED | REPLAYED | CONFLICT
    operation: Optional[Operation] = None


@dataclass(frozen=True)
class NoteRevision:
    client_op_id: str
    revision: int
    notes: str
    revised_at: str

    def as_dict(self) -> dict:
        return {
            "revision": self.revision,
            "notes": self.notes,
            "revised_at": self.revised_at,
        }


@dataclass(frozen=True)
class UpdateNotesOutcome:
    status: str  # UPDATED | MERGED | UNCHANGED | NOTES_CONFLICT | OP_NOT_FOUND | BASE_INVALID
    operation: Optional[Operation] = None
    merge: Optional[MergeResult] = None
    fragments: tuple[ConflictFragment, ...] = field(default_factory=tuple)
    base_notes: Optional[str] = None


_OPERATION_COLUMNS = (
    "client_op_id, scene_id, notes, shot_number, created_at,"
    " notes_revision, issue_notes"
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
            self._migrate_legacy_schema()

    # ------------------------------------------------------------------
    # Migration
    # ------------------------------------------------------------------

    def _columns(self, table: str) -> set[str]:
        return {row["name"] for row in self._conn.execute(f"PRAGMA table_info({table})")}

    def _migrate_legacy_schema(self) -> None:
        """Upgrade a database written by the pre-revision release.

        The old ``operations`` table had a single ``notes`` column holding the
        issuance note.  That text is exactly the immutable request fingerprint,
        so it seeds ``issue_notes``; the editable notes start at revision 1 and
        the first history row is a copy of it.  Counters, shot numbers, scene
        ids and client_op_ids are never rewritten.
        """
        columns = self._columns("operations")
        if "issue_notes" not in columns:
            # Added nullable first so the back-fill UPDATE can run; every row is
            # populated below and new inserts always provide a value.
            self._conn.execute("ALTER TABLE operations ADD COLUMN issue_notes TEXT")
        # Runs on a legacy import and also self-heals a partially migrated file
        # (the column exists but some pre-revision row never got back-filled).
        self._conn.execute(
            "UPDATE operations SET issue_notes = notes WHERE issue_notes IS NULL"
        )
        if "notes_revision" not in columns:
            self._conn.execute(
                "ALTER TABLE operations ADD COLUMN notes_revision INTEGER NOT NULL DEFAULT 1"
            )
            self._conn.execute("UPDATE operations SET notes_revision = 1")

        # Back-fill revision history only for operations that do not have one
        # yet (empty on a legacy database; also self-heals any partial state).
        self._conn.execute(
            "INSERT INTO note_revisions (client_op_id, revision, notes, revised_at)"
            " SELECT o.client_op_id, 1, o.notes, o.created_at"
            " FROM operations o"
            " WHERE NOT EXISTS ("
            "  SELECT 1 FROM note_revisions nr"
            "  WHERE nr.client_op_id = o.client_op_id AND nr.revision = 1"
            " )"
        )

    @staticmethod
    def _row_to_operation(row: sqlite3.Row) -> Operation:
        issue_notes = row["issue_notes"] if row["issue_notes"] is not None else row["notes"]
        return Operation(
            client_op_id=row["client_op_id"],
            scene_id=row["scene_id"],
            notes=row["notes"],
            shot_number=row["shot_number"],
            created_at=row["created_at"],
            notes_revision=row["notes_revision"],
            issue_notes=issue_notes,
        )

    def _fetch_operation(self, cur: sqlite3.Cursor, client_op_id: str):
        return cur.execute(
            f"SELECT {_OPERATION_COLUMNS} FROM operations WHERE client_op_id = ?",
            (client_op_id,),
        ).fetchone()

    # ------------------------------------------------------------------
    # Issuance
    # ------------------------------------------------------------------

    def issue(self, *, scene_id: str, client_op_id: str, notes: str) -> IssueOutcome:
        """Allocate the next shot number for ``scene_id`` or replay an existing one.

        Everything below happens inside ONE transaction; the shot number becomes
        visible to any other connection only after COMMIT.  The idempotency
        comparison uses the immutable issuance notes, so later note revisions
        never turn a legitimate retry into a 409.
        """
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                row = self._fetch_operation(cur, client_op_id)

                if row is not None:
                    existing = self._row_to_operation(row)
                    if existing.scene_id == scene_id and existing.issue_notes == notes:
                        # Idempotent replay: no counter movement, return the
                        # originally committed number.  The (possibly revised)
                        # editable notes are returned untouched.
                        cur.execute("COMMIT")
                        return IssueOutcome(REPLAYED, existing)
                    # Same identifier, different fingerprint: reject without
                    # touching the counter or any note history.
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
                    " (client_op_id, scene_id, shot_number, created_at,"
                    "  issue_notes, notes, notes_revision)"
                    " VALUES (?, ?, ?, ?, ?, ?, 1)",
                    (client_op_id, scene_id, last_value, created_at, notes, notes),
                )
                # Revision history begins at issuance (revision 1): it is the
                # immutable base every later edit diffs against.
                cur.execute(
                    "INSERT INTO note_revisions"
                    " (client_op_id, revision, notes, revised_at)"
                    " VALUES (?, 1, ?, ?)",
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
                        notes_revision=1,
                        issue_notes=notes,
                    ),
                )
            except sqlite3.IntegrityError:
                # Defensive path for multi-process deployments: another writer
                # committed the same client_op_id between our check and insert.
                cur.execute("ROLLBACK")
                row = self._fetch_operation(self._conn.cursor(), client_op_id)
                existing = self._row_to_operation(row)
                if existing.scene_id == scene_id and existing.issue_notes == notes:
                    return IssueOutcome(REPLAYED, existing)
                return IssueOutcome(CONFLICT, existing)
            except Exception:
                cur.execute("ROLLBACK")
                raise

    # ------------------------------------------------------------------
    # Note revisions
    # ------------------------------------------------------------------

    def update_notes(
        self,
        *,
        client_op_id: str,
        base_revision: int,
        new_notes: str,
    ) -> UpdateNotesOutcome:
        """Save a clerk's edit, auto-merging disjoint concurrent edits.

        One transaction, at most one new revision.

        * ``base_revision`` equals the server revision -> the edit is saved
          directly as the next revision.
        * ``base_revision`` is older and the edits are on different lines -> a
          deterministic three-way merge produces exactly one new revision.
        * the edits overlap -> the transaction rolls back and three-way
          fragments are returned; the database stays byte-for-byte unchanged.
        * the submitted text already equals the server text -> no new revision.

        Scene ids, shot numbers, counters and client_op_ids are never touched.
        """
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                row = self._fetch_operation(cur, client_op_id)
                if row is None:
                    cur.execute("ROLLBACK")
                    return UpdateNotesOutcome(OP_NOT_FOUND)

                operation = self._row_to_operation(row)
                current_revision = operation.notes_revision
                current_notes = operation.notes

                if new_notes == current_notes:
                    # Idempotent save: the desired text is already the truth.
                    cur.execute("COMMIT")
                    return UpdateNotesOutcome(UNCHANGED, operation)

                base_row = cur.execute(
                    "SELECT notes FROM note_revisions"
                    " WHERE client_op_id = ? AND revision = ?",
                    (client_op_id, base_revision),
                ).fetchone()
                if base_row is None or base_revision > current_revision:
                    cur.execute("ROLLBACK")
                    return UpdateNotesOutcome(
                        BASE_INVALID, operation, base_notes=None
                    )
                base_notes = base_row["notes"]

                if base_revision == current_revision:
                    merged_text, merge_result = new_notes, None
                    status = UPDATED
                else:
                    merge_result = three_way_merge(
                        base=base_notes,
                        current=current_notes,
                        incoming=new_notes,
                    )
                    if merge_result.conflicted:
                        cur.execute("ROLLBACK")
                        return UpdateNotesOutcome(
                            NOTES_CONFLICT,
                            operation,
                            merge=merge_result,
                            fragments=merge_result.fragments,
                            base_notes=base_notes,
                        )
                    if not merge_result.changed:
                        # Both sides converged on the same text: nothing new.
                        cur.execute("COMMIT")
                        return UpdateNotesOutcome(UNCHANGED, operation)
                    merged_text = merge_result.merged
                    status = MERGED

                next_revision = current_revision + 1
                revised_at = cur.execute(
                    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')"
                ).fetchone()[0]
                cur.execute(
                    "INSERT INTO note_revisions"
                    " (client_op_id, revision, notes, revised_at)"
                    " VALUES (?, ?, ?, ?)",
                    (client_op_id, next_revision, merged_text, revised_at),
                )
                cur.execute(
                    "UPDATE operations SET notes = ?, notes_revision = ?"
                    " WHERE client_op_id = ? AND notes_revision = ?",
                    (
                        merged_text,
                        next_revision,
                        client_op_id,
                        current_revision,
                    ),
                )
                # The conditional UPDATE above is a belt-and-braces optimistic
                # guard: within BEGIN IMMEDIATE nothing else can have moved the
                # revision, so exactly one row must change.
                if cur.rowcount != 1:
                    raise sqlite3.IntegrityError("notes revision moved mid-transaction")
                cur.execute("COMMIT")
                updated = Operation(
                    client_op_id=operation.client_op_id,
                    scene_id=operation.scene_id,
                    notes=merged_text,
                    shot_number=operation.shot_number,
                    created_at=operation.created_at,
                    notes_revision=next_revision,
                    issue_notes=operation.issue_notes,
                )
                return UpdateNotesOutcome(status, updated, merge=merge_result)
            except Exception:
                cur.execute("ROLLBACK")
                raise

    def list_note_revisions(self, client_op_id: str) -> Optional[list[NoteRevision]]:
        """Full note history of one operation (revision 1 = issuance) or None."""
        with self._lock:
            exists = self._conn.execute(
                "SELECT 1 FROM operations WHERE client_op_id = ?",
                (client_op_id,),
            ).fetchone()
            if exists is None:
                return None
            rows = self._conn.execute(
                "SELECT client_op_id, revision, notes, revised_at"
                " FROM note_revisions WHERE client_op_id = ? ORDER BY revision",
                (client_op_id,),
            ).fetchall()
        return [
            NoteRevision(
                client_op_id=r["client_op_id"],
                revision=r["revision"],
                notes=r["notes"],
                revised_at=r["revised_at"],
            )
            for r in rows
        ]

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

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
            row = self._fetch_operation(self._conn.cursor(), client_op_id)
        return self._row_to_operation(row) if row is not None else None

    def close(self) -> None:
        with self._lock:
            self._conn.close()
