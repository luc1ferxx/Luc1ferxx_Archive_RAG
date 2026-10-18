#!/usr/bin/env node
// Ingests PDFs into the archive from the command line, so a zero-infrastructure
// install does not need a browser to get documents in.
//
// The web workbench's POST /upload does the same thing and works in standalone
// mode too; this exists for the CLI-only product shape and for scripting. It is a
// thin wrapper around ingestDocument() on purpose -- that function owns page
// extraction, chunking, the dense and sparse index writes, profile building and
// the rollback on failure. Reimplementing any of that here would let the CLI and
// the web app drift apart.
//
// It replicates the validations the HTTP route performs *outside* ingestDocument
// (routes/uploads.js), because ingestDocument itself does not validate: handed a
// non-PDF it fails deep inside pdfjs with an opaque error.

import "dotenv/config";

import { stat } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

import { ingestDocument } from "./chat.js";
import { isPdfFileName, hasPdfMagicBytes } from "./routes/helpers.js";
import { isPostgresDatabaseConfigured } from "./rag/config.js";
import { runAsDatabaseSystem } from "./rag/postgres-tenant.js";
import { getRagDataDirectory } from "./rag/storage.js";
import { stopTenantUsageLedger } from "./rag/tenant-usage.js";
import { MAX_DIRECT_UPLOAD_SIZE } from "./upload-policy.js";
import {
  applyStandaloneProfile,
  isStandaloneProfileEnabled,
} from "./standalone-profile.js";

const USAGE = `Usage: node archive-ingest.mjs [options] <file.pdf> [more.pdf ...]

Adds PDFs to the archive so the workbench, the MCP bridge and this CLI all see
them. Prints one JSON object per ingested document.

Options
  --user-id <id>       Owner user id. Default: $ARCHIVE_MCP_USER_ID, else empty.
  --workspace-id <id>  Workspace id. Default: $ARCHIVE_MCP_WORKSPACE_ID, else empty.
  --help               Show this message.

Both id options accept --flag value and --flag=value. Leaving them empty makes a
document visible to every access scope, which is what a single-user install wants.

Storage
  Documents go to RAG_DATA_DIRECTORY (currently ${getRagDataDirectory()}).
  The API server and the MCP server must resolve the SAME directory or they will
  not see what this command ingests.

  Your source PDF is not modified, moved, or deleted -- its bytes are copied into
  the archive.

Zero infrastructure
  Set DOCCOMPARE_STANDALONE=1 to store documents as files instead of in
  PostgreSQL. Without it this command writes to PostgreSQL, exactly like the web
  workbench does.

Caveats
  There is no duplicate detection: ingesting the same PDF twice produces two
  documents with different ids. Ingesting concurrently with the web server can
  interleave writes to the shared index files, so prefer one writer at a time.
`;

const OPTIONS_WITH_VALUES = new Set(["--user-id", "--workspace-id"]);

const parseArgs = (argv) => {
  const filePaths = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      return {
        help: true,
      };
    }

    if (argument.startsWith("--")) {
      const separatorIndex = argument.indexOf("=");
      const name = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);

      if (!OPTIONS_WITH_VALUES.has(name)) {
        throw new Error(`Unknown option "${name}". Run with --help.`);
      }

      if (separatorIndex === -1) {
        const value = argv[index + 1];

        if (value === undefined || value.startsWith("--")) {
          throw new Error(`Option "${name}" needs a value.`);
        }

        options[name] = value;
        index += 1;
      } else {
        options[name] = argument.slice(separatorIndex + 1);
      }

      continue;
    }

    filePaths.push(argument);
  }

  return {
    filePaths,
    ownerUserId: options["--user-id"] ?? process.env.ARCHIVE_MCP_USER_ID ?? "",
    workspaceId: options["--workspace-id"] ?? process.env.ARCHIVE_MCP_WORKSPACE_ID ?? "",
  };
};

