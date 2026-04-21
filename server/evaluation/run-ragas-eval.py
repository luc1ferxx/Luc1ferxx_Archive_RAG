import argparse
import asyncio
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from openai import AsyncOpenAI
from ragas.dataset_schema import SingleTurnSample
from ragas.embeddings.base import embedding_factory
from ragas.llms import llm_factory
from ragas.metrics import IDBasedContextPrecision
from ragas.metrics.collections import (
    AnswerRelevancy,
    ContextPrecision,
    ContextRecall,
    ContextUtilization,
    Faithfulness,
)

RAGAS_METRIC_KEYS = (
    "answer_relevancy",
    "faithfulness",
    "context_utilization",
    "context_precision",
    "context_recall",
)
ALL_METRIC_KEYS = (*RAGAS_METRIC_KEYS, "compare_rubric")
METRIC_LABELS = {
    "answer_relevancy": "Answer relevancy",
    "faithfulness": "Faithfulness",
    "context_utilization": "Context utilization",
    "context_precision": "Context precision",
    "context_recall": "Context recall",
    "compare_rubric": "Compare rubric",
}
ROUTE_ORDER = ("qa", "compare", "abstain")
SOURCE_CITATION_PATTERN = re.compile(r"\[Source\s+\d+\]", re.IGNORECASE)
LIST_PREFIX_PATTERN = re.compile(r"^(?:[-*]\s+|\d+\.\s+)")
WHITESPACE_PATTERN = re.compile(r"\s+")
SECTION_HEADER_PATTERN = re.compile(
    r"^(summary|per document|agreements|differences|gaps or uncertainty)\s*:\s*$",
    re.IGNORECASE,
)
COMPARE_SECTIONS_TO_KEEP = {"summary", "agreements", "differences"}
COMPARE_NOISE_PATTERNS = (
    re.compile(r"^this conclusion is limited to the retrieved passages", re.IGNORECASE),
    re.compile(r"^the provided evidence does not specify", re.IGNORECASE),
    re.compile(r"^the excerpts do not specify", re.IGNORECASE),
    re.compile(r"^no documents lack strong evidence", re.IGNORECASE),
)


def build_parser():
    script_path = Path(__file__).resolve()
    results_dir = script_path.parent / "results"
    parser = argparse.ArgumentParser(
        description="Run Ragas evaluation against the latest Node evaluation payload."
    )
    parser.add_argument(
        "--input",
        default=str(results_dir / "latest.json"),
        help="Path to a Node evaluation JSON file.",
    )
    parser.add_argument(
        "--output-json",
        default=str(results_dir / "latest-ragas.json"),
        help="Path to write the JSON report.",
    )
    parser.add_argument(
        "--output-md",
        default=str(results_dir / "latest-ragas.md"),
        help="Path to write the Markdown report.",
    )
    parser.add_argument(
        "--include-abstain",
        action="store_true",
        help="Include abstain cases in answer-only metrics. By default they are skipped.",
    )
    parser.add_argument(
        "--judge-model",
        default="",
        help="Override the LLM used by Ragas metrics. Defaults to RAGAS_EVAL_MODEL or gpt-4o-mini.",
    )
    parser.add_argument(
        "--embedding-model",
        default="",
        help="Override the embedding model used by AnswerRelevancy.",
    )
    return parser


def load_env_file(env_path: Path):
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        os.environ.setdefault(key, value)


def unwrap_score(result):
    value = getattr(result, "value", result)
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, int):
        return float(value)
    if isinstance(value, float):
        return round(value, 4)
    raise TypeError(f"Unsupported score result type: {type(value)!r}")


async def score_metric(scorer, kwargs):
    if hasattr(scorer, "ascore"):
        return await scorer.ascore(**kwargs)

    if hasattr(scorer, "single_turn_ascore"):
        return await scorer.single_turn_ascore(SingleTurnSample(**kwargs))

    raise TypeError(f"Unsupported scorer interface: {type(scorer)!r}")


def average(values):
    valid_values = [value for value in values if isinstance(value, (int, float))]
    if not valid_values:
        return None
    return round(sum(valid_values) / len(valid_values), 4)


