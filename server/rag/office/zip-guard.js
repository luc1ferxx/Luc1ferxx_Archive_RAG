// The Office archive guard: every .docx, .pptx and .xlsx goes through here
// before a parser sees it (format detection at the upload check, and again in
// rag/document-loader.js before the loaders run). A .docx, .pptx or .xlsx is a
// ZIP of XML parts, so a hostile one is a zip bomb or an XML entity bomb aimed
// at the parsers behind it: mammoth (JSZip), SheetJS (its own ZIP reader) and
// the PPTX reader (the parts kept here).
//
// What it refuses:
//   413 DOCUMENT_ARCHIVE_TOO_LARGE  more entries than RAG_OFFICE_MAX_ZIP_ENTRIES;
//       more inflated bytes than RAG_OFFICE_MAX_UNCOMPRESSED_BYTES, declared or
//       actually inflated; an entry over 1 MiB whose inflated/compressed ratio
//       exceeds RAG_OFFICE_MAX_COMPRESSION_RATIO, declared or actual; a
//       [Content_Types].xml or _rels/.rels over PACKAGE_PART_MAX_BYTES, which
//       the guard itself parses at every upload check. Once the format is
//       known, assertOfficeXmlWithinLimit applies RAG_OFFICE_MAX_XML_BYTES to
//       the XML the parser of that format will hold in memory.
//   400 DOCUMENT_ARCHIVE_INVALID  anything else that is wrong: not a readable
//       ZIP, an unsafe entry name ('..', absolute), an encrypted entry, a
//       compression method other than store and deflate, two entries with one
//       name, an entry whose bytes disagree with its directory record, any
//       .xml or .rels part declaring a DTD ('<!DOCTYPE' or '<!ENTITY', any
//       case, UTF-8 or UTF-16: OOXML never needs one, and a DTD is how an
//       entity bomb gets in).
//
// Sizes are checked twice. The directory's declared sizes first, so a bomb is
// refused before anything is inflated; then every entry is inflated and its
// real bytes counted against the same caps, stopping at the chunk that crosses
// one, because a directory can lie about sizes. An entry whose real size or
// checksum disagrees with its record is refused once inflated.
//
// The parsers behind the guard must see the archive the guard saw. mammoth's
// JSZip reads the central directory, as yauzl does here; SheetJS reads the
// central directory's count and offsets but trusts each LOCAL header for the
// entry's name and sizes, and sizes its inflate buffer from them. So the
// guard also refuses an archive whose end record could be read two ways (the
// last end-of-directory signature in the file must be the record, with a
// consistent comment length and no ZIP64 locator), whose directory does not
// end where the end record says it starts, or whose local headers disagree
// with the directory about an entry's name, method, encryption or sizes
// (ZIP64 extra fields included). No real Office file needs ZIP64 below the
// caps, so a ZIP64 archive is refused too.
import path from "node:path";
import { crc32 } from "node:zlib";

import { XMLParser } from "fast-xml-parser";
import yauzl from "yauzl";

import {
  getOfficeMaxCompressionRatio,
  getOfficeMaxUncompressedBytes,
  getOfficeMaxXmlBytes,
  getOfficeMaxZipEntries,
} from "../config.js";
import {
  createArchiveInvalidError,
  createArchiveTooLargeError,
  isDocumentFormatError,
} from "../document-format-errors.js";

export const ZIP_LOCAL_HEADER_SIGNATURE = Object.freeze([0x50, 0x4b, 0x03, 0x04]);

/** Whether `bytes` begin with a ZIP local file header (every non-empty ZIP does). */
export const startsWithZipLocalHeader = (bytes) =>
  (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) &&
  bytes.length >= ZIP_LOCAL_HEADER_SIGNATURE.length &&
  ZIP_LOCAL_HEADER_SIGNATURE.every((byte, index) => bytes[index] === byte);

// The ratio cap applies to entries that inflate to more than this: small
// parts (a run of spaces, an empty sheet) compress far beyond any sane ratio.
export const COMPRESSION_RATIO_MIN_ENTRY_BYTES = 1024 * 1024;

