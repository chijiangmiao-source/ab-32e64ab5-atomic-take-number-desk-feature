"""FastAPI application for the shot-number issuance service."""

from __future__ import annotations

import os
from typing import Optional

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

from .storage import CONFLICT, ISSUED, REPLAYED, Operation, Storage


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

    @classmethod
    def from_operation(cls, op: Operation) -> "OperationModel":
        return cls(**op.as_dict())


class IssueResponseModel(OperationModel):
    # True when the request was an idempotent replay of an already-committed
    # operation (no new number was allocated).
    replayed: bool


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
