// Envelope encryption of tenant file bytes (rag/tenant-encryption.js) and the
// working files of one request or attempt (rag/working-files.js), over a local
// KMS provider in a temp directory: round trips, legacy passthrough, tampering,
// another record's context, destroyed keys, rotation and rewrap, and the
// streaming decoder the ingest store reads slices through.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { configureTenantKmsProvider, resetTenantKmsProvider, TENANT_ENCRYPTION_ERROR_CODES as CODES } from "../rag/kms/index.js";
import { createLocalTenantKmsProvider } from "../rag/kms/local-provider.js";
import {
  resolveTenantKeyScope,
  resolveTenantKeyScopesForErase,
} from "../rag/kms/key-scope.js";
import {
  TENANT_ENVELOPE_MAGIC,
  createTenantBytesDecoder,
  decryptTenantBytes,
  describeTenantEnvelope,
  documentFileContext,
  encryptTenantBytes,
  ingestJobFileContext,
  ingestJobOutputContext,
  isParseableTenantEnvelopeHead,
  isTenantEnvelope,
  maybeEncryptTenantBytes,
  rewrapTenantEnvelope,
  uploadChunkContext,
} from "../rag/tenant-encryption.js";
import {
  createWorkingFileWriter,
  decodeWorkingFileBytes,
  encodeWorkingFileBytes,
  isWorkingFileEnvelope,
  readWorkingFile,
  writeWorkingFile,
} from "../rag/working-files.js";

const MARKER = "zebra-marker-7f3a";
const PLAINTEXT = Buffer.from(`%PDF-1.4 ${MARKER} ${"lorem ipsum ".repeat(200)}`);
const ACME_ANN = documentFileContext({ docId: "doc-1", userId: "ann", workspaceId: "acme" });

let tempRoot;
let kms;

const withEncryption = async (value, callback) => {
  const previous = process.env.TENANT_ENCRYPTION;

  if (value === undefined) {
    delete process.env.TENANT_ENCRYPTION;
  } else {
    process.env.TENANT_ENCRYPTION = value;
  }

  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.TENANT_ENCRYPTION;
    } else {
      process.env.TENANT_ENCRYPTION = previous;
    }
  }
};

const rejectsWithCode = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.equal(error.status, 500);
    return true;
  });

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "tenant-envelope-"));
  kms = createLocalTenantKmsProvider({
    keystoreDirectory: path.join(tempRoot, "keystore"),
    masterKeyFile: path.join(tempRoot, "master.key"),
  });
  configureTenantKmsProvider(kms);
});

after(async () => {
  resetTenantKmsProvider();
  await rm(tempRoot, { force: true, recursive: true });
});

test("an envelope round-trips and holds no plaintext", async () => {
  const sealed = await encryptTenantBytes(PLAINTEXT, ACME_ANN);

  assert.ok(isTenantEnvelope(sealed));
  assert.deepEqual(sealed.subarray(0, TENANT_ENVELOPE_MAGIC.length), TENANT_ENVELOPE_MAGIC);
  assert.equal(sealed[TENANT_ENVELOPE_MAGIC.length], 1, "format version 1");
  assert.ok(!sealed.includes(Buffer.from(MARKER)), "the ciphertext must not contain the plaintext marker");
  assert.ok(!sealed.includes(Buffer.from("acme")) && !sealed.includes(Buffer.from("doc-1")), "no raw ids in the envelope");
  assert.deepEqual(await decryptTenantBytes(sealed, ACME_ANN), PLAINTEXT);

  const described = describeTenantEnvelope(sealed);

  assert.equal(described.keyId, resolveTenantKeyScope({ workspaceId: "acme" }).keyId);
  assert.equal(described.version, 1);
  assert.equal(described.provider, "local");

  const again = await encryptTenantBytes(PLAINTEXT, ACME_ANN);

  assert.notDeepEqual(again, sealed, "every write has its own data key and nonce");
});

