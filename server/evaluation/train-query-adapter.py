#!/usr/bin/env python3
"""Train the query-side linear embedding adapter read by rag/query-adapter.js.

A d x d matrix W, initialised to the identity, maps a query embedding q to
W q before the dense search; document vectors are untouched, so nothing is
reindexed. The loss is InfoNCE over cosine similarity: for each question, the
chunks on its annotated evidence paragraphs are the positives; every other
chunk of the same paper is a hard negative (the single-document QA route only
ever ranks one paper's chunks), and the positives of the other questions in
the batch are in-batch negatives. lambda * ||W - I||_F^2 pulls W back toward
the identity.

Model selection happens on train only: whole papers (--held-out, default 20%)
are held out, every (lambda, tau, learning rate) in the grid is trained with early stopping on
the held-out papers' within-paper dense hit@6 (ties: MRR), and the best run is
written. Dev is never read here; evaluation/run-query-adapter-eval.mjs
confirms on it.

Input: the files evaluation/query-adapter-data.mjs writes.
Usage (torch from the reranker venv, CPU, deterministic):
  evaluation/.venv-neural-reranker/bin/python evaluation/train-query-adapter.py \
    [--data evaluation/generated/query-adapter/qasper-train] \
    [--out evaluation/generated/query-adapter/qasper-nomic-adapter.json]
"""

import argparse
import base64
import json
import os
import random
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

FORMAT = "archive-rag.query-adapter/v1"
DATA_FORMAT = "archive-rag.query-adapter-data/v1"


def load_data(prefix):
    with open(prefix + ".meta.json", encoding="utf8") as handle:
        meta = json.load(handle)
    if meta.get("format") != DATA_FORMAT:
        sys.exit(f"{prefix}.meta.json: expected format {DATA_FORMAT}")
    dimensions = int(meta["embedding"]["dimensions"])
    directory = os.path.dirname(prefix)
    chunks = np.fromfile(os.path.join(directory, meta["files"]["chunks"]), dtype="<f4").reshape(-1, dimensions)
    questions = np.fromfile(os.path.join(directory, meta["files"]["questions"]), dtype="<f4").reshape(-1, dimensions)
    if chunks.shape[0] != len(meta["chunkPaper"]) or questions.shape[0] != len(meta["questions"]):
        sys.exit("Embedding files do not match the metadata row counts.")
    return meta, torch.from_numpy(chunks.copy()), torch.from_numpy(questions.copy())


class Data:
    def __init__(self, meta, chunks, questions, question_ids):
        self.chunks = F.normalize(chunks, dim=1)
        self.questions = F.normalize(questions, dim=1)
        self.chunk_paper = torch.tensor(meta["chunkPaper"], dtype=torch.long)
        paper_count = len(meta["papers"])
        self.paper_chunks = [[] for _ in range(paper_count)]
        for index, paper in enumerate(meta["chunkPaper"]):
            self.paper_chunks[paper].append(index)
        self.paper_chunks = [torch.tensor(items, dtype=torch.long) for items in self.paper_chunks]
        self.q_paper = [meta["questions"][i]["paper"] for i in question_ids]
        self.q_pos = [meta["questions"][i]["positives"] for i in question_ids]
        self.q_vec = self.questions[question_ids]


def adapt(queries, delta):
    return F.normalize(queries @ (torch.eye(delta.shape[0]) + delta).T, dim=1)


def batch_loss(data, batch, delta, tau):
    papers = sorted({data.q_paper[i] for i in batch})
    columns = torch.cat([data.paper_chunks[p] for p in papers])
    column_of = {int(chunk): position for position, chunk in enumerate(columns.tolist())}
    column_paper = data.chunk_paper[columns]
    q_paper = torch.tensor([data.q_paper[i] for i in batch])
    positive = torch.zeros(len(batch), len(columns), dtype=torch.bool)
    for row, i in enumerate(batch):
        positive[row, [column_of[c] for c in data.q_pos[i]]] = True
    own = column_paper[None, :] == q_paper[:, None]
    any_positive = positive.any(dim=0)
    # Same-paper chunks are the hard negatives; another paper's chunk counts
    # only when it is another batch question's positive (in-batch negative).
    allowed = own | (any_positive[None, :] & ~own)
    scores = adapt(data.q_vec[batch], delta) @ data.chunks[columns].T / tau
    denominator = torch.logsumexp(scores.masked_fill(~allowed, float("-inf")), dim=1)
    numerator = torch.logsumexp(scores.masked_fill(~positive, float("-inf")), dim=1)
    return (denominator - numerator).mean()


