#!/usr/bin/env node
// Backfills or rebuilds the pgvector index from an existing archive.
//
// Switching VECTOR_STORE_PROVIDER to pgvector does not move any data: the
// documents stay registered in PostgreSQL while their chunks and vectors live in
// the old backend (a local vector-index.json, or a Qdrant collection). Without
// this command the new default answers every question against an empty index,
// which is exactly the failure the health check flags. This is the migration
// path, and it is a dry run unless --apply is passed.
//
// Sources
//   --from local      copy chunks and their stored vectors out of
//                     RAG_DATA_DIRECTORY/vector-index.json
//   --from qdrant     scroll the configured Qdrant collection and copy its
//                     dense vectors and payloads
//   --from documents  re-chunk and re-embed every registered document from the
//                     PDF bytes held in the PostgreSQL registry (the path to use
//                     after changing OPENAI_EMBEDDING_MODEL)
//
// Stored vectors (local and qdrant) carry no embedding-model provenance, so a
// same-width vector could have come from a different model. To avoid stamping a
// mislabelled model onto copied rows, this command re-embeds by default and only
// reuses stored vectors when --trust-source-embeddings attests that the source
// was produced by the currently configured embedding model.
//
// A dry run (the default) is strictly read-only: it probes status, reads the
// registry, and counts existing chunks with plain SELECTs. It never runs a
// migration, ALTER, index creation, or write. The schema is created and rows are
// written only under --apply.
//
// Every document is written in its own transaction, replacing whatever the
// pgvector table held for that docId, so a crash midway leaves each document
// either fully migrated or untouched.

import "dotenv/config";

import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

import { chunkDocument } from "./rag/chunker.js";
import {
  getEmbeddingDimensions,
  getEmbeddingModel,
  getVectorStoreProviderConfigStatus,
} from "./rag/config.js";
import { PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS } from "./rag/db-migrations.js";
import {
  getDocumentFile,
  initializeDocumentRegistry,
  listDocuments,
  readDocumentRegistrySnapshot,
} from "./rag/doc-registry.js";
import { buildPublicFilePath } from "./rag/document-utils.js";
import { loadPdfPages } from "./rag/pdf-loader.js";
import { withPostgresTransaction } from "./rag/postgres.js";
import { getRagDataPath, readJsonFileSync } from "./rag/storage.js";
import {
  buildSearchText,
  countPgvectorChunks,
  describePgvectorStatus,
  ensurePgvectorSchema,
  prepareDocumentsForPgvectorIndex,
  writeDocumentsToPgvectorIndex,
} from "./rag/vector-store-pgvector.js";

const USAGE = `Usage: node vector-reindex.mjs [--from local|qdrant|documents] [--apply] [--doc-id <id>]... [--trust-source-embeddings]

Backfills the pgvector index (VECTOR_STORE_PROVIDER=pgvector) from an existing
archive. Prints a per-document plan. The default is a strictly read-only dry run;
nothing is written and no schema is created unless --apply is given.

Options
  --from <source>            local (default), qdrant, or documents. See the header comment.
  --apply                    Execute the plan. Without it this is a read-only dry run.
  --doc-id <id>              Limit the plan to one document; repeatable.
  --trust-source-embeddings  Reuse stored vectors of the configured width instead of
                             re-embedding. Only pass this when the stored vectors were
                             produced by the configured embedding model; the stored
                             index records no model, so the tool cannot verify it.
  --help                     Show this message.
`;

export const parseArgs = (argv) => {
  const options = {
    apply: false,
    docIds: [],
    from: "local",
    help: false,
    trustSourceEmbeddings: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--trust-source-embeddings") {
      options.trustSourceEmbeddings = true;
    } else if (arg === "--from" || arg.startsWith("--from=")) {
      const value = arg.includes("=") ? arg.slice("--from=".length) : argv[++index];
      options.from = String(value ?? "").trim().toLowerCase();
    } else if (arg === "--doc-id" || arg.startsWith("--doc-id=")) {
      const value = arg.includes("=") ? arg.slice("--doc-id=".length) : argv[++index];
      options.docIds.push(String(value ?? "").trim());
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!["local", "qdrant", "documents"].includes(options.from)) {
    throw new Error(`--from must be local, qdrant, or documents. Received "${options.from}".`);
  }

  return options;
};