export const CONTENT_TYPES_PART = "[Content_Types].xml";
export const PACKAGE_RELATIONSHIPS_PART = "_rels/.rels";

// [Content_Types].xml and _rels/.rels are parsed here, at every upload check,
// before the format is known. A real one lists a content type per part (about
// 130 bytes each, so 10000 entries come to some 1.3 MB) and a handful of
// relationships; fast-xml-parser takes about 15 times the part in memory, so
// a fixed cap keeps the check itself cheap whatever the other limits say.
export const PACKAGE_PART_MAX_BYTES = 4 * 1024 * 1024;

// The relationship from the package to its main part (word/document.xml,
// ppt/presentation.xml, xl/workbook.xml), transitional and strict.
export const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = Object.freeze([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const EOCD_LENGTH = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_LENGTH = 20;
const CENTRAL_HEADER_LENGTH = 46;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
// Traditional encryption, strong encryption, an encrypted central directory.
const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const STORED = 0;
const DEFLATED = 8;

/**
 * The guard's limits: each one `overrides` names, else the setting's value now
 * (rag/config.js; a setting read here throws RAG_OFFICE_LIMIT_INVALID).
 */
export const readOfficeArchiveLimits = (overrides = {}) => ({
  maxCompressionRatio: overrides.maxCompressionRatio ?? getOfficeMaxCompressionRatio(),
  maxEntries: overrides.maxEntries ?? getOfficeMaxZipEntries(),
  maxUncompressedBytes: overrides.maxUncompressedBytes ?? getOfficeMaxUncompressedBytes(),
  maxXmlBytes: overrides.maxXmlBytes ?? getOfficeMaxXmlBytes(),
});

const invalid = (reason, cause) => createArchiveInvalidError(reason, cause === undefined ? {} : { cause });

const tooManyEntries = (limit) =>
  createArchiveTooLargeError(`it holds more than ${limit} entries (RAG_OFFICE_MAX_ZIP_ENTRIES)`);

const tooManyBytes = (limit) =>
  createArchiveTooLargeError(`its parts inflate to more than ${limit} bytes (RAG_OFFICE_MAX_UNCOMPRESSED_BYTES)`);

const ratioTooHigh = (limit) =>
  createArchiveTooLargeError(
    `a part inflates to more than ${limit} times its compressed size (RAG_OFFICE_MAX_COMPRESSION_RATIO)`
  );

const packagePartTooLarge = () =>
  createArchiveTooLargeError(`a package part ([Content_Types].xml, _rels/.rels) inflates to more than ${PACKAGE_PART_MAX_BYTES} bytes`);

const exceedsRatio = (inflatedBytes, compressedBytes, maxRatio) =>
  inflatedBytes > COMPRESSION_RATIO_MIN_ENTRY_BYTES && inflatedBytes > maxRatio * compressedBytes;

// The end-of-central-directory record, read the way every parser behind the
// guard can agree on: SheetJS takes the LAST end signature in the whole file,
// yauzl and JSZip the last one that leaves room for the 22-byte record. They
// pick the same record only when the last signature is that record and its
// comment runs exactly to the end of the file.
const readEndOfCentralDirectory = (buffer) => {
  const offset = buffer.lastIndexOf(EOCD_SIGNATURE);

  if (offset < 0 || offset + EOCD_LENGTH > buffer.length) {
    throw invalid("it is not a readable ZIP archive");
  }

  if (offset + EOCD_LENGTH + buffer.readUInt16LE(offset + 20) !== buffer.length) {
    throw invalid("its ZIP end record is ambiguous");
  }

  const record = {
    centralDirectoryOffset: buffer.readUInt32LE(offset + 16),
    centralDirectorySize: buffer.readUInt32LE(offset + 12),
    diskNumber: buffer.readUInt16LE(offset + 4),
    entriesOnDisk: buffer.readUInt16LE(offset + 8),
    offset,
    startDisk: buffer.readUInt16LE(offset + 6),
    totalEntries: buffer.readUInt16LE(offset + 10),
  };

  if (
    record.totalEntries === 0xffff ||
    record.centralDirectorySize === 0xffffffff ||
    record.centralDirectoryOffset === 0xffffffff ||
    (offset >= ZIP64_LOCATOR_LENGTH && buffer.readUInt32LE(offset - ZIP64_LOCATOR_LENGTH) === ZIP64_LOCATOR_SIGNATURE)
  ) {
    throw invalid("ZIP64 archives are not supported");
  }

  if (
    record.diskNumber !== 0 ||
    record.startDisk !== 0 ||
    record.entriesOnDisk !== record.totalEntries ||
    record.centralDirectoryOffset + record.centralDirectorySize !== offset
  ) {
    throw invalid("its ZIP directory is inconsistent");
  }

  return record;
};

const BACKSLASH = 0x5c;

// yauzl refuses '..' and absolute names itself and turns backslashes into
// slashes; SheetJS reads the raw bytes, so a backslash (which the ZIP format
// forbids) is refused rather than read two ways. So is a name an Info-ZIP
// Unicode Path field rewrites: yauzl and JSZip would read that name, SheetJS
// the raw one.
const isUnsafeEntryName = (entry) => {
  const name = entry.fileName;

  return (
    typeof name !== "string" ||
    name.length === 0 ||
    name.includes("\0") ||
    entry.fileNameRaw.includes(BACKSLASH) ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").includes("..") ||
    name !== yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, [], false)
  );
};

const isDirectoryName = (name) => name.endsWith("/");

const isXmlPartName = (name) => {
  const lower = name.toLowerCase();

  return lower.endsWith(".xml") || lower.endsWith(".rels");
};

const findExtraField = (fields, id) => fields.find((field) => field.id === id) ?? null;

// A ZIP64 extra field as SheetJS reads it: the first eight bytes are the
// uncompressed size, the next eight the compressed size, whatever the record
// says. yauzl reads only the fields the record saturates. Either way, both
// must come out as the sizes the guard checked.
const zip64ExtraAgrees = (field, entry) => {
  if (!field) {
    return true;
  }

  if (field.data.length < 16) {
    return false;
  }

  const uncompressed = Number(field.data.readBigUInt64LE(0));
  const compressed = Number(field.data.readBigUInt64LE(8));

  return uncompressed === entry.uncompressedSize && compressed === entry.compressedSize;
};

const parseExtraFieldsOrNull = (buffer) => {
  try {
    return yauzl.parseExtraFields(buffer);
  } catch {
    return null;
  }
};

const assertLocalHeaderAgrees = (entry, local) => {
  const localExtraFields = parseExtraFieldsOrNull(local.extraField);
  const sizesRecorded = local.compressedSize !== 0 || local.uncompressedSize !== 0;
  const sizesAgree =
    local.compressedSize === entry.compressedSize && local.uncompressedSize === entry.uncompressedSize;

  if (
    !local.fileName.equals(entry.fileNameRaw) ||
    local.compressionMethod !== entry.compressionMethod ||
    (local.generalPurposeBitFlag & ENCRYPTION_FLAGS) !== 0 ||
    // With a data descriptor the sizes may be left at zero in the local
    // header; anything else recorded there must be the directory's sizes.
    !(sizesAgree || ((local.generalPurposeBitFlag & DATA_DESCRIPTOR_FLAG) !== 0 && !sizesRecorded)) ||
    localExtraFields === null ||
    !zip64ExtraAgrees(findExtraField(localExtraFields, ZIP64_EXTRA_FIELD_ID), entry)
  ) {
    throw invalid("an entry's local header disagrees with its directory record");
  }
};

// '<!DOCTYPE' or '<!ENTITY', any case, in UTF-8 or in UTF-16 of either byte
// order (UTF-16BE text read one byte on is the UTF-16LE pattern). Matched on a
// latin1 view, so a byte is a character.
const DTD_PATTERN =
  /<!(?:doctype|entity)|<\x00!\x00(?:d\x00o\x00c\x00t\x00y\x00p\x00e|e\x00n\x00t\x00i\x00t\x00y)/i;
const DTD_PREFILTERS = Object.freeze([Buffer.from("<!", "latin1"), Buffer.from("<\0!", "latin1")]);
// Longest match minus one byte, kept between chunks so a declaration split
// across two chunks is still seen.
const DTD_TAIL_BYTES = 20;

/** Throws when `window` holds a DTD declaration; returns the tail to keep for the next chunk. */
const scanForDtd = (window) => {
  if (DTD_PREFILTERS.some((prefix) => window.includes(prefix)) && DTD_PATTERN.test(window.toString("latin1"))) {
    throw invalid("an XML part declares a DTD");
  }

  return window.subarray(Math.max(0, window.length - DTD_TAIL_BYTES));
};

const openZip = async (buffer) => {
  try {
    return await yauzl.fromBufferPromise(buffer, {
      decodeStrings: true,
      strictFileNames: false,
      // The guard counts the inflated bytes itself (below), so a lying size
      // runs into the caps (413) instead of stopping at its own record (400).
      validateEntrySizes: false,
    });
  } catch (error) {
    throw invalid("it is not a readable ZIP archive", error);
  }
};

const readDirectory = async (zipfile, limits, endRecord) => {
  const entries = [];
  const seenNames = new Set();
  let declaredBytes = 0;
  let directoryBytes = 0;

  try {
    for await (const entry of zipfile.eachEntry()) {
      const name = entry.fileName;

      if (isUnsafeEntryName(entry)) {
        throw invalid("an entry name is unsafe");
      }

      if (!isDirectoryName(name)) {
        const key = name.toLowerCase();

        // OPC part names are case-insensitive; two entries one parser would
        // take for the same part could be read differently by another.
        if (seenNames.has(key)) {
          throw invalid("two entries share a name");
        }

        seenNames.add(key);
      }

      if ((entry.generalPurposeBitFlag & ENCRYPTION_FLAGS) !== 0) {
        throw invalid("an entry is encrypted");
      }

      if (entry.compressionMethod !== STORED && entry.compressionMethod !== DEFLATED) {
        throw invalid("an entry uses an unsupported compression method");
      }

      declaredBytes += entry.uncompressedSize;

      if (declaredBytes > limits.maxUncompressedBytes) {
        throw tooManyBytes(limits.maxUncompressedBytes);
      }

      if (exceedsRatio(entry.uncompressedSize, entry.compressedSize, limits.maxCompressionRatio)) {
        throw ratioTooHigh(limits.maxCompressionRatio);
      }

      if (isPackageDescriptionPart(name) && entry.uncompressedSize > PACKAGE_PART_MAX_BYTES) {
        throw packagePartTooLarge();
      }

      if (!zip64ExtraAgrees(findExtraField(entry.extraFields, ZIP64_EXTRA_FIELD_ID), entry)) {
        throw invalid("an entry's directory record is inconsistent");
      }

      assertLocalHeaderAgrees(entry, await zipfile.readLocalFileHeaderPromise(entry, { minimal: false }));

      directoryBytes +=
        CENTRAL_HEADER_LENGTH + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
      entries.push(entry);
    }
  } catch (error) {
    if (isDocumentFormatError(error)) {
      throw error;
    }

    // yauzl's own refusals land here: an unsafe name ('..', an absolute
    // path), a damaged directory record, a local header out of bounds.
    throw invalid("its ZIP directory is damaged or names an unsafe path", error);
  }

  // Every record the end record counts, and nothing between them and it: a
  // parser that reads records until the signature stops would otherwise find
  // entries the guard never saw.
  if (entries.length !== endRecord.totalEntries || directoryBytes !== endRecord.centralDirectorySize) {
    throw invalid("its ZIP directory is inconsistent");
  }

  return entries;
};

const inflateEntries = async (zipfile, entries, limits, { keep: shouldKeep, observe }) => {
  const parts = new Map();
  let inflatedBytes = 0;

  for (const entry of entries) {
    const name = entry.fileName;
    const isFile = !isDirectoryName(name);
    const keep = isFile && shouldKeep(name);
    const observer = isFile && observe ? observe(name) : null;
    const scanDtd = isXmlPartName(name);
    const packagePart = isFile && isPackageDescriptionPart(name);
    const chunks = keep ? [] : null;
    let entryBytes = 0;
    let checksum = 0;
    let tail = Buffer.alloc(0);

    try {
      const stream = await zipfile.openReadStreamPromise(entry);

      // Leaving the loop (a cap crossed, a DTD found) destroys the stream, so
      // nothing past that chunk is inflated.
      for await (const chunk of stream) {
        entryBytes += chunk.length;
        inflatedBytes += chunk.length;

        if (inflatedBytes > limits.maxUncompressedBytes) {
          throw tooManyBytes(limits.maxUncompressedBytes);
        }

        if (exceedsRatio(entryBytes, entry.compressedSize, limits.maxCompressionRatio)) {
          throw ratioTooHigh(limits.maxCompressionRatio);
        }

        if (packagePart && entryBytes > PACKAGE_PART_MAX_BYTES) {
          throw packagePartTooLarge();
        }

        checksum = crc32(chunk, checksum);

        if (scanDtd) {
          tail = scanForDtd(tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk);
        }

        observer?.push(chunk);
        chunks?.push(chunk);
      }
    } catch (error) {
      if (isDocumentFormatError(error)) {
        throw error;
      }

      throw invalid("an entry cannot be inflated", error);
    }

    if (entryBytes !== entry.uncompressedSize || (checksum >>> 0) !== (entry.crc32 >>> 0)) {
      throw invalid("an entry's bytes disagree with its directory record");
    }

    observer?.finish();

    if (chunks) {
      parts.set(name, Buffer.concat(chunks, entryBytes));
    }
  }

  return { inflatedBytes, parts };
};

// One entry of an archive the guard has already verified, inflated again:
// its size and checksum were checked, so this reads exactly those bytes.
const inflateVerifiedEntry = async (zipfile, entry) => {
  const chunks = [];
  let length = 0;

  try {
    for await (const chunk of await zipfile.openReadStreamPromise(entry)) {
      length += chunk.length;

      if (length > entry.uncompressedSize) {
        throw invalid("an entry's bytes disagree with its directory record");
      }

      chunks.push(chunk);
    }
  } catch (error) {
    if (isDocumentFormatError(error)) {
      throw error;
    }

    throw invalid("an entry cannot be inflated", error);
  }

  return Buffer.concat(chunks, length);
};

const XML_PARSER_OPTIONS = Object.freeze({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  isArray: (name) => name === "Default" || name === "Override" || name === "Relationship",
  parseAttributeValue: false,
  parseTagValue: false,
  removeNSPrefix: true,
});

/** An XML part's text: UTF-8 (BOM optional) or UTF-16 with a BOM or an '<?' start. */
export const decodeXmlPart = (buffer) => {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  }

  if (buffer.length >= 4 && buffer[0] === 0x3c && buffer[1] === 0x00 && buffer[2] === 0x3f && buffer[3] === 0x00) {
    return new TextDecoder("utf-16le").decode(buffer);
  }

  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x3c && buffer[2] === 0x00 && buffer[3] === 0x3f) {
    return new TextDecoder("utf-16be").decode(buffer);
  }

  return new TextDecoder("utf-8").decode(buffer);
};