test("only bytes whose framing and header parse count as an envelope by their head", async () => {
  const sealed = await encryptTenantBytes(PLAINTEXT, ACME_ANN);
  // The head the maintenance SQL reads: the fixed 12 bytes plus the header.
  const head = (bytes) => bytes.subarray(0, 12 + bytes.readUInt32BE(8));

  assert.equal(isParseableTenantEnvelopeHead(head(sealed), sealed.length), true);
  assert.equal(isParseableTenantEnvelopeHead(sealed, sealed.length), true, "a longer head is fine");
  // A PDF stored with the magic and version in front: "%PDF" read as the
  // header length is far out of range.
  const prefixed = Buffer.concat([TENANT_ENVELOPE_MAGIC, Buffer.from([1]), PLAINTEXT]);

  assert.equal(isParseableTenantEnvelopeHead(prefixed.subarray(0, 4108), prefixed.length), false);
  // A header that is not the envelope's JSON, a wrong version, a value too
  // short for its nonce and tag, a head cut inside the header, plaintext.
  const damaged = Buffer.from(sealed);

  damaged[13] = 0x7b;
  damaged[14] = 0x7b;
  assert.equal(isParseableTenantEnvelopeHead(head(damaged), damaged.length), false);

  const otherVersion = Buffer.from(sealed);

  otherVersion[7] = 2;
  assert.equal(isParseableTenantEnvelopeHead(head(otherVersion), otherVersion.length), false);
  assert.equal(isParseableTenantEnvelopeHead(head(sealed), head(sealed).length + 27), false);
  assert.equal(isParseableTenantEnvelopeHead(head(sealed).subarray(0, 20), sealed.length), false);
  assert.equal(isParseableTenantEnvelopeHead(PLAINTEXT.subarray(0, 64), PLAINTEXT.length), false);
});

test("legacy plaintext passes through unchanged without touching the KMS", async () => {
  const calls = [];
  const spy = new Proxy(kms, {
    get(target, property) {
      const value = target[property];

      return typeof value === "function"
        ? (...args) => {
            calls.push(property);
            return value.apply(target, args);
          }
        : value;
    },
  });

  assert.equal(await decryptTenantBytes(PLAINTEXT, ACME_ANN, { kms: spy }), PLAINTEXT, "the same Buffer");
  assert.equal(await decryptTenantBytes(null, ACME_ANN, { kms: spy }), null);
  assert.deepEqual(await decryptTenantBytes(Buffer.alloc(0), ACME_ANN, { kms: spy }), Buffer.alloc(0));
  assert.deepEqual(await decryptTenantBytes(TENANT_ENVELOPE_MAGIC, ACME_ANN, { kms: spy }), TENANT_ENVELOPE_MAGIC, "shorter than a prefix");
  assert.deepEqual(calls, []);
});

test("maybeEncryptTenantBytes follows TENANT_ENCRYPTION and refuses an unknown value", async () => {
  await withEncryption(undefined, async () => {
    assert.equal(await maybeEncryptTenantBytes(PLAINTEXT, ACME_ANN), PLAINTEXT);
  });
  await withEncryption("off", async () => {
    assert.equal(await maybeEncryptTenantBytes(PLAINTEXT, ACME_ANN), PLAINTEXT);
  });
  await withEncryption(" ON ", async () => {
    assert.ok(isTenantEnvelope(await maybeEncryptTenantBytes(PLAINTEXT, ACME_ANN)));
  });
  await withEncryption("true", async () => {
    await assert.rejects(maybeEncryptTenantBytes(PLAINTEXT, ACME_ANN), { code: "TENANT_ENCRYPTION_MODE_INVALID" });
  });
});

