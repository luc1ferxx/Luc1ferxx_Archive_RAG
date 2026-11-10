// qasper-answer-funnel.mjs
//
// Where the answerable questions of a qasper-answers report are lost. Each
// question is joined by id with the row of a qasper-retrieval report run over
// the same corpus with the same retrieval and chunking settings, and lands in
// exactly one stage:
//
//   not_retrieved   no annotated evidence paragraph among the candidates
//   refused         evidence among the candidates, but no answer (the gate,
//                   or the answer model when the verdict is on)
//   not_in_context  answered, but the evidence was not in the model's context
//   in_context      answered with the evidence in the context
//
// The first three are losses before the model; the last one is what the
// answer model was actually given a fair chance on. Only ids, flags and
// scores are read, never a prediction.
//
// Usage:
//   node evaluation/qasper-answer-funnel.mjs <answers report.json> <retrieval report.json>
//     [--high-f1 0.5] [--json]

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readAnswered, readQasperAnswerReport } from "./compare-qasper-answer-reports.mjs";
import { getArgValue } from "./eval-cli.js";
import { describeRunConfigDifferences } from "./eval-run-config.js";
import { readContextEvidenceHit } from "./qasper-answer-metrics.js";

export const DEFAULT_HIGH_F1 = 0.5;
export const FUNNEL_STAGES = Object.freeze(["not_retrieved", "refused", "not_in_context", "in_context"]);

const STAGE_LABELS = Object.freeze({
  in_context: "Answered, evidence in the context",
  not_in_context: "Answered, evidence not in the context",
  not_retrieved: "Evidence not among the candidates",
  refused: "Evidence among the candidates, not answered",
});

const round = (value) => Number(value.toFixed(4));
const share = (count, total) => (total > 0 ? round(count / total) : null);
const mean = (values) => (values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null);

/** The stage of one answerable question, from its answer row and its retrieval row. */
export const classifyFunnelStage = (answerRow, retrievalRow) => {
  if (!retrievalRow.hitAtAll) {
    return "not_retrieved";
  }

  if (!readAnswered(answerRow)) {
    return "refused";
  }

  return readContextEvidenceHit(answerRow) === true ? "in_context" : "not_in_context";
};

// The settings both runs must share for their rows to describe the same
// retrieval: a funnel that joins a top-K 6 retrieval report with a top-K 10
// answer report would misplace questions. The commit may differ and is listed.
const describeFunnelConfigDifferences = (answerConfig = {}, retrievalConfig = {}) => {
  const differences = describeRunConfigDifferences(answerConfig, retrievalConfig);

  for (const field of ["corpus", "embeddingModel", "queryAdapter"]) {
    const current = answerConfig[field] ?? null;
    const other = retrievalConfig[field] ?? null;

    if (current !== other) {
      differences.push({ current, field, other });
    }
  }

  return differences;
};

const isCommitField = (difference) => difference.field.startsWith("git.");

/**
 * The funnel of an answer report against a retrieval report of the same
 * corpus and settings. Throws when either report did not record its retrieval
 * settings, when the settings differ (the checkout, `git.*`, may differ and is
 * listed), or when an answerable question has no retrieval row.
 */