def collapse_whitespace(text):
    return WHITESPACE_PATTERN.sub(" ", str(text or "")).strip()


def dedupe_preserving_order(values):
    seen = set()
    deduped = []

    for value in values:
        normalized = collapse_whitespace(value)
        if not normalized or normalized in seen:
            continue

        seen.add(normalized)
        deduped.append(normalized)

    return deduped


def normalize_context_text(text):
    return collapse_whitespace(text)


def is_compare_noise(line):
    return any(pattern.search(line) for pattern in COMPARE_NOISE_PATTERNS)


def normalize_compare_response(response):
    text = SOURCE_CITATION_PATTERN.sub("", str(response or ""))
    current_section = None
    selected_lines = []
    fallback_lines = []

    for raw_line in text.splitlines():
        line = collapse_whitespace(raw_line)

        if not line:
            continue

        section_match = SECTION_HEADER_PATTERN.match(line)
        if section_match:
            current_section = section_match.group(1).lower()
            continue

        cleaned_line = collapse_whitespace(LIST_PREFIX_PATTERN.sub("", line))
        if not cleaned_line:
            continue

        fallback_lines.append(cleaned_line)

        if current_section in COMPARE_SECTIONS_TO_KEEP and not is_compare_noise(cleaned_line):
            selected_lines.append(cleaned_line)

    chosen_lines = dedupe_preserving_order(selected_lines or fallback_lines)
    return " ".join(chosen_lines)


def normalize_response_for_ragas(response, case_type):
    if case_type == "compare":
        normalized = normalize_compare_response(response)
        if normalized:
            return normalized

    text = SOURCE_CITATION_PATTERN.sub("", str(response or ""))
    lines = [
        collapse_whitespace(LIST_PREFIX_PATTERN.sub("", line))
        for line in text.splitlines()
    ]
    return " ".join(dedupe_preserving_order(lines))


def build_metric_summary(scored_cases, metric_keys):
    return {
        metric_key: average(case["scores"].get(metric_key) for case in scored_cases)
        for metric_key in metric_keys
    }


def build_route_summaries(scored_cases):
    route_summaries = {}
    present_types = {case["type"] for case in scored_cases}

    for route_type in [*ROUTE_ORDER, *sorted(present_types - set(ROUTE_ORDER))]:
        route_cases = [case for case in scored_cases if case["type"] == route_type]
        if not route_cases:
            continue

        metric_keys = (
            ALL_METRIC_KEYS if route_type == "compare" else RAGAS_METRIC_KEYS
        )
        route_summaries[route_type] = {
            "count": len(route_cases),
            "metrics": build_metric_summary(route_cases, metric_keys),
        }

    return route_summaries


def extract_json_object(raw_text):
    text = str(raw_text or "").strip()

    if not text:
        raise ValueError("Judge returned an empty response.")

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise

        return json.loads(match.group(0))


async def score_compare_rubric(case, normalized_response, normalized_reference, client, judge_model):
    contexts = case["normalizedRetrievedContexts"][:4]
    context_block = "\n\n".join(
        f"Context {index + 1}: {context}"
        for index, context in enumerate(contexts)
    )
    prompt = f"""Question:
{case["question"]}

Retrieved contexts:
{context_block}

Reference answer:
{normalized_reference}

Candidate answer:
{normalized_response}

Score the candidate answer for a multi-document comparison task.

Rubric:
- Reward capturing the main agreements, differences, or a justified no-material-difference conclusion.
- Reward grounding the comparison in the retrieved contexts.
- Do not require the same wording or section layout as the reference.
- Penalize fabricated differences, missed central conflicts, or unsupported no-difference claims.
- Minor omissions are small deductions. Missing the main comparison conclusion is a major deduction.

Return JSON only:
{{
  "score": 0.0,
  "verdict": "one sentence",
  "strengths": ["short item"],
  "issues": ["short item"]
}}"""

    response = await client.chat.completions.create(
        model=judge_model,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a strict evaluator for multi-document comparison answers. "
                    "Return valid JSON only."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        max_tokens=300,
    )
    content = response.choices[0].message.content
    parsed = extract_json_object(content)
    score = parsed.get("score")

    if isinstance(score, int):
        score = float(score)

    if not isinstance(score, float):
        raise ValueError(f"Compare rubric score must be numeric. Received: {score!r}")

    return {
        "score": round(min(1.0, max(0.0, score)), 4),
        "verdict": collapse_whitespace(parsed.get("verdict")),
        "strengths": dedupe_preserving_order(parsed.get("strengths") or []),
        "issues": dedupe_preserving_order(parsed.get("issues") or []),
    }


