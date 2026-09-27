# syntax=docker/dockerfile:1
# The measured cross-encoder reranker, containerized as measured: it runs
# evaluation/neural-cross-encoder-endpoint.py with the pinned
# evaluation/neural-reranker-requirements.txt and BAAI/bge-reranker-v2-m3
# (docs/evaluation.md, "交叉编码器重排"). The endpoint returns raw logits,
# which is what the app reads with RAG_CROSS_ENCODER_SCORES=logits and what
# the QA gate (RAG_QA_MIN_RERANK_PROBABILITY) was measured on; a service
# returning probabilities would silently shift that gate. Max length 384 and
# batch size 8 are the endpoint's defaults, which the measured run
# (`npm run rerank:cross-encoder`, no overrides) used; a longer max length
# changes the scores of passages longer than 384 tokens.
#
# Build context is server/evaluation (Dockerfile.dockerignore keeps it to the
# two files below). Used by the root docker-compose.yml "rerank" profile and
# by ./compose.yaml (`npm run rerank:cross-encoder:docker`).
FROM python:3.14-slim

# CPU wheel of the pinned torch version. The default PyPI wheel on x86_64 also
# pulls several GB of CUDA libraries that a CPU container never uses.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu

ENV HF_HOME=/models/huggingface \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1 \
    USE_TF=0 \
    USE_FLAX=0 \
    TRANSFORMERS_NO_TF=1 \
    TRANSFORMERS_NO_FLAX=1 \
    RAG_CROSS_ENCODER_MODEL=BAAI/bge-reranker-v2-m3 \
    RAG_CROSS_ENCODER_MAX_LENGTH=384 \
    RAG_CROSS_ENCODER_BATCH_SIZE=8 \
    RAG_CROSS_ENCODER_DEVICE=cpu \
    RAG_CROSS_ENCODER_HOST=0.0.0.0 \
    RAG_CROSS_ENCODER_PORT=8081

WORKDIR /app
COPY neural-reranker-requirements.txt ./
RUN python -m pip install --no-cache-dir --index-url "${TORCH_INDEX_URL}" \
      "$(grep -E '^torch==' neural-reranker-requirements.txt)" \
  && python -m pip install --no-cache-dir -r neural-reranker-requirements.txt
COPY neural-cross-encoder-endpoint.py ./

EXPOSE 8081
# The first start downloads the model (about 2.3 GB) into HF_HOME before the
# endpoint listens, hence the long start period.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30m --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('RAG_CROSS_ENCODER_PORT', '8081'), timeout=4)"
CMD ["python", "neural-cross-encoder-endpoint.py"]
