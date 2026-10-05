// Rule-based sentence splitting for the sentence chunker
// (RAG_CHUNK_STRATEGY=sentence, rag/chunker.js).
//
// The splitter only decides where a text is cut; it never rewrites, drops or
// reorders a character. Each returned segment carries the separator it had in
// front of it in the source (" " when whitespace separated it from the
// previous segment, "" when nothing did, as after a CJK full stop), so joining
// consecutive segments with their separators gives back the source text with
// its whitespace collapsed.
//
// A Latin terminator (. ! ? … or a run of them such as "..." or "?!"),
// optionally followed by closing quotes or brackets, ends a sentence when
// whitespace follows it and the next word does not start with a lowercase
// letter. A single "." does not end a sentence after a known abbreviation
// ("et al.", "e.g.", "Fig.", "Eq.", "vs.", "Dr.", "Inc.", ...), an initial
// ("J. Smith"), a dotted acronym ("U.S.", "Ph.D."), "No." before a number, or
// when the sentence so far is only a list or section number ("1.", "3.2.",
// "iv.") or a caption label ("Table 1.", "Fig. 2."). Decimals and version
// numbers ("3.14", "v1.2.3") are never cut, because no whitespace follows
// their dots. A CJK terminator (。！？；) ends a sentence with or without
// whitespace after it. A long run without whitespace is never hard-cut
// between the two halves of a surrogate pair.

