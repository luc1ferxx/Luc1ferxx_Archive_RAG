#!/usr/bin/env bash
#
# backup-postgres.sh — a pg_dump -Fc of the Archive RAG database plus a JSON
# manifest next to it (docs/operations.md "备份与恢复"; the work is in
# server/backup-tools.mjs).
#
#   server/scripts/backup-postgres.sh --database-url <url> [--out <dir>] [--name <base>]
#                                     [--with-files] [--uploads-dir <dir>]
#                                     [--upload-sessions-dir <dir>] [--data-dir <dir>]
#
# * The URL comes from --database-url or BACKUP_DATABASE_URL in the
#   environment; server/.env is never read. Use the login that owns the tables
#   (the migration login, POSTGRES_MIGRATION_DATABASE_URL, under the role
#   split): the dump and the counts must see every tenant's rows. The password
#   reaches pg_dump through PGPASSWORD, never its command line, and the
#   manifest records host, port and database only.
# * Writes <out>/<base>.dump (custom format, one exported snapshot) and
#   <out>/<base>.manifest.json: when, the applied migrations, every table's
#   row count and every tenant's document counts read in the dump's own
#   snapshot, each admin audit chain's head, the roles the row policies name,
#   and the dump's SHA-256. Default <out>: server/backups (git-ignored);
#   default <base>: archive-rag-<UTC time>.
# * --with-files also writes <base>.files.tar.gz with the state outside
#   PostgreSQL: uploads (UPLOADS_DIRECTORY), upload sessions
#   (UPLOAD_SESSION_DIRECTORY) and the data directory (server/data: the local
#   index, file registry, JSONL stores, traces). The tenant keystore
#   (TENANT_KEYSTORE_DIR, envelope encryption) is left out on purpose -- see
#   the documentation: it is backed up separately or not at all, so erasing a
#   tenant's key also shreds that tenant's bytes in every backup.
#
# Exit code 0 on success, 2 on an error.
set -euo pipefail

# shellcheck source=backup-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-common.sh"

exec node "${BACKUP_SERVER_DIR}/backup-tools.mjs" backup \
  --pg-dump "${PG_BIN_DIR_RESOLVED}/pg_dump" \
  "$@"
