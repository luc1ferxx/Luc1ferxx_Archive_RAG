#!/usr/bin/env bash
#
# run-pgvector-scale-bench.sh — run evaluation/run-pgvector-scale-bench.mjs against
# a throwaway PostgreSQL + pgvector cluster, then delete the cluster.
#
# Same safety properties as run-pgvector-integration.sh:
#   * a brand-new data directory under $TMPDIR, never an existing cluster;
#   * an OS-assigned free port on 127.0.0.1, never 5432 or a running dev server;
#   * an EXIT/INT/TERM trap that stops the server and removes the data directory,
#     also when the benchmark fails.
#
# Server settings: durability is off (fsync, full_page_writes, synchronous_commit)
# and wal_level=minimal so bulk loads and index builds do not pay for crash
# safety the throwaway cluster does not need; this changes write cost only.
# max_worker_processes / max_parallel_workers are raised so the HNSW build can
# use the parallel maintenance workers the benchmark asks for. Query-side
# settings (shared_buffers, work_mem, max_parallel_workers_per_gather) keep the
# PostgreSQL defaults the docker-compose deployment also runs with; the report
# records every one of them.
#
# Usage (from anywhere):
#   server/scripts/run-pgvector-scale-bench.sh                      # full run, default sizes
#   server/scripts/run-pgvector-scale-bench.sh --sizes 2k --queries 20   # smoke
# Arguments are passed through to the benchmark.
#
# Optional env:
#   PG_BIN_DIR        directory holding initdb/pg_ctl/createdb/psql/postgres
#   BENCH_SHARED_BUFFERS  shared_buffers for the cluster (default: PostgreSQL's 128MB)
#   KEEP_CLUSTER=1    leave the cluster running for inspection (prints its URL)
#
set -euo pipefail

log() { printf '[pgvector-scale] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PG_BIN_DIR_RESOLVED="${PG_BIN_DIR:-}"
if [[ -z "${PG_BIN_DIR_RESOLVED}" ]]; then
  if [[ -x /Applications/Postgres.app/Contents/Versions/latest/bin/initdb ]]; then
    PG_BIN_DIR_RESOLVED=/Applications/Postgres.app/Contents/Versions/latest/bin
  elif command -v initdb >/dev/null 2>&1; then
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
log "using PostgreSQL at ${PG_BIN_DIR_RESOLVED} ($("${PG_BIN_DIR_RESOLVED}/postgres" --version))"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pgvector-scale.XXXXXX")"
DATA_DIR="${WORK_DIR}/data"
SOCK_DIR="${WORK_DIR}/sock"
LOG_FILE="${WORK_DIR}/postgres.log"
PWFILE="${WORK_DIR}/pw.txt"
DB_NAME="pgvector_scale_bench"
mkdir -p "${SOCK_DIR}"

STARTED_SERVER=0
cleanup() {
  local status=$?
  if [[ "${STARTED_SERVER}" -eq 1 && "${KEEP_CLUSTER:-0}" != "1" ]]; then
    log "stopping ephemeral PostgreSQL"
    "${PG_CTL}" -D "${DATA_DIR}" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "${KEEP_CLUSTER:-0}" == "1" ]]; then
    log "KEEP_CLUSTER=1: cluster left at ${DATA_DIR} (port ${PG_PORT:-?}); stop it with '${PG_CTL} -D ${DATA_DIR} stop' and remove ${WORK_DIR}"
  else
    rm -rf "${WORK_DIR}" 2>/dev/null || true
    log "removed ${WORK_DIR}"
  fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

PG_PORT="$(node -e '
  const server = require("node:net").createServer();
  server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });
')"
[[ -n "${PG_PORT}" ]] || fail "could not find a free TCP port"
case "${PG_PORT}" in 5432|5434) fail "refusing port ${PG_PORT}";; esac
log "ephemeral cluster: port=${PG_PORT} db=${DB_NAME} data=${DATA_DIR}"

printf 'postgres\n' > "${PWFILE}"
"${INITDB}" -D "${DATA_DIR}" -U postgres -A md5 --pwfile="${PWFILE}" -E UTF8 --no-locale \
  >/dev/null 2>"${LOG_FILE}" || { cat "${LOG_FILE}" >&2; fail "initdb failed"; }

SERVER_OPTIONS="-p ${PG_PORT} -k ${SOCK_DIR} -c listen_addresses=127.0.0.1"
SERVER_OPTIONS+=" -c fsync=off -c full_page_writes=off -c synchronous_commit=off"
SERVER_OPTIONS+=" -c wal_level=minimal -c max_wal_senders=0 -c max_wal_size=4GB -c checkpoint_timeout=30min"
SERVER_OPTIONS+=" -c max_worker_processes=16 -c max_parallel_workers=14"
if [[ -n "${BENCH_SHARED_BUFFERS:-}" ]]; then
  SERVER_OPTIONS+=" -c shared_buffers=${BENCH_SHARED_BUFFERS}"
fi

# Marked started before pg_ctl returns: a start that times out (-t) leaves the
# postmaster running, and the trap must stop it before deleting its data dir.
STARTED_SERVER=1
"${PG_CTL}" -D "${DATA_DIR}" -l "${LOG_FILE}" -w -t 60 -o "${SERVER_OPTIONS}" start >/dev/null 2>&1 \
  || { cat "${LOG_FILE}" >&2; fail "pg_ctl start failed"; }

export PGPASSWORD=postgres
for _ in $(seq 1 30); do
  "${PG_ISREADY}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres >/dev/null 2>&1 && break
  sleep 1
done
"${PG_ISREADY}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres >/dev/null 2>&1 \
  || { cat "${LOG_FILE}" >&2; fail "PostgreSQL did not become ready"; }

"${CREATEDB}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres "${DB_NAME}"
"${PSQL}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres -d "${DB_NAME}" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null

DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}"
log "running the benchmark against ${DATABASE_URL}"

set +e
( cd "${SERVER_DIR}" && node evaluation/run-pgvector-scale-bench.mjs --database-url "${DATABASE_URL}" "$@" )
BENCH_STATUS=$?
set -e

if [[ "${BENCH_STATUS}" -ne 0 ]]; then
  log "benchmark exited ${BENCH_STATUS}; last server log lines:"
  tail -n 20 "${LOG_FILE}" >&2 || true
fi
exit "${BENCH_STATUS}"