export const buildQasperAnswerFunnel = (answerReport, retrievalReport, { highF1 = DEFAULT_HIGH_F1 } = {}) => {
  // The agent surface retrieves with its planner's own plan (another top-K per
  // intent), which a retrieval report of the default route does not describe.
  if ((answerReport.config?.surface ?? "rag") !== "rag") {
    throw new Error(
      `The funnel reads rag-surface answer reports only; this one is ${JSON.stringify(answerReport.config.surface)}, whose retrieval the retrieval report does not describe.`
    );
  }

  // Two reports from before the retrieval settings were recorded show no
  // difference, and nothing shows they agree either: joining them would be a guess.
  const unrecorded = [
    ["answer", answerReport],
    ["retrieval", retrievalReport],
  ]
    .filter(([, report]) => !report.config?.retrieval || typeof report.config.retrieval !== "object")
    .map(([name]) => name);

  if (unrecorded.length > 0) {
    throw new Error(
      `The ${unrecorded.join(" and the ")} report did not record its retrieval settings (config.retrieval), so the two runs cannot be shown to share them; rerun it with the current eval.`
    );
  }

  const configDifferences = describeFunnelConfigDifferences(answerReport.config, retrievalReport.config);
  const blocking = configDifferences.filter((difference) => !isCommitField(difference));

  if (blocking.length > 0) {
    throw new Error(
      `The two reports were not run with the same settings (${blocking
        .map(({ current, field, other }) => `${field}: ${JSON.stringify(current)} vs ${JSON.stringify(other)}`)
        .join("; ")}); a funnel needs the retrieval report of the answer run's own configuration.`
    );
  }

  const retrievalById = new Map((retrievalReport.rows ?? []).map((row) => [row.id, row]));
  const answerable = answerReport.rows.filter((row) => !row.shouldAbstain);
  const unanswerable = answerReport.rows.filter((row) => Boolean(row.shouldAbstain));
  const unpaired = answerable.filter((row) => !retrievalById.has(row.id));

  if (unpaired.length > 0) {
    throw new Error(
      `${unpaired.length} of the ${answerable.length} answerable questions have no row in the retrieval report (first: ${unpaired[0].id}); run eval:qasper-retrieval over the same corpus with enough --cases to cover the answer sample.`
    );
  }

  const staged = answerable.map((row) => ({ retrieval: retrievalById.get(row.id), row }));
  // The retrieval run stops at the gate, so a refusal by the answer model
  // (verdict on) is no disagreement with it.
  const comparable = ({ row }) => (row.abstainSource ?? null) !== "answer_model";
  const stages = FUNNEL_STAGES.map((id) => {
    const members = staged.filter(({ retrieval, row }) => classifyFunnelStage(row, retrieval) === id);
    const answered = members.filter(({ row }) => readAnswered(row));
    const refusedBySource = {};

    for (const { row } of members.filter((member) => !readAnswered(member.row))) {
      const source = row.abstainSource ?? "unknown";

      refusedBySource[source] = (refusedBySource[source] ?? 0) + 1;
    }

    return {
      answered: answered.length,
      answeredF1High: answered.filter(({ row }) => row.f1 >= highF1).length,
      answeredF1Mean: mean(answered.map(({ row }) => row.f1)),
      answeredF1Zero: answered.filter(({ row }) => row.f1 === 0).length,
      cases: members.length,
      id,
      refused: members.length - answered.length,
      refusedBySource,
      share: share(members.length, answerable.length),
    };
  });

  return {
    against: {
      answers: {
        dirty: answerReport.config?.git?.dirty ?? null,
        generatedAt: answerReport.generatedAt ?? null,
        gitSha: answerReport.config?.git?.sha ?? null,
        surface: answerReport.config?.surface ?? null,
      },
      retrieval: {
        dirty: retrievalReport.config?.git?.dirty ?? null,
        generatedAt: retrievalReport.generatedAt ?? null,
        gitSha: retrievalReport.config?.git?.sha ?? null,
      },
    },
    answerable: {
      cases: answerable.length,
      // Rows the two runs disagree on, which a deterministic retrieval should
      // never produce: one run's gate answered where the other's refused, or
      // the evidence was in one run's context and not in the other's. Listed,
      // not corrected.
      inconsistent: {
        context: staged.filter(
          (member) =>
            comparable(member) &&
            typeof member.retrieval["context@0"] === "boolean" &&
            member.retrieval["context@0"] !== (readAnswered(member.row) && readContextEvidenceHit(member.row) === true)
        ).length,
        gate: staged.filter(
          (member) =>
            comparable(member) &&
            typeof member.retrieval.gateConfident === "boolean" &&
            member.retrieval.gateConfident !== readAnswered(member.row)
        ).length,
      },
      stages,
    },
    configDifferences,
    highF1,
    unanswerable: {
      answered: unanswerable.filter((row) => readAnswered(row)).length,
      cases: unanswerable.length,
      refused: unanswerable.filter((row) => !readAnswered(row)).length,
    },
  };
};