@torch.no_grad()
def within_paper_metrics(data, delta, k_values=(1, 3, 6)):
    adapted = adapt(data.q_vec, delta)
    hits = {k: 0 for k in k_values}
    reciprocal = 0.0
    for row in range(len(data.q_paper)):
        candidates = data.paper_chunks[data.q_paper[row]]
        scores = data.chunks[candidates] @ adapted[row]
        order = candidates[torch.argsort(scores, descending=True)].tolist()
        positives = set(data.q_pos[row])
        rank = next(position for position, chunk in enumerate(order) if chunk in positives) + 1
        reciprocal += 1.0 / rank
        for k in k_values:
            hits[k] += rank <= k
    count = max(1, len(data.q_paper))
    return {**{f"hitAt{k}": round(hits[k] / count, 4) for k in k_values}, "mrr": round(reciprocal / count, 4)}


@torch.no_grad()
def within_paper_cosine(data, delta):
    """Mean within-paper cosine and top-1 cosine: how far W moves absolute scores."""
    adapted = adapt(data.q_vec, delta)
    means, tops = [], []
    for row in range(len(data.q_paper)):
        scores = data.chunks[data.paper_chunks[data.q_paper[row]]] @ adapted[row]
        means.append(float(scores.mean()))
        tops.append(float(scores.max()))
    count = max(1, len(means))
    return {"meanCosine": round(sum(means) / count, 4), "topCosine": round(sum(tops) / count, 4)}


def selection_key(metrics):
    return (metrics["hitAt6"], metrics["mrr"])


def train_one(train, held_out, dimensions, lam, tau, lr, args, seed):
    torch.manual_seed(seed)
    rng = random.Random(seed)
    delta = torch.zeros(dimensions, dimensions, requires_grad=True)
    optimizer = torch.optim.Adam([delta], lr=lr)
    order = list(range(len(train.q_paper)))
    best = {"epoch": 0, "metrics": within_paper_metrics(held_out, delta.detach()), "delta": delta.detach().clone()}
    stale = 0
    for epoch in range(1, args.epochs + 1):
        rng.shuffle(order)
        total = 0.0
        for start in range(0, len(order), args.batch_size):
            batch = order[start : start + args.batch_size]
            optimizer.zero_grad()
            loss = batch_loss(train, batch, delta, tau) + lam * (delta * delta).sum()
            loss.backward()
            optimizer.step()
            total += float(loss.detach()) * len(batch)
        metrics = within_paper_metrics(held_out, delta.detach())
        if selection_key(metrics) > selection_key(best["metrics"]):
            best = {"epoch": epoch, "metrics": metrics, "delta": delta.detach().clone()}
            stale = 0
        else:
            stale += 1
        if stale >= args.patience:
            break
    best["epochsRun"] = epoch
    best["deltaNorm"] = round(float(best["delta"].norm()), 4)
    return best