const toChunkDocument = (entry) => ({
  id: String(entry.id),
  metadata: entry.metadata ?? {},
  pageContent: String(entry.pageContent ?? ""),
});

const readLocalEntries = () => {
  const indexPath = getRagDataPath("vector-index.json");
  const entries = readJsonFileSync(indexPath, []);

  return {
    entries: (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry?.id && entry?.metadata?.docId && Array.isArray(entry.vector))
      .map((entry) => ({
        ...toChunkDocument(entry),
        vector: entry.vector.map((value) => Number(value) || 0),
      })),
    sourceLabel: indexPath,
  };
};

const readQdrantEntries = async () => {
  const [{ QdrantClient }, config] = await Promise.all([
    import("@qdrant/js-client-rest"),
    import("./rag/config.js"),
  ]);
  const client = new QdrantClient({
    apiKey: config.getQdrantApiKey().trim() || undefined,
    url: config.getQdrantUrl(),
  });
  const collection = config.getQdrantCollection();
  const entries = [];
  let offset = undefined;

  while (true) {
    const page = await client.scroll(collection, {
      limit: 256,
      offset,
      with_payload: true,
      with_vector: true,
    });

    for (const point of page?.points ?? []) {
      const payload = point.payload ?? {};
      const vector = Array.isArray(point.vector?.dense) ? point.vector.dense : null;

      if (!payload.docId || !vector) {
        continue;
      }

      entries.push({
        id: String(point.id),
        metadata: {
          docId: payload.docId,
          fileName: payload.fileName,
          filePath: payload.filePath,
          publicFilePath: payload.publicFilePath,
          pageNumber: payload.pageNumber ?? null,
          chunkIndex: payload.chunkIndex ?? null,
          sectionHeading: payload.sectionHeading ?? null,
          ...(payload.source ? { source: payload.source } : {}),
        },
        pageContent: String(payload.pageContent ?? ""),
        vector: vector.map((value) => Number(value) || 0),
      });
    }

    offset = page?.next_page_offset;

    if (!offset || (page?.points ?? []).length === 0) {
      break;
    }
  }

  return { entries, sourceLabel: `${config.getQdrantUrl()} / ${collection}` };
};

const groupByDocId = (entries) => {
  const byDocId = new Map();

  for (const entry of entries) {
    const docId = String(entry.metadata?.docId ?? "").trim();

    if (!docId) {
      continue;
    }

    if (!byDocId.has(docId)) {
      byDocId.set(docId, []);
    }

    byDocId.get(docId).push(entry);
  }

  return byDocId;
};

/**
 * Stored vectors are reused only when two conditions hold together: they
 * already have the configured width, AND the operator attested the source model
 * with --trust-source-embeddings. Width alone is not enough — text-embedding-3-
 * small and ada-002 are both 1536-wide but not interchangeable, and the stored
 * index records no model to tell them apart, so an unattested copy would stamp
 * the currently configured model onto vectors that may have come from another
 * one. Anything not reusable is re-embedded from the stored chunk text, which is
 * always correct for the configured model. (A width mismatch, e.g. copying a
 * 1536-wide vector into a 3072-wide column, is never a migration, it is
 * corruption, so it is re-embedded regardless of the trust flag.)
 */
export const prepareFromStoredVectors = async (
  entries,
  { trustSourceEmbeddings = false, prepare = prepareDocumentsForPgvectorIndex } = {}
) => {
  const expected = getEmbeddingDimensions();
  const reusable =
    trustSourceEmbeddings && entries.every((entry) => entry.vector.length === expected);

  if (reusable) {
    return {
      preparedDocuments: entries.map((entry) => ({
        id: entry.id,
        metadata: entry.metadata,
        pageContent: entry.pageContent,
        searchText: buildSearchText(entry),
        vector: entry.vector,
      })),
      reembedded: false,
    };
  }

  return {
    preparedDocuments: await prepare({
      documents: entries.map(toChunkDocument),
    }),
    reembedded: true,
  };
};