const formatValue = (value) => (value === null ? "n/a" : String(value));

/** The funnel as Markdown lines. */
export const formatFunnelMarkdown = (funnel) => {
  const { answerable, unanswerable } = funnel;
  const refusedSources = answerable.stages
    .flatMap((stage) => Object.entries(stage.refusedBySource))
    .reduce((totals, [source, count]) => ({ ...totals, [source]: (totals[source] ?? 0) + count }), {});

  return [
    `Answer funnel of ${answerable.cases} answerable questions (each in exactly one stage; F1 is the official answer F1 of the answered questions, high = at least ${funnel.highF1}):`,
    "",
    "| Stage | Questions | Share | Answered | Refused | Mean F1 | F1 = 0 | F1 high |",
    "|---|---|---|---|---|---|---|---|",
    ...answerable.stages.map(
      (stage) =>
        `| ${STAGE_LABELS[stage.id]} | ${stage.cases} | ${formatValue(stage.share)} | ${stage.answered} | ${stage.refused} | ${formatValue(stage.answeredF1Mean)} | ${stage.answered > 0 ? stage.answeredF1Zero : "n/a"} | ${stage.answered > 0 ? stage.answeredF1High : "n/a"} |`
    ),
    "",
    `Refusals by source: ${Object.entries(refusedSources).map(([source, count]) => `${source} ${count}`).join(", ") || "none"}.`,
    `Unanswerable questions: ${unanswerable.refused} of ${unanswerable.cases} refused, ${unanswerable.answered} answered.`,
    ...(answerable.inconsistent.context + answerable.inconsistent.gate > 0
      ? [
          `The two runs disagree on ${answerable.inconsistent.gate} gate decision(s) and on whether the evidence was in the context of ${answerable.inconsistent.context} question(s): the reports do not describe the same retrieval for those.`,
        ]
      : []),
    ...(funnel.configDifferences.length > 0
      ? [
          `The reports differ in ${funnel.configDifferences
            .map(({ current, field, other }) => `${field} (${JSON.stringify(current)} vs ${JSON.stringify(other)})`)
            .join("; ")}.`,
        ]
      : []),
    // The recorded settings say nothing about uncommitted code.
    ...Object.entries(funnel.against)
      .filter(([, report]) => report.dirty !== false)
      .map(
        ([name, report]) =>
          `The ${name === "answers" ? "answer" : "retrieval"} report ${
            report.dirty === true ? "was written from a checkout with uncommitted changes" : "did not record whether its checkout was clean"
          }; the recorded settings cannot vouch for its code.`
      ),
    "",
  ];
};

/** A qasper-retrieval report read from disk; a parse error names the file. */
export const readQasperRetrievalReport = async (file) => {
  const resolved = path.resolve(process.cwd(), file);
  let parsed;

  try {
    parsed = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }

  if (parsed?.reportType !== "qasper-retrieval" || !Array.isArray(parsed.rows)) {
    throw new Error(`${file} is not a qasper-retrieval report.`);
  }

  return parsed;
};

const main = async () => {
  const args = process.argv.slice(2);
  const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--high-f1");

  if (positional.length !== 2) {
    throw new Error("Usage: qasper-answer-funnel.mjs <answers report.json> <retrieval report.json> [--high-f1 0.5] [--json]");
  }

  const highF1 = Number(getArgValue("--high-f1") ?? DEFAULT_HIGH_F1);

  if (!Number.isFinite(highF1) || highF1 <= 0 || highF1 > 1) {
    throw new Error(`--high-f1 must be a number in (0, 1]; got ${JSON.stringify(getArgValue("--high-f1"))}.`);
  }

  const funnel = buildQasperAnswerFunnel(
    await readQasperAnswerReport(positional[0]),
    await readQasperRetrievalReport(positional[1]),
    { highF1 }
  );

  process.stdout.write(args.includes("--json") ? `${JSON.stringify(funnel, null, 2)}\n` : formatFunnelMarkdown(funnel).join("\n"));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