const parsePackageXml = (buffer, what) => {
  try {
    return new XMLParser(XML_PARSER_OPTIONS).parse(decodeXmlPart(buffer));
  } catch (error) {
    throw invalid(`its ${what} cannot be read`, error);
  }
};

const asText = (value) => (typeof value === "string" ? value : "");

/** A relationship target as the part name it points at ("word/document.xml"), or null outside the package. */
export const resolvePackageTarget = (target, sourceDirectory = "") => {
  let decoded = asText(target).trim();

  if (!decoded) {
    return null;
  }

  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // A stray '%' is part of the name.
  }

  const absolute = decoded.startsWith("/") ? decoded : `/${sourceDirectory ? `${sourceDirectory}/` : ""}${decoded}`;
  const resolved = path.posix.normalize(absolute).replace(/^\/+/, "");

  return resolved && !resolved.startsWith("..") ? resolved : null;
};

const isMainContentType = (contentType) => {
  const lower = contentType.toLowerCase();

  return lower.includes(".main+xml") || lower.endsWith(".main");
};

/**
 * What the package says about itself: whether it has [Content_Types].xml, its
 * main part (the officeDocument relationship of _rels/.rels: its name, its
 * content type, and whether the archive holds it), and whether its content
 * types declare any main-part type at all. `parts` must hold the two package
 * parts the guard always keeps; `fileNames` the archive's file entries.
 */