const LATIN_TERMINATORS = new Set([".", "!", "?", "…"]);
const CJK_TERMINATORS = new Set(["。", "！", "？", "；"]);
const CLOSERS = new Set([
  '"',
  "'",
  ")",
  "]",
  "}",
  "”", // ”
  "’", // ’
  "»", // »
  "」", // 」
  "』", // 』
  "）", // ）
  "】", // 】
  "》", // 》
]);
const OPENERS = /^[("'[{“‘«「『（【《]+/u;
const WHITESPACE = /\s/u;
const LOWERCASE_START = /^\p{Ll}/u;
const DIGIT_START = /^[0-9]/;

// Compared lowercased, without the final period.
const ABBREVIATIONS = new Set([
  "al",
  "e.g",
  "eg",
  "i.e",
  "ie",
  "cf",
  "vs",
  "viz",
  "resp",
  "approx",
  "ca",
  "fig",
  "figs",
  "eq",
  "eqs",
  "sec",
  "secs",
  "sect",
  "ch",
  "chap",
  "vol",
  "vols",
  "pp",
  "ref",
  "refs",
  "tab",
  "app",
  "appx",
  "art",
  "para",
  "thm",
  "lem",
  "def",
  "prop",
  "cor",
  "alg",
  "ed",
  "eds",
  "dr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "rev",
  "gen",
  "jr",
  "sr",
  "st",
  "mt",
  "inc",
  "ltd",
  "co",
  "corp",
  "dept",
  "univ",
  "assn",
  "bros",
  "jan",
  "feb",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "ph.d",
  "a.m",
  "p.m",
  // Reference-list venue abbreviations ("Proc. Natl. Acad. Sci.", "Adv.
  // Neural Inf. Process. Syst.", "Trans. Assoc. Comput. Linguist.").
  "proc",
  "adv",
  "avg",
  "conf",
  "trans",
  "intl",
  "natl",
  "acad",
  "assoc",
  "comput",
  "linguist",
  "mach",
  "lett",
  "symp",
  "inf",
  "syst",
]);
// Abbreviations that are also ordinary words; they only count before a number
// ("No. 5", but "the answer is no. Then").
const NUMBER_ABBREVIATIONS = new Set(["no", "nos", "nr"]);
const INITIAL = /^\p{L}$/u;
const DOTTED_ACRONYM = /^(?:\p{L}{1,2}\.)+\p{L}{1,2}$/u;
// A "sentence" that would consist of nothing but a list or section number
// ("1.", "3.2.", "ii.") or a caption label ("Table 1.", "Fig. 2.") is the
// start of the item or caption that follows it, not a sentence of its own.
const SECTION_NUMBER = String.raw`\d{1,3}(?:\.\d{1,3})*`;
const ROMAN_NUMERAL = String.raw`(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})`;
const LABEL_ONLY_SENTENCE = new RegExp(
  String.raw`^(?:\(?(?:${SECTION_NUMBER}|${ROMAN_NUMERAL})|` +
    String.raw`(?:table|tab|figure|fig|algorithm|alg|section|sec|appendix|app|equation|eq|` +
    String.raw`lemma|theorem|thm|definition|def|proposition|prop|corollary|example|step|` +
    String.raw`chapter|ch|part|listing)\.?\s+(?:${SECTION_NUMBER}|${ROMAN_NUMERAL}|\p{Lu})` +
    String.raw`)\.$`,
  "iu"
);

const readWordBefore = (text, index) => {
  let start = index;

  while (start > 0 && !WHITESPACE.test(text[start - 1])) {
    start -= 1;
  }

  return text.slice(start, index).replace(OPENERS, "");
};

const isAbbreviation = (word, nextText) => {
  if (!word) {
    return false;
  }

  const lowered = word.toLowerCase();

  if (ABBREVIATIONS.has(lowered) || INITIAL.test(word) || DOTTED_ACRONYM.test(word)) {
    return true;
  }

  return NUMBER_ABBREVIATIONS.has(lowered) && DIGIT_START.test(nextText);
};

// Returns the offsets at which the text is cut into sentences: each offset is
// the end of one sentence (exclusive); whitespace after it belongs to no
// sentence.
const findSentenceEnds = (text) => {
  const ends = [];
  let index = 0;
  // Where the sentence in progress starts (whitespace before it included).
  let sentenceStart = 0;

  while (index < text.length) {
    const character = text[index];

    if (CJK_TERMINATORS.has(character)) {
      let end = index + 1;

      while (end < text.length && (CJK_TERMINATORS.has(text[end]) || CLOSERS.has(text[end]))) {
        end += 1;
      }

      if (end < text.length) {
        ends.push(end);
        sentenceStart = end;
      }

      index = end;
      continue;
    }

    if (!LATIN_TERMINATORS.has(character)) {
      index += 1;
      continue;
    }

    const runStart = index;
    let runEnd = index + 1;

    while (runEnd < text.length && LATIN_TERMINATORS.has(text[runEnd])) {
      runEnd += 1;
    }

    let end = runEnd;

    while (end < text.length && CLOSERS.has(text[end])) {
      end += 1;
    }

    index = end;

    // Decimals, versions, "e.g.," and dotted names: no whitespace follows.
    if (end >= text.length || !WHITESPACE.test(text[end])) {
      continue;
    }

    let next = end;

    while (next < text.length && WHITESPACE.test(text[next])) {
      next += 1;
    }

    if (next >= text.length) {
      continue;
    }

    const nextText = text.slice(next, next + 2);

    if (LOWERCASE_START.test(nextText)) {
      continue;
    }

    if (
      runEnd - runStart === 1 &&
      character === "." &&
      (isAbbreviation(readWordBefore(text, runStart), nextText) ||
        (runEnd - sentenceStart <= 48 &&
          LABEL_ONLY_SENTENCE.test(text.slice(sentenceStart, runEnd).trim())))
    ) {
      continue;
    }

    ends.push(end);
    sentenceStart = end;
  }

  return ends;
};

// Splits a text into sentences. Each entry is { text, separator }: the
// sentence without surrounding whitespace, and " " or "" for what stood
// between it and the previous sentence ("" for the first one).
export const splitSentenceSegments = (value = "") => {
  const text = String(value ?? "");
  const segments = [];
  let start = 0;

  for (const end of [...findSentenceEnds(text), text.length]) {
    const raw = text.slice(start, end);
    const sentence = raw.trim();

    if (sentence) {
      const hadLeadingSpace = raw.length > 0 && WHITESPACE.test(raw[0]);

      segments.push({
        text: sentence,
        separator: segments.length === 0 ? "" : hadLeadingSpace ? " " : "",
      });
    }

    start = end;
  }

  return segments;
};

export const splitSentences = (value = "") =>
  splitSentenceSegments(value).map((segment) => segment.text);

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;

const CLAUSE_PUNCTUATION = new Set([",", ";", ":", "，", "、", "；", "："]);
const CJK_CLAUSE_PUNCTUATION = new Set(["，", "、", "；", "："]);

// Cuts one sentence longer than maxLength into pieces of at most maxLength
// characters: at the last clause boundary (",", ";", ":" before whitespace, or
// a CJK "，、；：") in the second half of the window, else at the last
// whitespace, else (a run with no whitespace at all) exactly at maxLength.
// Each piece is { text, separator } like a sentence segment; the first piece
// has separator "".
export const splitLongSentence = (value, maxLength) => {
  const limit = Math.max(1, Math.floor(maxLength));
  const pieces = [];
  let rest = String(value ?? "").trim();
  let separator = "";

  while (rest.length > limit) {
    let cut = -1;
    let nextStart = -1;

    for (let position = limit; position >= Math.ceil(limit / 2); position -= 1) {
      const previous = rest[position - 1];

      if (!CLAUSE_PUNCTUATION.has(previous)) {
        continue;
      }

      if (CJK_CLAUSE_PUNCTUATION.has(previous)) {
        cut = position;
        nextStart = position;
        break;
      }

      if (position < rest.length && WHITESPACE.test(rest[position])) {
        cut = position;
        nextStart = position;
        break;
      }
    }

    if (cut === -1) {
      for (let position = limit; position > 0; position -= 1) {
        if (WHITESPACE.test(rest[position])) {
          cut = position;
          nextStart = position;
          break;
        }
      }
    }

    if (cut === -1) {
      // Never between the two halves of a surrogate pair (an emoji or a CJK
      // Extension B character): a lone half is not text and does not survive
      // encoding to UTF-8.
      cut = limit > 1 && isHighSurrogate(rest.charCodeAt(limit - 1)) ? limit - 1 : limit;
      nextStart = cut;
    }

    const piece = rest.slice(0, cut).trimEnd();
    let following = rest.slice(nextStart);
    const followingTrimmed = following.trimStart();
    const nextSeparator = followingTrimmed.length < following.length ? " " : "";
    following = followingTrimmed;

    pieces.push({ text: piece, separator });
    separator = nextSeparator;
    rest = following;
  }

  if (rest) {
    pieces.push({ text: rest, separator });
  }

  return pieces;
};
