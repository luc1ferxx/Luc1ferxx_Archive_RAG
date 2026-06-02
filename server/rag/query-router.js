const INTENT_THRESHOLD = 0.5;

const COMPARISON_SIGNALS = [
  {
    label: "explicit comparison",
    score: 0.9,
    pattern:
      /\b(compare|comparison|difference|differences|different|versus|vs|same|similar|conflict|conflicts|contradict|contradiction|contrast)\b|区别|差异|不同|对比|比较|冲突|一致|相同/i,
  },
  {
    label: "document selection",
    score: 0.7,
    pattern:
      /\b(which|what)\s+(document|file|policy|manual|handbook)\b|\b(document|file)\s+(says|states|mentions|contains)\b|哪个文档|哪份文档|哪份文件|哪个文件/i,
  },
  {
    label: "comparative question",
    score: 0.72,
    pattern:
      /\b(which|what|who)\b[^?]*(more|less|higher|lower|greater|fewer|most|least|longer|shorter|earlier|later|stricter|looser|allows?|requires?)\b|\b(more|less|higher|lower|greater|fewer|longer|shorter|earlier|later|stricter|looser)\b[^?]*\bthan\b|哪(?:个|份|些)?[^？?]*(更多|更少|更高|更低|更长|更短|更严格|更宽松)|谁[^？?]*更/i,
  },
  {
    label: "cross-document relationship",
    score: 0.62,
    pattern:
      /\b(across|between|among)\b[^?]*(documents|files|policies|manuals|handbooks)|\b(do|does|are|is)\b[^?]*(align|match|agree|consistent)\b|是否一致|有没有.*(?:差异|冲突)|之间.*(?:关系|一致|冲突|差异)/i,
  },
];

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export const routeQuery = ({ query, docIds }) => {
  const safeQuery = String(query ?? "");
  const docCount = Array.isArray(docIds) ? docIds.length : 0;
  const matchedSignals = COMPARISON_SIGNALS.filter(({ pattern }) =>
    pattern.test(safeQuery)
  );
  const confidence = clamp01(
    matchedSignals.reduce((score, signal) => score + signal.score, 0)
  );

  return {
    mode: docCount > 1 && confidence >= INTENT_THRESHOLD ? "compare" : "qa",
    confidence,
    signals: matchedSignals.map((signal) => signal.label),
  };
};
