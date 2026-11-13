// How deep an Office XML part may nest its elements, and a one-pass count of
// how deep a part does.
//
// mammoth and the PPTX reader walk the element tree recursively. Without a
// cap of their own, a part nested deep enough overflows the stack of the
// thread that parses it, and a worker thread (rag/office-parse-pool.js) gets
// a larger stack than the main thread, so the same file would be refused in
// one and read in the other (measured on Node 24: a Word document of nested
// smart tags was read at 1,500 levels on both, refused at 3,000 on the main
// thread while a worker read it, and refused on both at 12,000). The cap is
// far beyond real documents (a table inside a few nested groups or tables
// stays well under 40 levels) and far below the depth at which either
// thread's stack runs out, so every thread refuses the same files: the PPTX
// reader through its parser's maxNestedTags, a Word document through
// assertDocxXmlNesting (docx-loader.js) before mammoth reads it.
export const MAX_OFFICE_XML_NESTING = 256;

/**
 * The deepest element nesting of `xml` (a string), counted in one linear
 * pass: a start tag opens a level, an end tag closes one, an empty-element tag
 * (`<a/>`) does neither. Comments, CDATA sections, processing instructions and
 * declarations are skipped, and a `>` inside a quoted attribute value does not
 * end its tag. Stops once the depth passes `limit` and returns that depth.
 * Whether the XML is well-formed is not judged here: the parser that reads the
 * part refuses it if not.
 */
export const measureXmlNestingDepth = (xml, { limit = Number.POSITIVE_INFINITY } = {}) => {
  const text = String(xml);
  const { length } = text;
  let depth = 0;
  let deepest = 0;
  let index = 0;

  while (index < length) {
    const open = text.indexOf("<", index);

    if (open < 0) {
      break;
    }

    let skipTo = -1;

    if (text.startsWith("<!--", open)) {
      skipTo = text.indexOf("-->", open + 4);
      skipTo = skipTo < 0 ? length : skipTo + 3;
    } else if (text.startsWith("<![CDATA[", open)) {
      skipTo = text.indexOf("]]>", open + 9);
      skipTo = skipTo < 0 ? length : skipTo + 3;
    } else if (text.startsWith("<?", open)) {
      skipTo = text.indexOf("?>", open + 2);
      skipTo = skipTo < 0 ? length : skipTo + 2;
    } else if (text.startsWith("<!", open)) {
      skipTo = text.indexOf(">", open + 2);
      skipTo = skipTo < 0 ? length : skipTo + 1;
    }

    if (skipTo >= 0) {
      index = skipTo;
      continue;
    }

    // A start, end or empty-element tag: its end is the first '>' outside a
    // quoted attribute value.
    let cursor = open + 1;
    let quote = 0;

    while (cursor < length) {
      const code = text.charCodeAt(cursor);

      if (quote) {
        if (code === quote) {
          quote = 0;
        }
      } else if (code === 0x22 || code === 0x27) {
        quote = code;
      } else if (code === 0x3e) {
        break;
      }

      cursor += 1;
    }

    if (cursor >= length) {
      break;
    }

    if (text.charCodeAt(open + 1) === 0x2f) {
      depth = Math.max(0, depth - 1);
    } else if (text.charCodeAt(cursor - 1) !== 0x2f) {
      depth += 1;

      if (depth > deepest) {
        deepest = depth;

        if (deepest > limit) {
          return deepest;
        }
      }
    }

    index = cursor + 1;
  }

  return deepest;
};