test("a changed byte anywhere fails closed with a coded error", async () => {
  const sealed = await encryptTenantBytes(PLAINTEXT, ACME_ANN);
  const flip = (offset) => {
    const copy = Buffer.from(sealed);

    copy[offset] ^= 0x01;
    return copy;
  };
  const headerLength = sealed.readUInt32BE(8);
  const bodyOffset = 12 + headerLength + 28;

  // The payload, its tag, its nonce.
  await rejectsWithCode(decryptTenantBytes(flip(sealed.length - 1), ACME_ANN), CODES.envelopeAuthFailed);
  await rejectsWithCode(decryptTenantBytes(flip(bodyOffset - 1), ACME_ANN), CODES.envelopeAuthFailed);
  await rejectsWithCode(decryptTenantBytes(flip(12 + headerLength), ACME_ANN), CODES.envelopeAuthFailed);
  // The format version and the framing.
  await rejectsWithCode(decryptTenantBytes(flip(7), ACME_ANN), CODES.envelopeMalformed);
  await rejectsWithCode(decryptTenantBytes(sealed.subarray(0, 40), ACME_ANN), CODES.envelopeMalformed);

  const header = JSON.parse(sealed.subarray(12, 12 + headerLength).toString("utf8"));
  const rebuild = (nextHeader) => {
    const text = Buffer.from(JSON.stringify(nextHeader));
    const length = Buffer.alloc(4);

    length.writeUInt32BE(text.length);
    return Buffer.concat([sealed.subarray(0, 8), length, text, sealed.subarray(12 + headerLength)]);
  };
  const wrapped = Buffer.from(header.w, "base64");

  wrapped[wrapped.length - 1] ^= 0x01;
  await rejectsWithCode(decryptTenantBytes(rebuild({ ...header, w: wrapped.toString("base64") }), ACME_ANN), CODES.keyUnwrapFailed);
  await rejectsWithCode(decryptTenantBytes(rebuild({ ...header, v: 7 }), ACME_ANN), CODES.keyNotFound);
  await rejectsWithCode(decryptTenantBytes(rebuild({ ...header, p: "aws" }), ACME_ANN), CODES.providerMismatch);
  await rejectsWithCode(decryptTenantBytes(rebuild({ ...header, k: "not-a-key" }), ACME_ANN), CODES.envelopeMalformed);
});

test("a ciphertext read as another record fails: another tenant, user, object or kind", async () => {
  const sealed = await encryptTenantBytes(PLAINTEXT, ACME_ANN);

  // Another workspace: the envelope names another tenant's key.
  await rejectsWithCode(
    decryptTenantBytes(sealed, documentFileContext({ docId: "doc-1", userId: "ann", workspaceId: "globex" })),
    CODES.envelopeKeyMismatch
  );
  // The same workspace key, another member, document or kind: the data key's
  // AAD binds the whole context.
  for (const context of [
    documentFileContext({ docId: "doc-1", userId: "bob", workspaceId: "acme" }),
    documentFileContext({ docId: "doc-2", userId: "ann", workspaceId: "acme" }),
    ingestJobFileContext({ jobId: "doc-1", userId: "ann", workspaceId: "acme" }),
  ]) {
    await rejectsWithCode(decryptTenantBytes(sealed, context), CODES.keyUnwrapFailed);
  }

  // A user's personal key is not the workspace's.
  const personal = await encryptTenantBytes(PLAINTEXT, documentFileContext({ docId: "doc-9", userId: "ann" }));

  await rejectsWithCode(
    decryptTenantBytes(personal, documentFileContext({ docId: "doc-9", userId: "ann", workspaceId: "acme" })),
    CODES.envelopeKeyMismatch
  );
  assert.deepEqual(await decryptTenantBytes(personal, documentFileContext({ docId: "doc-9", userId: "ann" })), PLAINTEXT);
});

test("the stage outputs: the PDF keeps the job's context, the others carry their name", async () => {
  const owner = { jobId: "job-1", userId: "ann", workspaceId: "acme" };

  assert.deepEqual(ingestJobOutputContext({ ...owner, output: "document_file" }), ingestJobFileContext(owner));

  const pages = await encryptTenantBytes(Buffer.from("[]"), ingestJobOutputContext({ ...owner, output: "pages" }));

  await rejectsWithCode(
    decryptTenantBytes(pages, ingestJobOutputContext({ ...owner, output: "chunks" })),
    CODES.keyUnwrapFailed
  );
  assert.deepEqual(
    await decryptTenantBytes(pages, ingestJobOutputContext({ ...owner, output: "pages" })),
    Buffer.from("[]")
  );
  assert.notDeepEqual(
    uploadChunkContext({ chunkIndex: 0, sessionId: "s", userId: "ann", workspaceId: "acme" }),
    uploadChunkContext({ chunkIndex: 1, sessionId: "s", userId: "ann", workspaceId: "acme" })
  );
});