export const describeOfficePackage = (parts, fileNames) => {
  const byLowerName = new Map([...parts.keys()].map((name) => [name.toLowerCase(), name]));
  const present = new Set(fileNames.map((name) => name.toLowerCase()));
  const contentTypesName = byLowerName.get(CONTENT_TYPES_PART.toLowerCase());

  if (!contentTypesName) {
    return { declaresMainContentType: false, hasContentTypes: false, mainPart: null };
  }

  const types = parsePackageXml(parts.get(contentTypesName), "content types")?.Types ?? {};
  const defaults = new Map();
  const overrides = new Map();

  for (const entry of Array.isArray(types.Default) ? types.Default : []) {
    const extension = asText(entry?.Extension).trim().toLowerCase();

    if (extension && !defaults.has(extension)) {
      defaults.set(extension, asText(entry.ContentType).trim());
    }
  }

  for (const entry of Array.isArray(types.Override) ? types.Override : []) {
    const partName = resolvePackageTarget(entry?.PartName);

    if (partName && !overrides.has(partName.toLowerCase())) {
      overrides.set(partName.toLowerCase(), asText(entry.ContentType).trim());
    }
  }

  const declaresMainContentType = [...defaults.values(), ...overrides.values()].some(isMainContentType);
  const relationshipsName = byLowerName.get(PACKAGE_RELATIONSHIPS_PART.toLowerCase());
  const relationships = relationshipsName
    ? parsePackageXml(parts.get(relationshipsName), "package relationships")?.Relationships?.Relationship ?? []
    : [];
  const mainTargets = [];

  for (const relationship of Array.isArray(relationships) ? relationships : []) {
    if (
      !OFFICE_DOCUMENT_RELATIONSHIP_TYPES.includes(asText(relationship?.Type).trim()) ||
      asText(relationship?.TargetMode).trim().toLowerCase() === "external"
    ) {
      continue;
    }

    const target = resolvePackageTarget(relationship.Target);

    if (target && !mainTargets.some((name) => name.toLowerCase() === target.toLowerCase())) {
      mainTargets.push(target);
    }
  }

  if (mainTargets.length > 1) {
    throw invalid("the package names more than one main part");
  }

  if (mainTargets.length === 0) {
    return { declaresMainContentType, hasContentTypes: true, mainPart: null };
  }

  const [name] = mainTargets;
  const extension = path.posix.extname(name).slice(1).toLowerCase();
  const contentType = overrides.get(name.toLowerCase()) ?? defaults.get(extension) ?? "";

  return {
    declaresMainContentType,
    hasContentTypes: true,
    mainPart: { contentType, exists: present.has(name.toLowerCase()), name },
  };
};