async def score_case(case, scorers, client, judge_model):
    sample = case["ragasSample"]
    case_type = case["type"]
    raw_response = sample.get("response", "")
    normalized_response = normalize_response_for_ragas(raw_response, case_type)
    reference = sample.get("reference")
    normalized_reference = normalize_response_for_ragas(reference, case_type) if reference else None
    normalized_retrieved_contexts = [
        normalized_context
        for normalized_context in (
            normalize_context_text(context)
            for context in sample.get("retrieved_contexts", [])
        )
        if normalized_context
    ]
    normalized_reference_contexts = [
        normalized_context
        for normalized_context in (
            normalize_context_text(context)
            for context in sample.get("reference_contexts", [])
        )
        if normalized_context
    ]
    reference_context_ids = [
        str(context_id)
        for context_id in sample.get("reference_context_ids", [])
        if str(context_id).strip()
    ]
    retrieved_context_ids = [
        str(context_id)
        for context_id in sample.get("retrieved_context_ids", [])
        if str(context_id).strip()
    ]
    scores = {metric_key: None for metric_key in ALL_METRIC_KEYS}
    errors = {}
    context_precision_scorer = (
        scorers["compare_context_precision"]
        if case_type == "compare" and reference_context_ids and retrieved_context_ids
        else scorers["context_precision"]
    )

    metric_specs = [
        (
            "answer_relevancy",
            scorers["answer_relevancy"],
            bool(normalized_response),
            lambda: {
                "user_input": sample["user_input"],
                "response": normalized_response,
            },
        ),
        (
            "faithfulness",
            scorers["faithfulness"],
            bool(normalized_response and normalized_retrieved_contexts),
            lambda: {
                "user_input": sample["user_input"],
                "response": normalized_response,
                "retrieved_contexts": normalized_retrieved_contexts,
            },
        ),
        (
            "context_utilization",
            scorers["context_utilization"],
            bool(normalized_response and normalized_retrieved_contexts),
            lambda: {
                "user_input": sample["user_input"],
                "response": normalized_response,
                "retrieved_contexts": normalized_retrieved_contexts,
            },
        ),
        (
            "context_precision",
            context_precision_scorer,
            bool(
                normalized_retrieved_contexts
                and (
                    reference_context_ids
                    if case_type == "compare"
                    else normalized_reference
                )
            ),
            lambda: (
                {
                    "retrieved_context_ids": retrieved_context_ids,
                    "reference_context_ids": reference_context_ids,
                }
                if case_type == "compare" and reference_context_ids and retrieved_context_ids
                else {
                    "user_input": sample["user_input"],
                    "reference": normalized_reference,
                    "retrieved_contexts": normalized_retrieved_contexts,
                }
            ),
        ),
        (
            "context_recall",
            scorers["context_recall"],
            bool(normalized_reference and normalized_retrieved_contexts),
            lambda: {
                "user_input": sample["user_input"],
                "retrieved_contexts": normalized_retrieved_contexts,
                "reference": normalized_reference,
            },
        ),
    ]

    for metric_name, scorer, enabled, kwargs_factory in metric_specs:
        if not enabled:
            continue

        try:
            scores[metric_name] = unwrap_score(
                await score_metric(scorer, kwargs_factory())
            )
        except Exception as exc:  # pragma: no cover - external library/runtime behavior
            errors[metric_name] = str(exc)

    compare_judge = None
    if case_type == "compare" and normalized_response and normalized_reference and normalized_retrieved_contexts:
        try:
            compare_judge = await score_compare_rubric(
                {
                    "question": case["question"],
                    "normalizedRetrievedContexts": normalized_retrieved_contexts,
                },
                normalized_response,
                normalized_reference,
                client,
                judge_model,
            )
            scores["compare_rubric"] = compare_judge["score"]
        except Exception as exc:  # pragma: no cover - external library/runtime behavior
            errors["compare_rubric"] = str(exc)

    return {
        "caseId": case["id"],
        "type": case_type,
        "question": case["question"],
        "reference": reference,
        "normalizedReference": normalized_reference,
        "retrievedContextCount": len(normalized_retrieved_contexts),
        "rawResponse": raw_response,
        "normalizedResponse": normalized_response,
        "scores": scores,
        "errors": errors,
        "compareJudge": compare_judge,
    }


