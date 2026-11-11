// Rewrites an Office package so it carries no personal details, changing as
// little of what Office wrote as possible: every entry is copied byte for byte
// (local header, compressed data, central directory record) except the parts
// named in REWRITES, which are inflated, edited with the given replacements,
// deflated again and given new sizes and CRCs. Used for the real-Office
// fixtures under server/test/fixtures/office-real/.
//
// Usage: node scrub-office-package.mjs <in> <out> <find>=<replace> [...]
// Each <find>=<replace> applies to the parts docProps/core.xml,
// docProps/app.xml and xl/workbook.xml (where Excel records the folder the
// workbook was saved in). The run fails if a <find> string is still present in
// any part afterwards, compressed or not.
import { readFile, writeFile } from "node:fs/promises";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const REWRITES = new Set(["docProps/core.xml", "docProps/app.xml", "xl/workbook.xml"]);
const [inputPath, outputPath, ...pairs] = process.argv.slice(2);
const replacements = pairs.map((pair) => {
  const index = pair.indexOf("=");

  if (index <= 0) {
    throw new Error(`Replacement "${pair}" is not <find>=<replace>.`);
  }

  return [pair.slice(0, index), pair.slice(index + 1)];
});
const input = await readFile(inputPath);

const findEndOfCentralDirectory = (buffer) => {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  throw new Error("No end of central directory record.");
};

const endOffset = findEndOfCentralDirectory(input);
const entryCount = input.readUInt16LE(endOffset + 10);
const directoryOffset = input.readUInt32LE(endOffset + 16);
const archiveComment = input.subarray(endOffset + 22, endOffset + 22 + input.readUInt16LE(endOffset + 20));
const entries = [];
let cursor = directoryOffset;

for (let index = 0; index < entryCount; index += 1) {
  if (input.readUInt32LE(cursor) !== 0x02014b50) {
    throw new Error(`Bad central directory record at ${cursor}.`);
  }

  const nameLength = input.readUInt16LE(cursor + 28);
  const extraLength = input.readUInt16LE(cursor + 30);
  const commentLength = input.readUInt16LE(cursor + 32);
  const recordLength = 46 + nameLength + extraLength + commentLength;
  const central = Buffer.from(input.subarray(cursor, cursor + recordLength));
  const name = input.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
  const localOffset = central.readUInt32LE(42);
  const flags = central.readUInt16LE(8);

  if (flags & 0x0008) {
    throw new Error(`${name} uses a data descriptor; not handled.`);
  }

  const localNameLength = input.readUInt16LE(localOffset + 26);
  const localExtraLength = input.readUInt16LE(localOffset + 28);
  const localHeaderLength = 30 + localNameLength + localExtraLength;
  const compressedSize = central.readUInt32LE(20);

  entries.push({
    central,
    data: input.subarray(localOffset + localHeaderLength, localOffset + localHeaderLength + compressedSize),
    localHeader: Buffer.from(input.subarray(localOffset, localOffset + localHeaderLength)),
    method: central.readUInt16LE(10),
    name,
  });
  cursor += recordLength;
}

const pieces = [];
const directory = [];
let offset = 0;
let rewritten = 0;

for (const entry of entries) {
  let { central, data, localHeader } = entry;

  if (REWRITES.has(entry.name)) {
    const original = entry.method === 8 ? inflateRawSync(data) : entry.method === 0 ? data : null;

    if (!original) {
      throw new Error(`${entry.name} uses compression method ${entry.method}; not handled.`);
    }

    let text = original.toString("utf8");

    for (const [find, replace] of replacements) {
      text = text.split(find).join(replace);
    }

    if (text !== original.toString("utf8")) {
      const plain = Buffer.from(text, "utf8");
      const compressed = entry.method === 8 ? deflateRawSync(plain, { level: 9 }) : plain;
      const crc = crc32(plain);

      data = compressed;
      for (const header of [localHeader, central]) {
        const base = header === localHeader ? 14 : 16;

        header.writeUInt32LE(crc >>> 0, base);
        header.writeUInt32LE(compressed.length, base + 4);
        header.writeUInt32LE(plain.length, base + 8);
      }
      rewritten += 1;
    }
  }

  central.writeUInt32LE(offset, 42);
  pieces.push(localHeader, data);
  directory.push(central);
  offset += localHeader.length + data.length;
}

const directoryBuffer = Buffer.concat(directory);
const end = Buffer.from(input.subarray(endOffset, endOffset + 22));

end.writeUInt32LE(directoryBuffer.length, 12);
end.writeUInt32LE(offset, 16);

const output = Buffer.concat([...pieces, directoryBuffer, end, archiveComment]);

for (const entry of entries) {
  const index = entries.indexOf(entry);
  const name = entry.name;
  const record = directory[index];
  const localOffset = record.readUInt32LE(42);
  const localHeaderLength = 30 + output.readUInt16LE(localOffset + 26) + output.readUInt16LE(localOffset + 28);
  const stored = output.subarray(localOffset + localHeaderLength, localOffset + localHeaderLength + record.readUInt32LE(20));
  const plain = entry.method === 8 ? inflateRawSync(stored) : stored;

  for (const [find] of replacements) {
    if (plain.includes(find)) {
      throw new Error(`${name} still holds "${find}".`);
    }
  }
}

await writeFile(outputPath, output);
console.log(`${outputPath}: ${entries.length} entries, ${rewritten} rewritten`);