const prepareFromDocumentBytes = async (document) => {
  const stored = await getDocumentFile(document.docId);

  if (!stored?.fileBuffer) {
    throw new Error(`No PDF bytes are stored for ${document.docId}.`);
  }

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vector-reindex-"));
  const tempPath = path.join(tempDirectory, "document.pdf");

  try {
    await writeFile(tempPath, stored.fileBuffer);
    const pages = await loadPdfPages(tempPath);
    const chunks = chunkDocument({
      docId: document.docId,
      fileName: document.fileName,
      publicFilePath: buildPublicFilePath(document.docId),
      pages,
      source: document.source ?? null,
    });

    return {
      preparedDocuments: await prepareDocumentsForPgvectorIndex({
        documents: chunks.map(toChunkDocument),
      }),
      reembedded: true,
    };
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
};

// PostgreSQL SQLSTATE 42P01 = undefined_table. A dry run against a database
// whose registry table has not been created yet hits this on a plain SELECT; we
// report it and continue with an empty plan rather than creating the table.
// Every other error (auth 28P01, connection refused, etc.) still propagates.
const isMissingRelationError = (error) => error?.code === "42P01";

export const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const providerStatus = getVectorStoreProviderConfigStatus();

  if (!providerStatus.valid || providerStatus.provider !== "pgvector") {
    throw new Error(
      `vector:reindex writes the pgvector index, but VECTOR_STORE_PROVIDER resolves to "${
        providerStatus.rawValue || providerStatus.provider
      }". Set VECTOR_STORE_PROVIDER=pgvector first.`
    );
  }

  // Read-only probe. describePgvectorStatus() is the non-throwing status
  // surface; unlike ensurePgvectorSchema() it never creates or alters the
  // schema, so it is safe in a dry run.
  const status = await describePgvectorStatus();

  if (status.configured && status.reachable === false) {
    throw new Error(
      `pgvector is configured but not reachable${
        status.error ? `: ${status.error}` : ""
      }. Nothing was changed.`
    );
  }

  const tableExists = status.table?.exists === true;
  const configuredDimensions = getEmbeddingDimensions();
  const annSupported = status.annDimensionsSupported !== false;

  // Load the registry WITHOUT migrations so a dry run alters nothing. In apply
  // mode the schema is created first (below), which also refreshes this map
  // with any legacy rows the migration imports.
  let registryUnavailable = false;

  try {
    await readDocumentRegistrySnapshot();
  } catch (error) {
    if (!options.apply && isMissingRelationError(error)) {
      registryUnavailable = true;
    } else {
      throw error;
    }
  }

  let registered = registryUnavailable
    ? new Map()
    : new Map(listDocuments().map((document) => [document.docId, document]));
  const wanted = new Set(options.docIds.filter(Boolean));
  const plan = [];

  // Chunk counts are read only when the table exists; on a fresh database the
  // count is zero without touching the schema.
  const countExisting = async (docId) =>
    tableExists ? countPgvectorChunks({ docIds: [docId] }) : 0;

  if (options.from === "documents") {
    for (const document of registered.values()) {
      if (wanted.size > 0 && !wanted.has(document.docId)) {
        continue;
      }

      plan.push({
        action: "reembed",
        docId: document.docId,
        existingChunkCount: await countExisting(document.docId),
        fileName: document.fileName,
        source: "documents",
        sourceChunkCount: document.chunkCount ?? null,
      });
    }
  } else {
    const { entries, sourceLabel } =
      options.from === "qdrant" ? await readQdrantEntries() : readLocalEntries();
    const byDocId = groupByDocId(entries);

    process.stdout.write(`Source: ${sourceLabel} (${entries.length} chunk(s), ${byDocId.size} document(s))\n`);

    for (const [docId, docEntries] of byDocId) {
      if (wanted.size > 0 && !wanted.has(docId)) {
        continue;
      }

      const document = registered.get(docId) ?? null;
      const widthMatches = docEntries.every((entry) => entry.vector.length === configuredDimensions);
      // Reuse stored vectors only when the width matches AND the operator has
      // attested the source model. Without attestation a same-width vector is
      // re-embedded so it can never be mislabelled with the configured model.
      const canCopy = widthMatches && options.trustSourceEmbeddings;

      plan.push({
        action: document
          ? canCopy
            ? "copy"
            : "reembed"
          : "skip_missing_registry_row",
        docId,
        existingChunkCount: await countExisting(docId),
        fileName: document?.fileName ?? docEntries[0]?.metadata?.fileName ?? null,
        source: options.from,
        sourceChunkCount: docEntries.length,
        widthMatches,
        entries: docEntries,
      });
    }
  }

  process.stdout.write(
    `Target: pgvector table ${status.table?.name ?? "?"}, embedding model ${getEmbeddingModel()} (${configuredDimensions} dims)\n`
  );

  if (registryUnavailable) {
    process.stdout.write(
      "Note: the PostgreSQL document registry table does not exist yet; --apply will create it.\n"
    );
  }

  if (!annSupported) {
    process.stdout.write(
      `WARNING: ${configuredDimensions} dimensions exceed pgvector's ANN limit of ${PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS}. ` +
        `--apply will fail closed when creating the schema; choose an embedding model of ${PGVECTOR_VECTOR_INDEX_MAX_DIMENSIONS} dimensions or fewer.\n`
    );
  }

  process.stdout.write(`Mode: ${options.apply ? "APPLY" : "dry run (read-only; pass --apply to write)"}\n\n`);

  for (const item of plan) {
    const note =
      item.source !== "documents" && item.action === "reembed" && item.widthMatches
        ? "  (width matches; re-embedding because the source model is unattested — pass --trust-source-embeddings to copy)"
        : item.action === "copy"
          ? "  (copying stored vectors; source model attested)"
          : "";
    process.stdout.write(
      `${item.action.padEnd(26)} ${item.docId}  ${item.fileName ?? ""}  source=${item.sourceChunkCount ?? "?"} chunk(s), already indexed=${item.existingChunkCount}${note}\n`
    );
  }

  if (plan.length === 0) {
    process.stdout.write("Nothing to do: the source holds no documents.\n");
    return;
  }

  if (!options.apply) {
    // A dry run stops here having created nothing: no schema, no ALTER, no
    // index, no rows. Every read above (status, registry snapshot, chunk
    // counts) is a plain SELECT.
    return;
  }

  // --- APPLY: from here on the schema may be created and rows written. ---
  // ensurePgvectorSchema() runs the migrations and fails closed when the
  // configured dimensions exceed the ANN ceiling, before any document is read.
  // Chunks stored under another embedding model or task prefix do not stop
  // it: replacing them document by document is what this command is for, and
  // until every one is rewritten the server keeps refusing the table.
  // initializeDocumentRegistry() then refreshes the map authoritatively,
  // including any legacy rows the migration imported.
  await ensurePgvectorSchema({ allowForeignEmbeddings: true });
  await initializeDocumentRegistry();
  registered = new Map(listDocuments().map((document) => [document.docId, document]));

  let written = 0;

  for (const item of plan) {
    if (item.action === "skip_missing_registry_row") {
      process.stdout.write(
        `skip   ${item.docId}: not registered in PostgreSQL, the chunk table's foreign key needs the document row first.\n`
      );
      continue;
    }

    const document = registered.get(item.docId);

    if (!document) {
      // The registry changed between planning and apply, or the row is gone.
      // Skip rather than write chunks with an empty owner/workspace scope.
      process.stdout.write(
        `skip   ${item.docId}: no longer registered in PostgreSQL at apply time.\n`
      );
      continue;
    }

    const prepared = item.entries
      ? await prepareFromStoredVectors(item.entries, {
          trustSourceEmbeddings: options.trustSourceEmbeddings,
        })
      : await prepareFromDocumentBytes(document);

    await withPostgresTransaction(async (client) => {
      await writeDocumentsToPgvectorIndex({
        accessScope: {
          userId: document.ownerUserId ?? "",
          workspaceId: document.workspaceId ?? "",
        },
        client,
        preparedDocuments: prepared.preparedDocuments,
      });
    });

    written += prepared.preparedDocuments.length;
    process.stdout.write(
      `wrote  ${item.docId}: ${prepared.preparedDocuments.length} chunk(s)${
        prepared.reembedded ? " (re-embedded)" : " (vectors copied)"
      }\n`
    );
  }

  process.stdout.write(`\nDone. ${written} chunk(s) written to pgvector.\n`);
};

// Run only when invoked as a script (node vector-reindex.mjs ...). Importing the
// module for tests must not execute the migration, so the entry-point check
// compares this module's URL against the process entry file.
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