def build_markdown(report):
    lines = [
        "# Ragas Evaluation",
        "",
        f"- Created: `{report['createdAt']}`",
        f"- Input file: `{report['inputFile']}`",
        f"- Source run ID: `{report['sourceRunId']}`",
        f"- Judge model: `{report['models']['judge']}`",
        f"- Embedding model: `{report['models']['embedding']}`",
        f"- Eligible cases: `{report['summary']['eligibleCases']}` / `{report['summary']['totalCases']}`",
        "",
        "## Route Summaries",
        "",
        "| Route | Cases | Answer Relevancy | Faithfulness | Context Utilization | Context Precision | Context Recall | Compare Rubric |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        (
            f"| overall | {report['summary']['eligibleCases']} | "
            f"{report['summary']['metrics'].get('answer_relevancy')} | "
            f"{report['summary']['metrics'].get('faithfulness')} | "
            f"{report['summary']['metrics'].get('context_utilization')} | "
            f"{report['summary']['metrics'].get('context_precision')} | "
            f"{report['summary']['metrics'].get('context_recall')} | "
            f"{report['summary']['metrics'].get('compare_rubric')} |"
        ),
    ]

    for route_type in ROUTE_ORDER:
        route_summary = report["summary"]["byType"].get(route_type)
        if not route_summary:
            continue

        lines.append(
            f"| {route_type} | {route_summary['count']} | "
            f"{route_summary['metrics'].get('answer_relevancy')} | "
            f"{route_summary['metrics'].get('faithfulness')} | "
            f"{route_summary['metrics'].get('context_utilization')} | "
            f"{route_summary['metrics'].get('context_precision')} | "
            f"{route_summary['metrics'].get('context_recall')} | "
            f"{route_summary['metrics'].get('compare_rubric')} |"
        )

    qa_cases = [case for case in report["cases"] if case["type"] == "qa"]
    if qa_cases:
        lines.extend(
            [
                "",
                "## QA Cases",
                "",
                "| Case | Answer Relevancy | Faithfulness | Context Utilization | Context Precision | Context Recall |",
                "| --- | ---: | ---: | ---: | ---: | ---: |",
            ]
        )

        for case in qa_cases:
            scores = case["scores"]
            lines.append(
                f"| {case['caseId']} | {scores.get('answer_relevancy')} | {scores.get('faithfulness')} | {scores.get('context_utilization')} | {scores.get('context_precision')} | {scores.get('context_recall')} |"
            )

    compare_cases = [case for case in report["cases"] if case["type"] == "compare"]
    if compare_cases:
        lines.extend(
            [
                "",
                "## Compare Cases",
                "",
                "| Case | Compare Rubric | Answer Relevancy | Faithfulness | Context Utilization | Context Precision | Context Recall |",
                "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )

        for case in compare_cases:
            scores = case["scores"]
            lines.append(
                f"| {case['caseId']} | {scores.get('compare_rubric')} | {scores.get('answer_relevancy')} | {scores.get('faithfulness')} | {scores.get('context_utilization')} | {scores.get('context_precision')} | {scores.get('context_recall')} |"
            )

        lines.extend(["", "## Compare Judge Notes", ""])
        for case in compare_cases:
            compare_judge = case.get("compareJudge")
            if not compare_judge:
                continue

            lines.append(f"### {case['caseId']}")
            lines.append("")
            lines.append(f"- Score: {compare_judge.get('score')}")
            lines.append(f"- Verdict: {compare_judge.get('verdict')}")

            if compare_judge.get("strengths"):
                lines.append(
                    f"- Strengths: {'; '.join(compare_judge.get('strengths', []))}"
                )

            if compare_judge.get("issues"):
                lines.append(
                    f"- Issues: {'; '.join(compare_judge.get('issues', []))}"
                )

            lines.append("")

    if report["skippedCases"]:
        lines.extend(["## Skipped Cases", ""])
        for skipped in report["skippedCases"]:
            lines.append(f"- `{skipped['caseId']}`: {skipped['reason']}")

    return "\n".join(lines) + "\n"


async def main():
    args = build_parser().parse_args()
    script_path = Path(__file__).resolve()
    server_dir = script_path.parent.parent
    load_env_file(server_dir / ".env")

    input_path = Path(args.input).resolve()
    output_json_path = Path(args.output_json).resolve()
    output_md_path = Path(args.output_md).resolve()

    if not input_path.exists():
        raise FileNotFoundError(f"Input evaluation file not found: {input_path}")

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for Ragas evaluation.")

    payload = json.loads(input_path.read_text(encoding="utf-8"))
    source_summary = payload.get("summary", {})
    judge_model = (
        args.judge_model.strip()
        or os.environ.get("RAGAS_EVAL_MODEL", "").strip()
        or "gpt-4o-mini"
    )
    embedding_model = (
        os.environ.get("RAGAS_EMBEDDING_MODEL", "").strip()
        or args.embedding_model.strip()
        or source_summary.get("models", {}).get("embedding", "text-embedding-3-small")
    )

    client = AsyncOpenAI(api_key=api_key, timeout=60.0, max_retries=5)
    llm = llm_factory(judge_model, client=client)
    embeddings = embedding_factory("openai", model=embedding_model, client=client)
    scorers = {
        "answer_relevancy": AnswerRelevancy(llm=llm, embeddings=embeddings),
        "faithfulness": Faithfulness(llm=llm),
        "context_utilization": ContextUtilization(llm=llm),
        "context_precision": ContextPrecision(llm=llm),
        "compare_context_precision": IDBasedContextPrecision(),
        "context_recall": ContextRecall(llm=llm),
    }

    cases = payload.get("cases", [])
    eligible_cases = []
    skipped_cases = []

    for case in cases:
        sample = case.get("ragasSample") or {}
        retrieved_contexts = sample.get("retrieved_contexts") or []
        should_abstain = bool(case.get("shouldAbstain"))

        if not retrieved_contexts:
            skipped_cases.append(
                {"caseId": case.get("id"), "reason": "No retrieved_contexts were captured."}
            )
            continue

        if should_abstain and not args.include_abstain:
            skipped_cases.append(
                {
                    "caseId": case.get("id"),
                    "reason": "Abstain case skipped by default.",
                }
            )
            continue

        eligible_cases.append(case)

    scored_cases = []
    for case in eligible_cases:
        scored_cases.append(await score_case(case, scorers, client, judge_model))

    overall_metric_summary = build_metric_summary(scored_cases, ALL_METRIC_KEYS)
    route_summaries = build_route_summaries(scored_cases)
    report = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "inputFile": str(input_path),
        "sourceRunId": source_summary.get("runId"),
        "models": {
            "judge": judge_model,
            "embedding": embedding_model,
        },
        "summary": {
            "totalCases": len(cases),
            "eligibleCases": len(eligible_cases),
            "metrics": overall_metric_summary,
            "byType": route_summaries,
        },
        "cases": scored_cases,
        "skippedCases": skipped_cases,
    }

    output_json_path.parent.mkdir(parents=True, exist_ok=True)
    output_md_path.parent.mkdir(parents=True, exist_ok=True)
    output_json_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    output_md_path.write_text(build_markdown(report), encoding="utf-8")

    print(f"Ragas evaluation written to {output_json_path}")
    print(f"Markdown report written to {output_md_path}")


if __name__ == "__main__":
    asyncio.run(main())