const isPackageDescriptionPart = (name) => {
  const lower = name.toLowerCase();

  return lower === CONTENT_TYPES_PART.toLowerCase() || lower === PACKAGE_RELATIONSHIPS_PART;
};

/**
 * Scans an Office file's bytes (a Buffer, plaintext) and returns
 *   { entryCount, inflatedBytes, fileNames, partSizes, parts, package, readPart }
 * entryCount: entries in the directory; inflatedBytes: what they inflated to;
 * fileNames: the file entries in directory order; partSizes: Map from each
 * file entry's lower-case name to its inflated size (checked against what it
 * actually inflated to); parts: Map name -> Buffer of every file entry
 * `keep(name)` selects, plus [Content_Types].xml and _rels/.rels, inflated
 * once here so no reader inflates them again; package: describeOfficePackage
 * of those; readPart(name): Promise of one more file entry's bytes (names
 * match without regard to case; null when there is no such entry), inflated
 * again on demand from the verified archive.
 * Throws the coded refusals above.
 *
 * `observe(name)` may return { push(chunk), finish() } to see a file entry's
 * bytes as they inflate, without keeping them (finish runs once the entry
 * passed every check). `limits` overrides single limits ({ maxEntries,
 * maxUncompressedBytes, maxCompressionRatio }); the rest come from the settings.
 */
