"""FastAPI application for the shot-number issuance service."""

from __future__ import annotations

import os
from typing import Optional

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

from .storage import (
    CONFLICT,
    ISSUED,
    NOTES_CONFLICT,
    NOT_FOUND,
    REPLAYED,
    NoteRevision,
    Operation,
    Storage,
)


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class IssueRequest(BaseModel):
    scene_id: str = Field(min_length=1, max_length=120)
    client_op_id: str = Field(min_length=1, max_length=120)
    notes: str = Field(default="", max_length=4000)
    inject_failure_after_commit: bool = False

    @field_validator("scene_id", "client_op_id")
    @classmethod
    def _strip_and_require(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped


class OperationModel(BaseModel):
    scene_id: str
    client_op_id: str
    notes: str
    shot_number: int
    created_at: str
    # Monotonically increasing revision of the revisable note; 0 is the
    # immutable issuance note.  Included in every operation payload so the
    # board can render inline editors with optimistic concurrency.
    notes_revision: int = 0

    @classmethod
    def from_operation(cls, op: Operation) -> "OperationModel":
        return cls(**op.as_dict())


class IssueResponseModel(OperationModel):
    # True when the request was an idempotent replay of an already-committed
    # operation (no new number was allocated).
    replayed: bool


class NoteUpdateRequest(BaseModel):
    # Identifies the operation whose note is revised; the shot number itself
    # never changes and no new client_op_id is ever minted.
    client_op_id: str = Field(min_length=1, max_length=120)
    # Revision the client edited against.  When it lags the server the edit is
    # three-way merged against the revision history.
    base_revision: int = Field(ge=0)
    notes: str = Field(default="", max_length=4000)

    @field_validator("client_op_id")
    @classmethod
    def _strip_and_require(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped


class NoteRevisionModel(BaseModel):
    revision: int
    notes: str
    created_at: str

    @classmethod
    def from_revision(cls, rev: NoteRevision) -> "NoteRevisionModel":
        return cls(**rev.as_dict())


class NoteUpdateResponseModel(OperationModel):
    # "updated": the caller was up to date and one revision was created;
    # "merged": the caller lagged, disjoint edits were auto-merged and one
    # revision was created.
    merge_status: str


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------


def create_app(
    db_path: Optional[str] = None,
    allow_failure_injection: Optional[bool] = None,
) -> FastAPI:
    db_path = db_path or os.environ.get("SHOT_DB_PATH", "./data/shotnumbers.db")
    if allow_failure_injection is None:
        allow_failure_injection = _env_flag("ALLOW_FAILURE_INJECTION")

    storage = Storage(db_path)
    app = FastAPI(title="Shot Number Issuer", version="1.0.0")
    app.state.storage = storage
    app.state.allow_failure_injection = allow_failure_injection

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.post("/api/shot-numbers", response_model=IssueResponseModel)
    def issue_shot_number(request: IssueRequest, response: Response) -> IssueResponseModel:
        # The whole allocation happens inside one database transaction
        # (see storage.Storage.issue).  When this call returns ISSUED, the
        # number is already durably committed.
        outcome = storage.issue(
            scene_id=request.scene_id,
            client_op_id=request.client_op_id,
            notes=request.notes,
        )

        if outcome.status == CONFLICT:
            assert outcome.operation is not None
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "client_op_id_conflict",
                    "message": (
                        "client_op_id 已被占用：同一操作标识不允许携带不同内容重复提交"
                    ),
                    "existing": outcome.operation.as_dict(),
                },
            )

        assert outcome.operation is not None
        body = IssueResponseModel(
            **outcome.operation.as_dict(),
            replayed=outcome.status == REPLAYED,
        )

        if outcome.status == ISSUED:
            response.status_code = 201
            # Development-only chaos knob: the operation has ALREADY been
            # durably committed above; we now simulate the server crashing
            # before the response reaches the client.  A retry with the same
            # client_op_id takes the replay branch and therefore can never
            # trigger this failure twice.
            if request.inject_failure_after_commit and app.state.allow_failure_injection:
                raise HTTPException(
                    status_code=503,
                    detail={
                        "error": "injected_failure_after_commit",
                        "message": (
                            "注入故障：镜号已持久提交，但响应前模拟服务崩溃；"
                            "请使用相同 client_op_id 重试以取回该号码"
                        ),
                    },
                )
        else:
            response.status_code = 200

        return body

    @app.get("/api/scenes/{scene_id}/operations", response_model=list[OperationModel])
    def list_scene_operations(scene_id: str) -> list[OperationModel]:
        return [
            OperationModel.from_operation(op)
            for op in storage.list_operations(scene_id)
        ]

    @app.patch(
        "/api/operations/{client_op_id}/notes",
        response_model=NoteUpdateResponseModel,
    )
    def update_operation_notes(
        client_op_id: str, request: NoteUpdateRequest
    ) -> NoteUpdateResponseModel:
        # The path id and body id must agree; the body id is part of the
        # explicit operation protocol ("接口接收操作标识").
        if request.client_op_id != client_op_id:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "client_op_id_mismatch",
                    "message": "路径中的操作标识与请求体不一致",
                },
            )

        outcome = storage.update_notes(
            client_op_id=client_op_id,
            base_revision=request.base_revision,
            notes=request.notes,
        )

        if outcome.status == NOT_FOUND:
            raise HTTPException(
                status_code=404,
                detail={"error": "not_found", "message": "操作标识不存在"},
            )

        assert outcome.operation is not None
        if outcome.status == NOTES_CONFLICT:
            detail: dict = {
                "error": "notes_conflict",
                "message": (
                    "备注与其他终端的修改发生重叠冲突：请对照三方片段整理后再保存，"
                    "数据库未做任何改动"
                ),
                "current": OperationModel.from_operation(outcome.operation).model_dump(),
                "base_revision": request.base_revision,
            }
            if outcome.merge is not None:
                detail["conflicts"] = [
                    {"base": region.base, "mine": region.mine, "theirs": region.theirs}
                    for region in outcome.merge.conflicts
                ]
                # Server's full current note, handy as a reconciliation starting point.
                detail["server_notes"] = outcome.operation.notes
            raise HTTPException(status_code=409, detail=detail)

        return NoteUpdateResponseModel(
            **outcome.operation.as_dict(),
            merge_status=outcome.status,
        )

    @app.get(
        "/api/operations/{client_op_id}/note-revisions",
        response_model=list[NoteRevisionModel],
    )
    def list_note_revisions(client_op_id: str) -> list[NoteRevisionModel]:
        revisions = storage.list_note_revisions(client_op_id)
        if revisions is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "not_found", "message": "操作标识不存在"},
            )
        return [NoteRevisionModel.from_revision(rev) for rev in revisions]

    @app.get("/api/operations/{client_op_id}", response_model=OperationModel)
    def get_operation(client_op_id: str) -> OperationModel:
        operation = storage.get_operation(client_op_id)
        if operation is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "not_found", "message": "操作标识不存在"},
            )
        return OperationModel.from_operation(operation)

    return app


app = create_app()