// The same four checks POST /upload applies before it reaches ingestDocument.
// Reporting which one failed matters more here than over HTTP: there is no
// browser to show a friendlier message.
const validatePdf = async (filePath) => {
  const fileName = path.basename(filePath);
  let stats = null;

  try {
    stats = await stat(filePath);
  } catch (error) {
    throw new Error(
      error.code === "ENOENT" ? `No such file: ${filePath}` : `Cannot read ${filePath}: ${error.message}`
    );
  }

  if (!stats.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  if (!isPdfFileName(fileName)) {
    throw new Error(`Not an acceptable PDF file name: ${fileName}`);
  }

  if (stats.size > MAX_DIRECT_UPLOAD_SIZE) {
    throw new Error(
      `${fileName} is ${stats.size} bytes, over the ${MAX_DIRECT_UPLOAD_SIZE} byte limit.`
    );
  }

  if (!(await hasPdfMagicBytes(filePath))) {
    throw new Error(`${fileName} does not contain a %PDF header, so it is not a PDF.`);
  }

  return {
    fileName,
    fileSize: stats.size,
  };
};

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    console.log(USAGE);
    return;
  }

  if (parsed.filePaths.length === 0) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const standalone = isStandaloneProfileEnabled();

  // Must happen before the first ingest: ingestDocument reaches
  // registerDocument, which initializes whichever registry store is configured at
  // that moment. Applying the profile afterwards would silently leave the
  // PostgreSQL store installed.
  if (standalone) {
    applyStandaloneProfile();
  } else if (!isPostgresDatabaseConfigured()) {
    // Otherwise the first thing the user sees is a PostgreSQL connection failure
    // from a database they never meant to run.
    console.error(
      "No storage is configured. Set DOCCOMPARE_STANDALONE=1 to store documents as\n" +
        "files, or set POSTGRES_DATABASE_URL to use PostgreSQL. Run with --help."
    );
    process.exitCode = 1;
    return;
  }

  console.error(
    standalone
      ? `Ingesting into ${getRagDataDirectory()} (standalone: files, no PostgreSQL)`
      : "Ingesting into PostgreSQL"
  );

  let failures = 0;

  for (const rawFilePath of parsed.filePaths) {
    const filePath = path.resolve(process.cwd(), rawFilePath);

    try {
      const { fileName } = await validatePdf(filePath);
      const document = await ingestDocument({
        docId: randomUUID(),
        filePath,
        fileName,
        ownerUserId: String(parsed.ownerUserId).trim(),
        workspaceId: String(parsed.workspaceId).trim(),
      });

      console.log(
        JSON.stringify(
          {
            docId: document.docId,
            fileName: document.fileName,
            pageCount: document.pageCount,
            chunkCount: document.chunkCount,
            storageBackend: document.storageBackend,
          },
          null,
          2
        )
      );
    } catch (error) {
      // Keep going: one unreadable PDF in a batch should not discard the ones
      // that already succeeded, and ingestDocument has already rolled back its
      // own index writes for the failed one.
      failures += 1;
      console.error(`Failed: ${path.basename(filePath)} -- ${error.message}`);
    }
  }

  if (failures > 0) {
    console.error(
      `${failures} of ${parsed.filePaths.length} file(s) failed to ingest.`
    );
    process.exitCode = 1;
  }
};

try {
  // An operator command that writes as the owner, as it always has (the
  // owner columns carry --user-id / --workspace-id); bound explicitly so
  // POSTGRES_TENANT_CONTEXT=strict accepts it.
  await runAsDatabaseSystem(() => main());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  // What the ingests recorded in the tenant usage ledger (ingested bytes,
  // documents, embedding tokens) waits in memory for a flush timer that does
  // not keep the process alive: write it before the command ends.
  try {
    await stopTenantUsageLedger();
  } catch (error) {
    console.error(`Failed to flush tenant usage: ${error instanceof Error ? error.message : error}`);
  }
}