export const scanOfficeArchive = async (
  buffer,
  { keep = () => false, limits: limitOverrides = {}, observe = null } = {}
) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("scanOfficeArchive needs the file's bytes as a Buffer.");
  }

  const limits = readOfficeArchiveLimits(limitOverrides);
  const endRecord = readEndOfCentralDirectory(buffer);

  // From the end record alone, before a single directory record is read.
  if (endRecord.totalEntries > limits.maxEntries) {
    throw tooManyEntries(limits.maxEntries);
  }

  const zipfile = await openZip(buffer);

  if (zipfile.entryCount !== endRecord.totalEntries) {
    throw invalid("its ZIP directory is inconsistent");
  }

  const entries = await readDirectory(zipfile, limits, endRecord);
  const { inflatedBytes, parts } = await inflateEntries(zipfile, entries, limits, {
    keep: (name) => isPackageDescriptionPart(name) || keep(name),
    observe,
  });
  const files = entries.filter((entry) => !isDirectoryName(entry.fileName));
  const fileNames = files.map((entry) => entry.fileName);
  const filesByLowerName = new Map(files.map((entry) => [entry.fileName.toLowerCase(), entry]));

  return {
    entryCount: entries.length,
    fileNames,
    inflatedBytes,
    package: describeOfficePackage(parts, fileNames),
    partSizes: new Map(files.map((entry) => [entry.fileName.toLowerCase(), entry.uncompressedSize])),
    parts,
    readPart: async (name) => {
      const entry = filesByLowerName.get(String(name ?? "").toLowerCase());

      return entry ? inflateVerifiedEntry(zipfile, entry) : null;
    },
  };
};

