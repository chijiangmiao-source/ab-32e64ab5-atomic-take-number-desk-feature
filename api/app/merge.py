"""Deterministic line-based three-way merge (diff3) for note revisions.

Given

* ``base``     — the text the client edited from (a known historical revision),
* ``current``  — the newest server-side text,
* ``incoming`` — the text the client wants to save,

``three_way_merge`` either returns a merged text or reports every overlapping
region as a conflict.  The result depends only on its inputs (a single,
canonical LCS is used), so two servers — or a retry — always reach the same
outcome.

The merge granularity is a whole line: edits touching different lines are
disjoint and merge automatically; edits touching the same region conflict and
are returned as three-way fragments for the human to reconcile.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ConflictFragment:
    """One overlapping region presented as a three-way fragment."""

    base: str
    current: str
    incoming: str


@dataclass(frozen=True)
class MergeResult:
    merged: str
    conflicted: bool
    changed: bool  # True when ``merged`` differs from ``current``
    fragments: tuple[ConflictFragment, ...] = ()


def _split_lines(text: str) -> list[str]:
    # keepends=True keeps line terminators attached, so joining the pieces
    # reproduces the original text byte-for-byte.
    return text.splitlines(keepends=True)


def _lcs_matches(x: list[str], y: list[str]) -> list[int]:
    """Return ``m`` with ``m[i]`` = index in ``y`` paired with ``x[i]`` (-1 if none).

    The pairing traces one specific longest common subsequence; ties are broken
    deterministically (diagonal match preferred, then moving up the DP table).
    """
    n, m = len(x), len(y)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        xi = x[i - 1]
        prev = d[i - 1]
        row = d[i]
        for j in range(1, m + 1):
            if xi == y[j - 1]:
                row[j] = prev[j - 1] + 1
            else:
                row[j] = prev[j] if prev[j] >= row[j - 1] else row[j - 1]

    matches = [-1] * n
    i, j = n, m
    while i > 0 and j > 0:
        if x[i - 1] == y[j - 1] and d[i - 1][j - 1] + 1 == d[i][j]:
            matches[i - 1] = j - 1
            i -= 1
            j -= 1
        elif d[i - 1][j] >= d[i][j - 1]:
            i -= 1
        else:
            j -= 1
    return matches


def _diff3_chunks(
    base: list[str], current: list[str], incoming: list[str]
) -> list[tuple[str, list[str], list[str], list[str]]]:
    """Partition the three texts into (kind, base, current, incoming) chunks.

    A base line paired into *both* LCS pairings is a stable point: it is
    unchanged on every side.  Everything between two stable points is emitted
    as one ``change`` chunk (the region each side may have rewritten).
    """
    match_current = _lcs_matches(base, current)
    match_incoming = _lcs_matches(base, incoming)

    chunks: list[tuple[str, list[str], list[str], list[str]]] = []
    prev_b = prev_c = prev_i = 0
    n = len(base)
    for bi in range(n):
        mc = match_current[bi]
        mi = match_incoming[bi]
        if mc == -1 or mi == -1:
            continue
        # Flush the region between the previous stable point and this one.
        b_chunk = base[prev_b:bi]
        c_chunk = current[prev_c:mc]
        i_chunk = incoming[prev_i:mi]
        if b_chunk or c_chunk or i_chunk:
            chunks.append(("change", b_chunk, c_chunk, i_chunk))
        chunks.append(("stable", base[bi : bi + 1], base[bi : bi + 1], base[bi : bi + 1]))
        prev_b, prev_c, prev_i = bi + 1, mc + 1, mi + 1

    b_chunk = base[prev_b:]
    c_chunk = current[prev_c:]
    i_chunk = incoming[prev_i:]
    if b_chunk or c_chunk or i_chunk:
        chunks.append(("change", b_chunk, c_chunk, i_chunk))
    return chunks


def three_way_merge(*, base: str, current: str, incoming: str) -> MergeResult:
    if incoming == current:
        # Retry of an already-applied edit: nothing to do.
        return MergeResult(merged=current, conflicted=False, changed=False)

    if base == current:
        # Client based its edit on the newest revision: take it verbatim.
        return MergeResult(merged=incoming, conflicted=False, changed=True)

    b_lines = _split_lines(base)
    c_lines = _split_lines(current)
    i_lines = _split_lines(incoming)

    merged: list[str] = []
    fragments: list[ConflictFragment] = []
    for kind, b_chunk, c_chunk, i_chunk in _diff3_chunks(
        b_lines, c_lines, i_lines
    ):
        if kind == "stable":
            merged.extend(b_chunk)
            continue
        if c_chunk == i_chunk:
            # Both sides made the identical change.
            merged.extend(c_chunk)
        elif c_chunk == b_chunk:
            # Only the incoming side changed this region.
            merged.extend(i_chunk)
        elif i_chunk == b_chunk:
            # Only the server side changed this region.
            merged.extend(c_chunk)
        else:
            fragments.append(
                ConflictFragment(
                    base="".join(b_chunk),
                    current="".join(c_chunk),
                    incoming="".join(i_chunk),
                )
            )

    if fragments:
        return MergeResult(
            merged="".join(merged),
            conflicted=True,
            changed="".join(merged) != current,
            fragments=tuple(fragments),
        )

    merged_text = "".join(merged)
    return MergeResult(
        merged=merged_text,
        conflicted=False,
        changed=merged_text != current,
    )
