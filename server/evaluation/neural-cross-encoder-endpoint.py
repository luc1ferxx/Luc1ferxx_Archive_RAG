#!/usr/bin/env python3

from __future__ import annotations

import os
from typing import List, Optional

os.environ.setdefault("TRANSFORMERS_NO_TF", "1")
os.environ.setdefault("TRANSFORMERS_NO_FLAX", "1")
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("USE_FLAX", "0")

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from transformers import AutoModelForSequenceClassification, AutoTokenizer


DEFAULT_MODEL = "cross-encoder/ms-marco-TinyBERT-L-2-v2"


class RerankRequest(BaseModel):
    query: str = Field(default="")
    texts: List[str] = Field(default_factory=list)
    model: Optional[str] = None


class NeuralCrossEncoder:
    def __init__(self) -> None:
        self.model_name = os.environ.get("RAG_CROSS_ENCODER_MODEL") or DEFAULT_MODEL
        self.max_length = int(os.environ.get("RAG_CROSS_ENCODER_MAX_LENGTH", "384"))
        self.batch_size = int(os.environ.get("RAG_CROSS_ENCODER_BATCH_SIZE", "8"))
        self.device = self._resolve_device()
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)
        self.model = AutoModelForSequenceClassification.from_pretrained(self.model_name)
        self.model.to(self.device)
        self.model.eval()

    @staticmethod
    def _resolve_device() -> torch.device:
        requested = os.environ.get("RAG_CROSS_ENCODER_DEVICE", "cpu").strip().lower()

        if requested == "auto":
            if torch.cuda.is_available():
                return torch.device("cuda")
            if torch.backends.mps.is_available():
                return torch.device("mps")
            return torch.device("cpu")

        return torch.device(requested)

    def score(self, query: str, texts: List[str]) -> List[float]:
        if not query.strip():
            raise ValueError("query is required")

        if not texts:
            return []

        scores: List[float] = []

        with torch.inference_mode():
            for start in range(0, len(texts), self.batch_size):
                batch_texts = texts[start : start + self.batch_size]
                encoded = self.tokenizer(
                    [query] * len(batch_texts),
                    batch_texts,
                    padding=True,
                    truncation=True,
                    max_length=self.max_length,
                    return_tensors="pt",
                )
                encoded = {key: value.to(self.device) for key, value in encoded.items()}
                logits = self.model(**encoded).logits.squeeze(-1).detach().cpu().tolist()

                if isinstance(logits, float):
                    scores.append(logits)
                else:
                    scores.extend(float(value) for value in logits)

        return scores


encoder = NeuralCrossEncoder()
app = FastAPI(title="RAG Neural Cross Encoder Reranker")


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "provider": "neural-cross-encoder",
        "model": encoder.model_name,
        "device": str(encoder.device),
        "maxLength": encoder.max_length,
        "batchSize": encoder.batch_size,
    }


@app.post("/rerank")
def rerank(request: RerankRequest) -> dict:
    if request.model and request.model != encoder.model_name:
        raise HTTPException(
            status_code=400,
            detail=(
                f"This endpoint is running {encoder.model_name}; "
                f"restart with RAG_CROSS_ENCODER_MODEL={request.model} to use that model."
            ),
        )

    try:
        return {
            "model": encoder.model_name,
            "scores": encoder.score(request.query, request.texts),
        }
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def main() -> None:
    host = os.environ.get("RAG_CROSS_ENCODER_HOST", "127.0.0.1")
    port = int(os.environ.get("RAG_CROSS_ENCODER_PORT", "8081"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