/** The inflated size of one XML part (.xml, .rels) of a scanned archive, by name in any case; 0 when absent. */
export const getXmlPartSize = (archive, name) => archive.partSizes.get(String(name ?? "").toLowerCase()) ?? 0;

const xmlTooLarge = (limit, together) =>
  createArchiveTooLargeError(
    together
      ? `its XML parts inflate to more than ${limit} bytes together (RAG_OFFICE_MAX_XML_BYTES)`
      : `an XML part inflates to more than ${limit} bytes (RAG_OFFICE_MAX_XML_BYTES)`
  );

/** 413 DOCUMENT_ARCHIVE_TOO_LARGE for one XML part over RAG_OFFICE_MAX_XML_BYTES (`limit`). */
export const assertXmlPartWithinLimit = (archive, name, limit) => {
  if (getXmlPartSize(archive, name) > limit) {
    throw xmlTooLarge(limit, false);
  }
};

/**
 * RAG_OFFICE_MAX_XML_BYTES (`limits.maxXmlBytes`, else the setting) on the XML
 * the parser of `format` holds in memory, from the sizes the scan verified:
 * mammoth reads a Word document's parts before it converts any of them, so
 * they count together; the PPTX reader parses one slide or notes page at a
 * time, so each XML part counts on its own. A workbook's parts are checked by
 * rag/office/xlsx-plan.js, which knows which of them are worksheets (bounded
 * by RAG_XLSX_MAX_CELLS instead). 413 DOCUMENT_ARCHIVE_TOO_LARGE.
 */
export const assertOfficeXmlWithinLimit = (archive, format, limits = {}) => {
  const limit = limits.maxXmlBytes ?? getOfficeMaxXmlBytes();
  const xmlSizes = [...archive.partSizes].filter(([name]) => isXmlPartName(name)).map(([, size]) => size);

  if (format === "docx") {
    let total = 0;

    for (const size of xmlSizes) {
      total += size;

      if (total > limit) {
        throw xmlTooLarge(limit, true);
      }
    }
  } else if (format === "pptx" && xmlSizes.some((size) => size > limit)) {
    throw xmlTooLarge(limit, false);
  }
};
