from __future__ import annotations

import os
from typing import List, Optional

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import CrossEncoder


DEFAULT_MODEL = "cross-encoder/ms-marco-TinyBERT-L-2-v2"


class RerankRequest(BaseModel):
    query: str = Field(default="")
    texts: List[str] = Field(default_factory=list)
    model: Optional[str] = None


class CrossEncoderService:
    def __init__(self) -> None:
        self.model_name = os.environ.get("RAG_CROSS_ENCODER_MODEL") or DEFAULT_MODEL
        self.max_length = int(os.environ.get("RAG_CROSS_ENCODER_MAX_LENGTH", "384"))
        self.batch_size = int(os.environ.get("RAG_CROSS_ENCODER_BATCH_SIZE", "8"))
        self.device = (
            "cuda"
            if torch.cuda.is_available()
            else "mps"
            if torch.backends.mps.is_available()
            else "cpu"
        )
        self.model = CrossEncoder(
            self.model_name,
            max_length=self.max_length,
            device=self.device,
        )

    def score(self, query: str, texts: List[str]) -> List[float]:
        if not query.strip():
            raise ValueError("query is required")

        if len(texts) == 0:
            return []

        scores = self.model.predict(
            [(query, text) for text in texts],
            batch_size=self.batch_size,
            convert_to_numpy=True,
            show_progress_bar=False,
        )

        return [float(score) for score in scores.tolist()]


service = CrossEncoderService()
app = FastAPI(title="RAG Cross Encoder Reranker")


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "provider": "sentence-transformers-cross-encoder",
        "model": service.model_name,
        "device": service.device,
        "maxLength": service.max_length,
        "batchSize": service.batch_size,
    }


@app.post("/rerank")
def rerank(request: RerankRequest) -> dict:
    if request.model and request.model != service.model_name:
        raise HTTPException(
            status_code=400,
            detail=(
                f"This endpoint is running {service.model_name}; "
                f"restart with RAG_CROSS_ENCODER_MODEL={request.model} to use that model."
            ),
        )

    try:
        return {
            "model": service.model_name,
            "scores": service.score(request.query, request.texts),
        }
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
