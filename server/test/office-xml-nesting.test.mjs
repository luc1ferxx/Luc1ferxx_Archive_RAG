// The one-pass nesting count (rag/office/xml-nesting.js) every Office reader
// is held to, and the cap the PPTX reader and assertDocxXmlNesting share.
import assert from "node:assert/strict";
import test from "node:test";

import { MAX_OFFICE_XML_NESTING, measureXmlNestingDepth } from "../rag/office/xml-nesting.js";

const nested = (depth, inner = "<p>x</p>") => `${"<g>".repeat(depth)}${inner}${"</g>".repeat(depth)}`;

test("start tags open a level, end tags close one, empty-element tags do neither", () => {
  assert.equal(measureXmlNestingDepth(""), 0);
  assert.equal(measureXmlNestingDepth("text only"), 0);
  assert.equal(measureXmlNestingDepth("<a/>"), 0);
  assert.equal(measureXmlNestingDepth("<a></a>"), 1);
  assert.equal(measureXmlNestingDepth("<a><b/><b /><c attr='1'/></a>"), 1);
  assert.equal(measureXmlNestingDepth("<a><b><c>x</c></b><b><c><d/></c></b></a>"), 3);
  assert.equal(measureXmlNestingDepth(nested(300)), 301);
  assert.equal(measureXmlNestingDepth(`<?xml version="1.0"?><w:document xmlns:w="u"><w:body><w:p/></w:body></w:document>`), 2);
});

test("comments, CDATA, processing instructions and declarations are not elements", () => {
  assert.equal(measureXmlNestingDepth("<a><!-- <b><c><d> --></a>"), 1);
  assert.equal(measureXmlNestingDepth("<a><![CDATA[<b><c><d>]]></a>"), 1);
  assert.equal(measureXmlNestingDepth("<?xml version='1.0'?><?pi <b><c> ?><a/>"), 0);
  assert.equal(measureXmlNestingDepth("<!DOCTYPE a><a><b/></a>"), 1);
  // A comment, a CDATA section or an instruction left open ends the count.
  assert.equal(measureXmlNestingDepth("<a><b><!-- <c><d>"), 2);
  assert.equal(measureXmlNestingDepth("<a><![CDATA[<c><d>"), 1);
});

test("a '>' inside a quoted attribute value does not end the tag", () => {
  assert.equal(measureXmlNestingDepth(`<a title="x > y"><b data='1>2'/></a>`), 1);
  assert.equal(measureXmlNestingDepth(`<a title="ends with slash/"><b></b></a>`), 2);
  // An unterminated tag ends the count.
  assert.equal(measureXmlNestingDepth(`<a><b title="open`), 1);
});

test("the count stops once it passes the limit", () => {
  const deep = nested(100_000);

  assert.equal(measureXmlNestingDepth(deep, { limit: MAX_OFFICE_XML_NESTING }), MAX_OFFICE_XML_NESTING + 1);
  assert.equal(measureXmlNestingDepth(nested(MAX_OFFICE_XML_NESTING - 1), { limit: MAX_OFFICE_XML_NESTING }), MAX_OFFICE_XML_NESTING);
  assert.equal(MAX_OFFICE_XML_NESTING, 256);
});
