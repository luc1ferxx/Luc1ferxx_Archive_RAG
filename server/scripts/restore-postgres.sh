#!/usr/bin/env bash
#
# restore-postgres.sh — restores a backup-postgres.sh dump into a target
# database (docs/operations.md "备份与恢复"; the work is in
# server/backup-tools.mjs).
#
#   server/scripts/restore-postgres.sh --database-url <target url> --dump <file>
#                                      [--manifest <file>] [--force] [--dry-run]
#
# * Prints its plan first: the target (host, port, database), the dump and its
#   checksum, the roles and extensions it will create, the pg_restore options.
#   --dry-run stops there.
# * Refuses a dump whose SHA-256 differs from its manifest, and a target that
#   already holds tables (exit 3) unless --force, which restores with
#   --clean --if-exists and so replaces the objects the dump holds.
# * Creates the NOLOGIN roles the row policies name (the tenant and system
#   roles) and the dump's extensions (pgvector) when they are missing, then
#   runs pg_restore --no-owner --exit-on-error --single-transaction: all or
#   nothing, every object owned by the restoring login. Finally it grants the
#   tenant role to that login, as migration 013 did on the original server.
#   Role memberships and passwords are cluster-wide and not in a dump: under
#   the role split the migrator grants the runtime login at start-up.
# * The URL comes from --database-url or BACKUP_DATABASE_URL; server/.env is
#   never read. Use a login that owns the target database (it becomes the
#   owner of every restored table, as the migration login is).
#
# Exit code 0 restored (or --dry-run), 2 an error, 3 a non-empty target.
set -euo pipefail

# shellcheck source=backup-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-common.sh"

exec node "${BACKUP_SERVER_DIR}/backup-tools.mjs" restore \
  --pg-restore "${PG_BIN_DIR_RESOLVED}/pg_restore" \
  "$@"
