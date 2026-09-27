#!/usr/bin/env bash
#
# run-load-test-pgvector.sh — run the API load test (evaluation/run-api-load-bench.mjs)
# against a throwaway PostgreSQL + pgvector cluster, then tear it down.
#
# The load test's pgvector mode ingests a corpus and writes documents, chunks,
# sessions, agent runs and long-term memory into the database it is given, so it
# must never point at a real one. This script provisions a disposable cluster the
# same way run-pgvector-integration.sh does:
#   * a brand-new data directory under $TMPDIR, never an existing cluster;
#   * an OS-assigned free TCP port on 127.0.0.1, never 5432;
#   * an EXIT trap that stops the server and removes the data dir, even on failure
#     or Ctrl-C.
#
# With the database URL set, the load test defaults to --storage pgvector,local, so
# one invocation measures both the production storage path and the standalone
# local store. Extra arguments are passed through to the load test.
#
# Usage (from server/):
#   bash scripts/run-load-test-pgvector.sh [load-test flags]
#
# Optional overrides (env):
#   PG_BIN_DIR    directory holding initdb/pg_ctl/createdb/psql (auto-detected otherwise)
#   LOADTEST_DB   disposable database name (default: archive_loadtest)
#
set -euo pipefail

log() { printf '[load-test-pg] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PG_BIN_DIR_RESOLVED="${PG_BIN_DIR:-}"
if [[ -z "${PG_BIN_DIR_RESOLVED}" ]]; then
  PG_BIN_DIR_RESOLVED="$(ls -d /Applications/Postgres.app/Contents/Versions/latest/bin 2>/dev/null || true)"
fi
if [[ -z "${PG_BIN_DIR_RESOLVED}" || ! -x "${PG_BIN_DIR_RESOLVED}/initdb" ]]; then
  PG_BIN_DIR_RESOLVED="$(
    ls -d /Applications/Postgres.app/Contents/Versions/*/bin 2>/dev/null | sort -t/ -k6 -rn | head -n1
  )"
fi
if [[ -z "${PG_BIN_DIR_RESOLVED}" || ! -x "${PG_BIN_DIR_RESOLVED}/initdb" ]]; then
  if command -v initdb >/dev/null 2>&1; then
    PG_BIN_DIR_RESOLVED="$(dirname "$(command -v initdb)")"
  fi
fi
[[ -n "${PG_BIN_DIR_RESOLVED}" && -x "${PG_BIN_DIR_RESOLVED}/initdb" ]] \
  || fail "could not find PostgreSQL binaries; set PG_BIN_DIR to a dir containing initdb/pg_ctl/createdb/psql"

INITDB="${PG_BIN_DIR_RESOLVED}/initdb"
PG_CTL="${PG_BIN_DIR_RESOLVED}/pg_ctl"
CREATEDB="${PG_BIN_DIR_RESOLVED}/createdb"
PSQL="${PG_BIN_DIR_RESOLVED}/psql"
PG_ISREADY="${PG_BIN_DIR_RESOLVED}/pg_isready"
for tool in "${INITDB}" "${PG_CTL}" "${CREATEDB}" "${PSQL}" "${PG_ISREADY}"; do
  [[ -x "${tool}" ]] || fail "missing executable: ${tool}"
done

LOADTEST_DB="${LOADTEST_DB:-archive_loadtest}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/load-test-pg.XXXXXX")"
DATA_DIR="${WORK_DIR}/data"
SOCK_DIR="${WORK_DIR}/sock"
LOG_FILE="${WORK_DIR}/postgres.log"
PWFILE="${WORK_DIR}/pw.txt"
mkdir -p "${SOCK_DIR}"

STARTED_SERVER=0
cleanup() {
  local status=$?
  if [[ "${STARTED_SERVER}" -eq 1 ]]; then
    log "stopping ephemeral PostgreSQL"
    "${PG_CTL}" -D "${DATA_DIR}" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK_DIR}" 2>/dev/null || true
  exit "${status}"
}
trap cleanup EXIT INT TERM

PG_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"
[[ -n "${PG_PORT}" && "${PG_PORT}" != "5432" && "${PG_PORT}" != "5434" ]] || fail "could not get a free TCP port"
log "ephemeral cluster: port=${PG_PORT} db=${LOADTEST_DB} data=${DATA_DIR}"

printf 'postgres\n' > "${PWFILE}"
"${INITDB}" -D "${DATA_DIR}" -U postgres -A md5 --pwfile="${PWFILE}" -E UTF8 --no-locale \
  >/dev/null 2>"${LOG_FILE}" || { cat "${LOG_FILE}" >&2; fail "initdb failed"; }

# fsync stays on: the load test measures the production write path. max_connections
# leaves room for the app pools plus the recovery/health probes.
# Marked started before pg_ctl returns: a start that times out (-t) leaves the
# postmaster running, and the trap must stop it before deleting its data dir.
STARTED_SERVER=1
"${PG_CTL}" -D "${DATA_DIR}" -l "${LOG_FILE}" -w -t 60 \
  -o "-p ${PG_PORT} -k ${SOCK_DIR} -c listen_addresses=127.0.0.1 -c max_connections=200" \
  start >/dev/null 2>&1 || { cat "${LOG_FILE}" >&2; fail "pg_ctl start failed"; }

export PGPASSWORD=postgres
for _ in $(seq 1 30); do
  "${PG_ISREADY}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres >/dev/null 2>&1 && break
  sleep 1
done
"${PG_ISREADY}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres >/dev/null 2>&1 \
  || { cat "${LOG_FILE}" >&2; fail "PostgreSQL did not become ready"; }

"${CREATEDB}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres "${LOADTEST_DB}"
"${PSQL}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres -d "${LOADTEST_DB}" \
  -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
log "PostgreSQL $("${PSQL}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres -d "${LOADTEST_DB}" -tAc 'SHOW server_version;'), pgvector $("${PSQL}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres -d "${LOADTEST_DB}" -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';")"
unset PGPASSWORD

DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${LOADTEST_DB}"

set +e
( cd "${SERVER_DIR}" && node evaluation/run-api-load-bench.mjs --database-url "${DATABASE_URL}" "$@" )
STATUS=$?
set -e
exit "${STATUS}"
