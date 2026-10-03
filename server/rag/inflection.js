// Inflection-aware word matching for the QA gate (RAG_QA_GATE_INFLECTION) and
// the lexical claim check (RAG_CLAIM_INFLECTION).
//
// Two words match when they share a base form under English inflection only:
// plural and third-person -s/-es/-ies, past -ed/-ied, and -ing, with the
// silent-e and doubled-consonant spellings ("proposed" ~ "propose",
// "stopped" ~ "stop", "studies" ~ "study"). It is deliberately not a stemmer:
// derivational suffixes (-er, -est, -ly, -tion, -ment, -able, ...) and prefixes
// ("un-", "non-") are never removed, because they change meaning ("larger" is
// not "large", "unpaid" is not "paid"). Only lowercase ASCII words of four or
// more letters are reduced, and a base form must keep at least three letters,
// so numbers, identifiers, short words and CJK text match exactly.

const REDUCIBLE_WORD = /^[a-z]{4,}$/;
// A doubled final consonant from "stop" -> "stopped"; l, s and z double in
// base forms too ("call", "pass", "buzz"), so they are not undoubled.
const DOUBLED_CONSONANT = /([bcdfgkmnprtv])\1$/;
const MIN_BASE_LENGTH = 3;

// Number words are values, not inflections: "seconds" is a unit of time, not
// the ordinal "second"; "thirds" in "two thirds" is not "a third"; "tens" and
// "hundreds" are not "ten" and "a hundred". Such a word is matched exactly, and
// no other word reduces to one.
const NUMBER_WORDS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty",
  "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "million",
  "billion", "trillion", "dozen", "half", "quarter", "first", "second", "third",
  "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh",
  "twelfth", "twentieth", "hundredth", "thousandth", "millionth",
]);

// Words whose apparent base is a different word ("news" is not "new", "means"
// is not the statistical "mean", "united" is not "unit", "goods" is not "good",
// "premises" is not "premise", "evening" is not "even"). They are matched
// exactly. Not exhaustive: rag/inflection.js stays a rule set, not a lexicon.
const NON_INFLECTED_WORDS = new Set([
  "news", "means", "meaning", "meanings", "united", "goods", "premises",
  "evening", "evenings", "series", "species",
]);

const addBase = (bases, value) => {
  if (value.length >= MIN_BASE_LENGTH && !NUMBER_WORDS.has(value)) {
    bases.add(value);
  }
};

const addVerbBases = (bases, stem) => {
  addBase(bases, stem);
  addBase(bases, `${stem}e`);

  if (DOUBLED_CONSONANT.test(stem)) {
    addBase(bases, stem.slice(0, -1));
  }
};

/**
 * The word itself plus every base form an English inflection could have come
 * from. Over-generation is harmless only because a match needs both words to
 * share a base; it is never used to rewrite text.
 */
export const getInflectionBases = (word = "") => {
  const token = String(word ?? "");
  const bases = new Set([token]);

  if (!REDUCIBLE_WORD.test(token) || NUMBER_WORDS.has(token) || NON_INFLECTED_WORDS.has(token)) {
    return bases;
  }

  if (token.endsWith("ies") || token.endsWith("ied")) {
    addBase(bases, `${token.slice(0, -3)}y`);
  }

  if (token.endsWith("es") && /(?:s|x|z|ch|sh)es$/.test(token)) {
    addBase(bases, token.slice(0, -2));
  }

  if (token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) {
    addBase(bases, token.slice(0, -1));
  }

  if (token.endsWith("ed") && token.length >= 5) {
    addVerbBases(bases, token.slice(0, -2));
  }

  // Four-letter past forms of an -e verb: "used" ~ "use", "owed" ~ "owe". Not
  // after "ee", so "fee" and "see" stay apart from "feed" and "seed".
  if (token.length === 4 && token.endsWith("ed") && !token.endsWith("eed")) {
    addBase(bases, token.slice(0, -1));
  }

  if (token.endsWith("ing") && token.length >= 6) {
    addVerbBases(bases, token.slice(0, -3));
  }

  // "-s" after an "-ing"/"-ed" form: "ceilings" ~ "ceiling", "proceeds".
  if (token.endsWith("ings") && token.length >= 7) {
    addVerbBases(bases, token.slice(0, -4));
  }

  return bases;
};

/**
 * An index over a set of words, answering whether some word in it is an
 * inflected form of a given word.
 */
export const buildInflectionIndex = (words = []) => {
  const exact = new Set();
  const bases = new Set();

  for (const word of words) {
    exact.add(word);

    for (const base of getInflectionBases(word)) {
      bases.add(base);
    }
  }

  return {
    has: (word) => {
      if (exact.has(word)) {
        return true;
      }

      for (const base of getInflectionBases(word)) {
        if (bases.has(base)) {
          return true;
        }
      }

      return false;
    },
  };
};

export const isInflectionMatch = (left = "", right = "") =>
  left === right || buildInflectionIndex([right]).has(left);
