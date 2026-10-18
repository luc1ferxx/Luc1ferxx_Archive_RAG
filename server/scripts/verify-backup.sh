#!/usr/bin/env bash
#
# verify-backup.sh — the restore drill: restores a backup-postgres.sh dump
# into a fresh disposable PostgreSQL cluster (or an empty database you name)
# and checks it (docs/operations.md "备份与恢复"; `npm run backup:verify`).
#
#   server/scripts/verify-backup.sh --dump <file> [--manifest <file>]
#                                   [--database-url <url of an EMPTY scratch database>]
#                                   [--allow-pending-migrations] [--keep-cluster]
#
# Checks (server/backup-tools.mjs verify), each must pass:
#   * the dump's SHA-256 equals the manifest's;
#   * every migration file of this code is applied, none unknown, and the
#     applied list equals the manifest's (--allow-pending-migrations accepts a
#     dump from older code whose remaining migrations the app would apply);
#   * every table's row count and every tenant's document counts (active and
#     in the trash) equal the manifest's;
#   * the health report's rowLevelSecurity check reports no error (roles,
#     policies, grants, the role switch);
#   * every admin audit chain verifies (audit:verify's code) and ends at the
#     head the manifest recorded.
#
# Without --database-url the cluster is like run-pgvector-integration.sh's:
# a new data directory under $TMPDIR, PostgreSQL from PG_BIN_DIR or the newest
# Postgres.app, pgvector required. It listens on a unix socket only (no TCP
# port), in a private 0700 directory under /tmp (a socket path must stay under
# 104 bytes, which a long $TMPDIR exceeds), with trust authentication: only
# this user can reach the socket, so no password exists anywhere. Both
# directories are deleted on exit (--keep-cluster leaves them for inspection). The restore runs as a
# non-superuser login that owns the scratch database, as in production.
#
# Prints the JSON report; exit 0 when every check passed, 1 when one failed,
# 2 on an error.
set -euo pipefail

# shellcheck source=backup-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-common.sh"

DUMP=""
MANIFEST=""
DATABASE_URL_ARG=""
KEEP_CLUSTER=0
VERIFY_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump) DUMP="${2:-}"; shift 2 ;;
    --dump=*) DUMP="${1#*=}"; shift ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --manifest=*) MANIFEST="${1#*=}"; shift ;;
    --database-url) DATABASE_URL_ARG="${2:-}"; shift 2 ;;
    --database-url=*) DATABASE_URL_ARG="${1#*=}"; shift ;;
    --keep-cluster) KEEP_CLUSTER=1; shift ;;
    --allow-pending-migrations) VERIFY_ARGS+=("--allow-pending-migrations"); shift ;;
    -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) backup_fail "unknown argument: $1" ;;
  esac
done

[[ -n "${DUMP}" ]] || backup_fail "--dump <file> is required"
[[ -f "${DUMP}" ]] || backup_fail "no such dump: ${DUMP}"
if [[ -z "${MANIFEST}" ]]; then
  MANIFEST="${DUMP%.dump}.manifest.json"
fi
[[ -f "${MANIFEST}" ]] || backup_fail "no manifest next to the dump (${MANIFEST}); pass --manifest"

STARTED_SERVER=0
WORK_DIR=""
SOCK_DIR=""
cleanup() {
  local status=$?
  if [[ "${STARTED_SERVER}" -eq 1 && "${KEEP_CLUSTER}" != "1" ]]; then
    "${PG_BIN_DIR_RESOLVED}/pg_ctl" -D "${WORK_DIR}/data" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ -n "${WORK_DIR}" ]]; then
    if [[ "${KEEP_CLUSTER}" == "1" ]]; then
      backup_log "--keep-cluster: the cluster stays at ${WORK_DIR} (socket in ${SOCK_DIR}); remove both when done"
    else
      rm -rf "${WORK_DIR}" "${SOCK_DIR}" 2>/dev/null || true
    fi
  fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