def write_atomically(path, document):
    """A server reloads RAG_EMBEDDING_QUERY_ADAPTER when the file changes, so
    it must never see a half-written one: write a temp file in the same
    directory, then rename it over the target."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    temporary = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.tmp")
    try:
        with open(temporary, "w", encoding="utf8") as handle:
            json.dump(document, handle)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", default=os.path.join(here, "generated", "query-adapter", "qasper-train"))
    parser.add_argument("--out", default=os.path.join(here, "generated", "query-adapter", "qasper-nomic-adapter.json"))
    parser.add_argument("--held-out", type=float, default=0.2, help="fraction of train papers held out for early stopping")
    parser.add_argument("--lambdas", default="0.01,0.1,0.3,1.0")
    parser.add_argument("--taus", default="0.05,0.1")
    parser.add_argument("--lrs", default="5e-5,2e-4", help="Adam learning rates in the grid")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--patience", type=int, default=6)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()

    torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))
    meta, chunks, questions = load_data(args.data)
    dimensions = int(meta["embedding"]["dimensions"])
    papers = list(range(len(meta["papers"])))
    random.Random(args.seed).shuffle(papers)
    held_papers = set(papers[: round(len(papers) * args.held_out)])
    train_ids = [i for i, q in enumerate(meta["questions"]) if q["paper"] not in held_papers]
    held_ids = [i for i, q in enumerate(meta["questions"]) if q["paper"] in held_papers]
    train = Data(meta, chunks, questions, train_ids)
    held_out = Data(meta, chunks, questions, held_ids)
    identity = torch.zeros(dimensions, dimensions)
    baseline = within_paper_metrics(held_out, identity)
    print(
        f"{len(train_ids)} train / {len(held_ids)} held-out questions "
        f"({len(papers) - len(held_papers)} / {len(held_papers)} papers); identity held-out {baseline}",
        flush=True,
    )

    runs = []
    best = None
    grid = [
        (float(lam), float(tau), float(lr))
        for lam in args.lambdas.split(",")
        for tau in args.taus.split(",")
        for lr in args.lrs.split(",")
    ]
    for lam, tau, lr in grid:
        started = time.time()
        result = train_one(train, held_out, dimensions, lam, tau, lr, args, args.seed)
        summary = {
            "bestEpoch": result["epoch"],
            "deltaNorm": result["deltaNorm"],
            "epochsRun": result["epochsRun"],
            "heldOut": result["metrics"],
            "lambda": lam,
            "learningRate": lr,
            "seconds": round(time.time() - started, 1),
            "tau": tau,
        }
        runs.append(summary)
        print(json.dumps(summary), flush=True)
        if best is None or selection_key(result["metrics"]) > selection_key(best[0]["metrics"]):
            best = (result, summary)

    result, summary = best
    weights = (torch.eye(dimensions) + result["delta"]).contiguous().numpy().astype("<f4")
    adapter = {
        "embedding": {
            "dimensions": dimensions,
            "documentPrefix": meta["embedding"]["documentPrefix"],
            "model": meta["embedding"]["model"],
            "queryPrefix": meta["embedding"]["queryPrefix"],
        },
        "format": FORMAT,
        "training": {
            "batchSize": args.batch_size,
            "corpus": meta["corpus"],
            "data": os.path.basename(args.data),
            "dataGeneratedAt": meta["generatedAt"],
            "grid": runs,
            "heldOutFraction": args.held_out,
            "heldOutIdentity": baseline,
            # Absolute cosines move with W even where rankings improve: any
            # threshold on vectorScore (RAG_MIN_RELEVANCE_SCORE, the combined
            # score's max()) was calibrated on the identity scale.
            "heldOutCosine": {
                "adapter": within_paper_cosine(held_out, result["delta"]),
                "identity": within_paper_cosine(held_out, identity),
            },
            "heldOutPapers": len(held_papers),
            "heldOutQuestions": len(held_ids),
            "loss": "InfoNCE (same-paper hard negatives + in-batch positives) + lambda*||W-I||_F^2",
            "selected": summary,
            "selection": "held-out within-paper dense hit@6, ties by MRR",
            "seed": args.seed,
            "torch": torch.__version__,
            "trainPapers": len(papers) - len(held_papers),
            "trainQuestions": len(train_ids),
            "trainer": "evaluation/train-query-adapter.py",
        },
        "weights": {
            "cols": dimensions,
            "data": base64.b64encode(weights.tobytes(order="C")).decode("ascii"),
            "encoding": "float32le-base64",
            "layout": "row-major",
            "rows": dimensions,
        },
    }
    write_atomically(args.out, adapter)
    print(f"selected {json.dumps(summary)}; identity held-out {baseline}; wrote {args.out}", flush=True)


if __name__ == "__main__":
    main()
