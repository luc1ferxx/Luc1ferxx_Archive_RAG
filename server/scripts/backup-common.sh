#!/usr/bin/env bash
#
# backup-common.sh — shared by backup-postgres.sh, restore-postgres.sh and
# verify-backup.sh (sourced, not run). Finds the PostgreSQL client binaries the
# way run-pgvector-integration.sh does: PG_BIN_DIR when set, else the newest
# Postgres.app install, else whatever is on PATH. pg_dump must be at least the
# server's major version; pg_restore at least pg_dump's.

backup_log() { printf '[backup] %s\n' "$*" >&2; }
backup_fail() { backup_log "ERROR: $*"; exit 2; }

BACKUP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SERVER_DIR="$(cd "${BACKUP_SCRIPT_DIR}/.." && pwd)"

resolve_pg_bin_dir() {
  if [[ -n "${PG_BIN_DIR:-}" ]]; then
    printf '%s\n' "${PG_BIN_DIR}"
    return 0
  fi

  local candidate
  candidate="$(ls -d /Applications/Postgres.app/Contents/Versions/*/bin 2>/dev/null | sort -t/ -k6 -rn | head -n1 || true)"
  if [[ -n "${candidate}" && -x "${candidate}/pg_dump" ]]; then
    printf '%s\n' "${candidate}"
    return 0
  fi

  if command -v pg_dump >/dev/null 2>&1; then
    dirname "$(command -v pg_dump)"
    return 0
  fi

  return 1
}

PG_BIN_DIR_RESOLVED="$(resolve_pg_bin_dir)" \
  || backup_fail "could not find the PostgreSQL client binaries; set PG_BIN_DIR to a directory holding pg_dump and pg_restore"

command -v node >/dev/null 2>&1 || backup_fail "node is required (the manifest and the checks run in Node)"
