"""Deterministic line-based three-way merge for revisable shot notes.

Given a common ``base`` text and two independently edited versions
(``mine`` and ``theirs``), :func:`three_way_merge` produces either a single
merged text or conflict regions that contain all three fragments for the
script supervisor to reconcile manually.

The merge is purely functional and deterministic: given the same three
inputs it always returns the same output, regardless of which terminal
"wins" the database write lock first.

Rules
-----

* A hunk is a maximal run of lines that one side replaced/inserted/deleted
  relative to ``base`` (computed with :class:`difflib.SequenceMatcher`,
  ``autojunk=False`` so results never depend on string length heuristics).
* Hunks that touch disjoint base regions merge automatically.
* Hunks that overlap are a conflict — *unless* both sides produced the
  exact same replacement text (e.g. an identical retry), in which case
  that text is taken.
* Two insertions at the exact same line position conflict (their relative
  order is ambiguous); an insertion right next to a changed region merges.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable


@dataclass(frozen=True)
class ConflictRegion:
    """One overlapping region, with the three texts involved."""

    base: str
    mine: str
    theirs: str


@dataclass(frozen=True)
class MergeResult:
    merged_text: str
    conflicts: tuple[ConflictRegion, ...]

    @property
    def clean(self) -> bool:
        return not self.conflicts


def _split_lines(text: str) -> list[str]:
    """Split text keeping the ``\\n`` attached to every line but the last.

    Unlike ``str.splitlines`` this preserves empty trailing lines and never
    treats other Unicode line separators as line breaks.
    """
    if text == "":
        return []
    parts = text.split("\n")
    return [part + "\n" for part in parts[:-1]] + parts[-1:]


def _change_hunks(base: list[str], side: list[str]) -> list[tuple[int, int, list[str]]]:
    """(base_start, base_end, replacement_lines) for every non-equal hunk."""
    matcher = SequenceMatcher(None, base, side, autojunk=False)
    return [
        (i1, i2, side[j1:j2])
        for tag, i1, i2, j1, j2 in matcher.get_opcodes()
        if tag != "equal"
    ]


def _overlaps(h1: tuple[int, int], h2: tuple[int, int]) -> bool:
    """Whether two base-coordinate spans interact.

    Half-open ranges ``[start, end)``; ``start == end`` is a pure insertion
    at that line position.
    """
    s1, e1 = h1
    s2, e2 = h2
    if s1 == e1 and s2 == e2:
        # Two pure insertions only interact at the exact same position.
        return s1 == s2
    if s1 == e1:
        # An insertion merges when adjacent to a changed range, conflicts
        # only when it sits strictly inside it.
        return s2 < s1 < e2
    if s2 == e2:
        return s1 < s2 < e1
    return s1 < e2 and s2 < e1


# A hunk tagged with the side it came from: 'mine' | 'theirs'.
_TaggedHunk = tuple[str, int, int, list[str]]


def _group_hunks(hunks: list[_TaggedHunk]) -> list[list[_TaggedHunk]]:
    """Group hunks that overlap transitively (fixed point on pair merges)."""
    groups: list[list[_TaggedHunk]] = [[hunk] for hunk in hunks]
    merged_any = True
    while merged_any:
        merged_any = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                if any(
                    _overlaps((hs, he), (gs, ge))
                    for _, hs, he, _ in groups[i]
                    for _, gs, ge, _ in groups[j]
                ):
                    groups[i] = groups[i] + groups[j]
                    del groups[j]
                    merged_any = True
                    break
            if merged_any:
                break
    return groups


def _assemble(
    base: list[str], span: tuple[int, int], side_hunks: Iterable[_TaggedHunk]
) -> list[str]:
    """Reconstruct one side's text for a conflict span, keeping unchanged gaps."""
    start, end = span
    lines: list[str] = []
    pos = start
    for _, hs, he, replacement in sorted(side_hunks, key=lambda h: (h[1], h[2])):
        lines.extend(base[pos:hs])
        lines.extend(replacement)
        pos = he
    lines.extend(base[pos:end])
    return lines


def three_way_merge(base_text: str, mine_text: str, theirs_text: str) -> MergeResult:
    """Merge ``mine_text`` and ``theirs_text`` from ``base_text``."""
    if mine_text == theirs_text:
        # Both sides arrived at exactly the same text (typical for a retried
        # update whose first attempt already committed): nothing to do.
        return MergeResult(mine_text, ())

    base = _split_lines(base_text)
    mine = _split_lines(mine_text)
    theirs = _split_lines(theirs_text)

    hunks: list[_TaggedHunk] = [
        ("mine", s, e, repl) for s, e, repl in _change_hunks(base, mine)
    ]
    hunks.extend(
        ("theirs", s, e, repl) for s, e, repl in _change_hunks(base, theirs)
    )
    if not hunks:
        return MergeResult(base_text, ())

    groups = _group_hunks(hunks)
    blocks: list[tuple[str, list[str]]] = []
    cursor = 0
    for group in sorted(groups, key=lambda g: (min(h[1] for h in g), max(h[2] for h in g))):
        start = min(h[1] for h in group)
        end = max(h[2] for h in group)
        sides = {h[0] for h in group}

        # Unchanged base lines before this group.
        blocks.append(("ok", base[cursor:start]))

        if len(sides) == 1:
            side = next(iter(sides))
            blocks.append(("ok", _assemble(base, (start, end), group)))
        else:
            mine_lines = _assemble(
                base, (start, end), (h for h in group if h[0] == "mine")
            )
            theirs_lines = _assemble(
                base, (start, end), (h for h in group if h[0] == "theirs")
            )
            if mine_lines == theirs_lines:
                # Overlapping edits with identical outcomes: take the text once.
                blocks.append(("ok", mine_lines))
            else:
                blocks.append(
                    (
                        "conflict",
                        base[start:end],
                        mine_lines,
                        theirs_lines,
                    )
                )
        cursor = end

    blocks.append(("ok", base[cursor:]))

    merged_lines: list[str] = []
    conflicts: list[ConflictRegion] = []
    for block in blocks:
        if block[0] == "ok":
            merged_lines.extend(block[1])
        else:
            _, base_lines, mine_lines, theirs_lines = block
            conflicts.append(
                ConflictRegion(
                    base="".join(base_lines),
                    mine="".join(mine_lines),
                    theirs="".join(theirs_lines),
                )
            )
    return MergeResult("".join(merged_lines), tuple(conflicts))