if [[ -n "${DATABASE_URL_ARG}" ]]; then
  TARGET_URL="${DATABASE_URL_ARG}"
else
  for tool in initdb pg_ctl psql pg_isready postgres; do
    [[ -x "${PG_BIN_DIR_RESOLVED}/${tool}" ]] || backup_fail "missing executable: ${PG_BIN_DIR_RESOLVED}/${tool}"
  done

  PG_SHARE_DIR="$(cd "${PG_BIN_DIR_RESOLVED}/.." && pwd)/share/postgresql"
  [[ -f "${PG_SHARE_DIR}/extension/vector.control" ]] || PG_SHARE_DIR="$(cd "${PG_BIN_DIR_RESOLVED}/.." && pwd)/share"
  [[ -f "${PG_SHARE_DIR}/extension/vector.control" ]] \
    || backup_fail "pgvector is not installed for ${PG_BIN_DIR_RESOLVED}; the restored database needs it"

  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/archive-rag-verify.XXXXXX")"
  SOCK_DIR="$(mktemp -d /tmp/arv-sock.XXXXXX)"
  chmod 700 "${WORK_DIR}" "${SOCK_DIR}"
  SOCKET_PORT=5432
  RESTORE_LOGIN="archive_rag_restore"
  SCRATCH_DB="archive_rag_verify"

  backup_log "disposable cluster in ${WORK_DIR} ($("${PG_BIN_DIR_RESOLVED}/postgres" --version))"
  "${PG_BIN_DIR_RESOLVED}/initdb" -D "${WORK_DIR}/data" -U postgres -A trust -E UTF8 --no-locale \
    >"${WORK_DIR}/initdb.log" 2>&1 || { cat "${WORK_DIR}/initdb.log" >&2; backup_fail "initdb failed"; }
  "${PG_BIN_DIR_RESOLVED}/pg_ctl" -D "${WORK_DIR}/data" -l "${WORK_DIR}/postgres.log" -w -t 60 \
    -o "-p ${SOCKET_PORT} -k ${SOCK_DIR} -c listen_addresses='' -c fsync=off -c full_page_writes=off" \
    start >/dev/null 2>&1 || { cat "${WORK_DIR}/postgres.log" >&2; backup_fail "pg_ctl start failed"; }
  STARTED_SERVER=1

  psql_admin() {
    "${PG_BIN_DIR_RESOLVED}/psql" -h "${SOCK_DIR}" -p "${SOCKET_PORT}" -U postgres -v ON_ERROR_STOP=1 -q "$@"
  }
  psql_admin -d postgres -c "CREATE ROLE ${RESTORE_LOGIN} LOGIN CREATEROLE"
  psql_admin -d postgres -c "CREATE DATABASE ${SCRATCH_DB} OWNER ${RESTORE_LOGIN}"
  # pgvector needs a superuser to install; the restore then finds it.
  psql_admin -d "${SCRATCH_DB}" -c "CREATE EXTENSION IF NOT EXISTS vector"

  TARGET_URL="postgresql://${RESTORE_LOGIN}@localhost:${SOCKET_PORT}/${SCRATCH_DB}?host=${SOCK_DIR}"
fi

backup_log "restoring ${DUMP}"
node "${BACKUP_SERVER_DIR}/backup-tools.mjs" restore \
  --pg-restore "${PG_BIN_DIR_RESOLVED}/pg_restore" \
  --database-url "${TARGET_URL}" \
  --dump "${DUMP}" \
  --manifest "${MANIFEST}"

backup_log "verifying the restored database"
set +e
node "${BACKUP_SERVER_DIR}/backup-tools.mjs" verify \
  --database-url "${TARGET_URL}" \
  --dump "${DUMP}" \
  --manifest "${MANIFEST}" \
  ${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"}
VERIFY_STATUS=$?
set -e
exit "${VERIFY_STATUS}"
