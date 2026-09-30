// Lossless JSON encoding for retrieval results crossing the retrieval tier's
// HTTP boundary (rag/retrieval-service/).
//
// The in-process path hands results to assessQaConfidence, selectQaContext,
// the trace builders and the /chat retrieval block as JavaScript values. Plain
// JSON would change some of them on the way: a property whose value is
// undefined disappears (strict deep equality then differs), NaN and the
// infinities become null, -0 becomes 0, and a Map (resultsByDocument) becomes
// {}. This codec keeps every one of them, so a remote retrieval hands the
// caller exactly what the in-process call would have.
//
// A tagged value is an object whose only meta key is "$"; a data object that
// itself has a "$" key is wrapped ({ $: "obj", value }) so it can never be
// read as a tag. Values without a JSON meaning (functions, symbols, bigints,
// class instances other than Map and Date) are refused rather than guessed.

const TAG = "$";

const isPlainObject = (value) => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
};

// defineProperty keeps a "__proto__" key a plain own property instead of a
// prototype switch; it also keeps a key whose value is undefined present.
const setOwn = (target, key, value) =>
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });

const encodeNumber = (value) => {
  if (Number.isNaN(value)) {
    return { [TAG]: "NaN" };
  }

  if (value === Number.POSITIVE_INFINITY) {
    return { [TAG]: "Infinity" };
  }

  if (value === Number.NEGATIVE_INFINITY) {
    return { [TAG]: "-Infinity" };
  }

  if (Object.is(value, -0)) {
    return { [TAG]: "-0" };
  }

  return value;
};

/**
 * `value` as plain JSON data that decodeWireValue turns back into an equal
 * value. Throws TypeError on anything it cannot represent exactly.
 */
export const encodeWireValue = (value) => {
  if (value === undefined) {
    return { [TAG]: "undefined" };
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return encodeNumber(value);
  }

  if (Array.isArray(value)) {
    return Array.from(value, (item) => encodeWireValue(item));
  }

  if (value instanceof Map) {
    return {
      [TAG]: "map",
      entries: [...value.entries()].map(([key, item]) => [encodeWireValue(key), encodeWireValue(item)]),
    };
  }

  if (value instanceof Date) {
    return { [TAG]: "date", value: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  }

  if (isPlainObject(value)) {
    const encoded = {};

    for (const [key, item] of Object.entries(value)) {
      setOwn(encoded, key, encodeWireValue(item));
    }

    return Object.hasOwn(value, TAG) ? { [TAG]: "obj", value: encoded } : encoded;
  }

  throw new TypeError(`Cannot encode a ${typeof value === "object" ? value.constructor?.name ?? "object" : typeof value} for the retrieval wire.`);
};

const decodeTagged = (value) => {
  switch (value[TAG]) {
    case "undefined":
      return undefined;
    case "NaN":
      return Number.NaN;
    case "Infinity":
      return Number.POSITIVE_INFINITY;
    case "-Infinity":
      return Number.NEGATIVE_INFINITY;
    case "-0":
      return -0;
    case "map":
      if (!Array.isArray(value.entries)) {
        break;
      }

      return new Map(
        value.entries.map((entry) => {
          if (!Array.isArray(entry) || entry.length !== 2) {
            throw new TypeError("Malformed map entry on the retrieval wire.");
          }

          return [decodeWireValue(entry[0]), decodeWireValue(entry[1])];
        })
      );
    case "date":
      return new Date(value.value ?? Number.NaN);
    case "obj":
      if (!isPlainObject(value.value)) {
        break;
      }

      return decodePlainObject(value.value);
    default:
      break;
  }

  throw new TypeError("Unknown or malformed tag on the retrieval wire.");
};

const decodePlainObject = (value) => {
  const decoded = {};

  for (const [key, item] of Object.entries(value)) {
    setOwn(decoded, key, decodeWireValue(item));
  }

  return decoded;
};

/** The value encodeWireValue encoded. Throws TypeError on a malformed tag. */
export const decodeWireValue = (value) => {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => decodeWireValue(item));
  }

  return Object.hasOwn(value, TAG) ? decodeTagged(value) : decodePlainObject(value);
};