test("a destroyed key fails as destroyed; new writes get a new version", async () => {
  const context = documentFileContext({ docId: "doc-d", userId: "dan", workspaceId: "shredded" });
  const sealed = await encryptTenantBytes(PLAINTEXT, context);
  const scope = resolveTenantKeyScope(context);
  const destroyed = await kms.destroyKey(scope.keyId);

  assert.deepEqual(destroyed.destroyedVersions, [1]);
  await rejectsWithCode(decryptTenantBytes(sealed, context), CODES.keyDestroyed);
  await rejectsWithCode(rewrapTenantEnvelope(sealed, context), CODES.keyDestroyed);
  // Final for an ingest attempt: it fails at once rather than spend retries.
  await assert.rejects(decryptTenantBytes(sealed, context), (error) => error.retryable === false);

  const after = await encryptTenantBytes(PLAINTEXT, context);

  assert.equal(describeTenantEnvelope(after).version, 2, "numbering continues after the destroyed versions");
  assert.deepEqual(await decryptTenantBytes(after, context), PLAINTEXT);
  await rejectsWithCode(decryptTenantBytes(sealed, context), CODES.keyDestroyed);
});

test("rotation: old versions stay readable, rewrap moves only the header", async () => {
  const context = documentFileContext({ docId: "doc-r", workspaceId: "rotating" });
  const scope = resolveTenantKeyScope(context);
  const v1 = await encryptTenantBytes(PLAINTEXT, context);
  const rotated = await kms.rotateKey(scope);

  assert.deepEqual({ previousVersion: rotated.previousVersion, version: rotated.version }, { previousVersion: 1, version: 2 });

  const v2 = await encryptTenantBytes(PLAINTEXT, context);

  assert.equal(describeTenantEnvelope(v1).version, 1);
  assert.equal(describeTenantEnvelope(v2).version, 2);
  assert.deepEqual(await decryptTenantBytes(v1, context), PLAINTEXT);
  assert.deepEqual(await decryptTenantBytes(v2, context), PLAINTEXT);

  const rewrapped = await rewrapTenantEnvelope(v1, context);
  const tail = (bytes) => bytes.subarray(12 + bytes.readUInt32BE(8));

  assert.equal(rewrapped.changed, true);
  assert.equal(describeTenantEnvelope(rewrapped.bytes).version, 2);
  assert.deepEqual(tail(rewrapped.bytes), tail(v1), "nonce, tag and ciphertext unchanged");
  assert.deepEqual(await decryptTenantBytes(rewrapped.bytes, context), PLAINTEXT);
  assert.equal((await rewrapTenantEnvelope(v2, context)).changed, false);
  assert.equal((await rewrapTenantEnvelope(PLAINTEXT, context)).changed, false);
});

test("the streaming decoder matches decrypt for every slice size", async () => {
  const sealed = await encryptTenantBytes(PLAINTEXT, ACME_ANN);

  for (const size of [1, 7, 8, 13, 64, 4096, sealed.length]) {
    let contexts = 0;
    const decoder = createTenantBytesDecoder({
      resolveContext: async () => {
        contexts += 1;
        return ACME_ANN;
      },
    });
    const parts = [];

    for (let offset = 0; offset < sealed.length; offset += size) {
      parts.push(await decoder.push(sealed.subarray(offset, offset + size)));
    }

    parts.push(await decoder.finish());
    assert.deepEqual(Buffer.concat(parts), PLAINTEXT, `slices of ${size}`);
    assert.equal(contexts, 1);
    assert.equal(decoder.encrypted, false, "done");
  }

  // Plaintext streams through without a context.
  const plain = createTenantBytesDecoder({
    resolveContext: () => {
      throw new Error("no context for plaintext");
    },
  });
  const plainParts = [];

  for (let offset = 0; offset < PLAINTEXT.length; offset += 5) {
    plainParts.push(await plain.push(PLAINTEXT.subarray(offset, offset + 5)));
  }

  plainParts.push(await plain.finish());
  assert.deepEqual(Buffer.concat(plainParts), PLAINTEXT);

  // A changed byte fails at finish; truncated framing too.
  const tampered = Buffer.from(sealed);

  tampered[tampered.length - 3] ^= 0x10;

  const failing = createTenantBytesDecoder({ resolveContext: async () => ACME_ANN });

  await failing.push(tampered);
  await rejectsWithCode(failing.finish(), CODES.envelopeAuthFailed);

  const truncated = createTenantBytesDecoder({ resolveContext: async () => ACME_ANN });

  await truncated.push(sealed.subarray(0, 30));
  await rejectsWithCode(truncated.finish(), CODES.envelopeMalformed);
});

test("key scopes: workspace, user outside a workspace, unscoped; and what an erase destroys", () => {
  const workspace = resolveTenantKeyScope({ userId: "ann", workspaceId: "acme" });
  const workspaceOnly = resolveTenantKeyScope({ workspaceId: "acme" });
  const user = resolveTenantKeyScope({ userId: "ann" });
  const unscoped = resolveTenantKeyScope({});

  assert.equal(workspace.keyId, workspaceOnly.keyId, "every member shares the workspace key");
  assert.equal(workspace.kind, "workspace");
  assert.equal(user.kind, "user");
  assert.equal(unscoped.kind, "unscoped");
  assert.equal(new Set([workspace.keyId, user.keyId, unscoped.keyId]).size, 3);
  assert.notEqual(resolveTenantKeyScope({ workspaceId: "ACME" }).keyId, workspace.keyId, "ids are exact");
  assert.match(workspace.keyId, /^tk_[0-9a-f]{40}$/);

  assert.deepEqual(
    resolveTenantKeyScopesForErase({ userId: null, workspaceId: "acme" }).destroy.map((scope) => scope.keyId),
    [workspace.keyId]
  );
  assert.deepEqual(resolveTenantKeyScopesForErase({ userId: "ann", workspaceId: "acme" }), {
    destroy: [],
    kept: [workspaceOnly],
  });
  assert.deepEqual(
    resolveTenantKeyScopesForErase({ userId: "ann", workspaceId: "" }).destroy.map((scope) => scope.keyId),
    [user.keyId]
  );
});

test("working files: encrypted on disk with the setting on, plaintext as before with it off", async () => {
  const filePath = path.join(tempRoot, "working.pdf");

  await withEncryption(undefined, async () => {
    assert.equal(encodeWorkingFileBytes(PLAINTEXT), PLAINTEXT);
    await writeWorkingFile(filePath, PLAINTEXT);
    assert.deepEqual(await readFile(filePath), PLAINTEXT, "byte-identical with the setting off");
    assert.deepEqual(await readWorkingFile(filePath), PLAINTEXT);
  });

  await withEncryption("on", async () => {
    await writeWorkingFile(filePath, PLAINTEXT);

    const stored = await readFile(filePath);

    assert.ok(isWorkingFileEnvelope(stored));
    assert.ok(!stored.includes(Buffer.from(MARKER)));
    assert.deepEqual(await readWorkingFile(filePath), PLAINTEXT);

    const writer = await createWorkingFileWriter(filePath, { flags: "w" });

    for (let offset = 0; offset < PLAINTEXT.length; offset += 333) {
      await writer.write(PLAINTEXT.subarray(offset, offset + 333));
    }

    await writer.close();
    assert.ok(!(await readFile(filePath)).includes(Buffer.from(MARKER)));
    assert.deepEqual(await readWorkingFile(filePath), PLAINTEXT);

    const tampered = await readFile(filePath);

    tampered[20] ^= 0x01;
    await writeFile(filePath, tampered);
    await rejectsWithCode(readWorkingFile(filePath), CODES.workingFileUnreadable);

    const aborted = await createWorkingFileWriter(filePath, { flags: "w" });

    await aborted.write(PLAINTEXT);
    await aborted.abort();
    await assert.rejects(readFile(filePath), { code: "ENOENT" });
  });

  // Plaintext written while the setting was on reads back after it goes off
  // (this process still holds the key); plaintext passes through either way.
  const encrypted = await withEncryption("on", () => encodeWorkingFileBytes(PLAINTEXT));

  await withEncryption(undefined, async () => {
    assert.deepEqual(decodeWorkingFileBytes(encrypted), PLAINTEXT);
    assert.equal(decodeWorkingFileBytes(PLAINTEXT), PLAINTEXT);
  });
});
