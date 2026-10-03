#!/usr/bin/env bash
#
# run-pgvector-replica-integration.sh — bring up a throwaway PostgreSQL + pgvector
# primary and a streaming hot-standby replica of it, run the read-replica
# integration suite (test/postgres-replica.integration.test.mjs) and the
# split-deployment replica case of test/service-split-hardening.e2e.test.mjs
# against the pair, then tear both down. No Docker required.
#
# The suite self-skips unless PGVECTOR_TEST_DATABASE_URL (the primary) and
# PGVECTOR_TEST_REPLICA_URL (the same database on the replica) are both set. It
# pauses and resumes WAL replay on the replica (pg_wal_replay_pause), which
# needs a superuser, so it is given the clusters' own `postgres` login.
#
# Safety properties (as run-pgvector-integration.sh):
#   * Brand-new data directories under $TMPDIR — never an existing cluster.
#   * OS-assigned free TCP ports on 127.0.0.1 — never 5432 or 5434.
#   * An EXIT trap that stops both servers and removes the work dir even on failure.
#
# How the replica is made: initdb the primary with wal_level=replica and WAL
# senders, create the disposable database and the vector extension, then
# pg_basebackup -R (which writes standby.signal and primary_conninfo) into the
# replica's directory and start it with hot_standby=on on its own port.
#
# Usage:
#   server/scripts/run-pgvector-replica-integration.sh
#
# Optional overrides (env):
#   PG_BIN_DIR   directory holding initdb/pg_ctl/pg_basebackup/createdb/psql
#   PGVTEST_DB   disposable database name (default: agentai_replica_it)
#   KEEP_CLUSTER if set to 1, leave both servers running after the suite
#
set -euo pipefail

log() { printf '[replica-it] %s\n' "$*" >&2; }
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
  || fail "could not find PostgreSQL binaries; set PG_BIN_DIR to a dir containing initdb/pg_ctl/pg_basebackup/createdb/psql"

INITDB="${PG_BIN_DIR_RESOLVED}/initdb"
PG_CTL="${PG_BIN_DIR_RESOLVED}/pg_ctl"
PG_BASEBACKUP="${PG_BIN_DIR_RESOLVED}/pg_basebackup"
CREATEDB="${PG_BIN_DIR_RESOLVED}/createdb"
PSQL="${PG_BIN_DIR_RESOLVED}/psql"
PG_ISREADY="${PG_BIN_DIR_RESOLVED}/pg_isready"
for tool in "${INITDB}" "${PG_CTL}" "${PG_BASEBACKUP}" "${CREATEDB}" "${PSQL}" "${PG_ISREADY}"; do
  [[ -x "${tool}" ]] || fail "missing executable: ${tool}"
done

PGVTEST_DB="${PGVTEST_DB:-agentai_replica_it}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pgvector-replica-it.XXXXXX")"
PRIMARY_DIR="${WORK_DIR}/primary"
REPLICA_DIR="${WORK_DIR}/replica"
PRIMARY_SOCK="${WORK_DIR}/primary-sock"
REPLICA_SOCK="${WORK_DIR}/replica-sock"
PWFILE="${WORK_DIR}/pw.txt"
mkdir -p "${PRIMARY_SOCK}" "${REPLICA_SOCK}"

PRIMARY_STARTED=0
REPLICA_STARTED=0
cleanup() {
  local status=$?
  if [[ "${KEEP_CLUSTER:-0}" == "1" ]]; then
    log "KEEP_CLUSTER=1 — leaving primary (port ${PRIMARY_PORT:-?}) and replica (port ${REPLICA_PORT:-?}) at ${WORK_DIR}"
    exit "${status}"
  fi
  if [[ "${REPLICA_STARTED}" -eq 1 ]]; then
    "${PG_CTL}" -D "${REPLICA_DIR}" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "${PRIMARY_STARTED}" -eq 1 ]]; then
    "${PG_CTL}" -D "${PRIMARY_DIR}" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK_DIR}" 2>/dev/null || true
  exit "${status}"
}
trap cleanup EXIT INT TERM

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

PRIMARY_PORT="$(free_port)"
REPLICA_PORT="$(free_port)"
for port in "${PRIMARY_PORT}" "${REPLICA_PORT}"; do
  [[ -n "${port}" && "${port}" != "5432" && "${port}" != "5434" ]] || fail "could not get a free TCP port"
done
[[ "${PRIMARY_PORT}" != "${REPLICA_PORT}" ]] || REPLICA_PORT="$(free_port)"
log "primary port=${PRIMARY_PORT} replica port=${REPLICA_PORT} db=${PGVTEST_DB} work=${WORK_DIR}"

printf 'postgres\n' > "${PWFILE}"
"${INITDB}" -D "${PRIMARY_DIR}" -U postgres -A md5 --pwfile="${PWFILE}" -E UTF8 --no-locale \
  >/dev/null 2>"${WORK_DIR}/initdb.log" || { cat "${WORK_DIR}/initdb.log" >&2; fail "initdb failed"; }

# Marked started before pg_ctl returns: a start that times out leaves the
# postmaster running, and the trap must stop it before deleting its data dir.
PRIMARY_STARTED=1
"${PG_CTL}" -D "${PRIMARY_DIR}" -l "${WORK_DIR}/primary.log" -w -t 60 \
  -o "-p ${PRIMARY_PORT} -k ${PRIMARY_SOCK} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off -c wal_level=replica -c max_wal_senders=4 -c hot_standby=on" \
  start >/dev/null 2>&1 || { cat "${WORK_DIR}/primary.log" >&2; fail "primary start failed"; }

export PGPASSWORD=postgres
for _ in $(seq 1 30); do
  "${PG_ISREADY}" -h 127.0.0.1 -p "${PRIMARY_PORT}" -U postgres >/dev/null 2>&1 && break
  sleep 1
done
"${PG_ISREADY}" -h 127.0.0.1 -p "${PRIMARY_PORT}" -U postgres >/dev/null 2>&1 \
  || { cat "${WORK_DIR}/primary.log" >&2; fail "primary did not become ready"; }

"${CREATEDB}" -h 127.0.0.1 -p "${PRIMARY_PORT}" -U postgres "${PGVTEST_DB}"
"${PSQL}" -h 127.0.0.1 -p "${PRIMARY_PORT}" -U postgres -d "${PGVTEST_DB}" \
  -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null \
  || fail "pgvector is not installable on this PostgreSQL"

log "taking a base backup for the replica"
"${PG_BASEBACKUP}" -h 127.0.0.1 -p "${PRIMARY_PORT}" -U postgres -D "${REPLICA_DIR}" -R -X stream -c fast \
  >/dev/null 2>"${WORK_DIR}/basebackup.log" || { cat "${WORK_DIR}/basebackup.log" >&2; fail "pg_basebackup failed"; }
chmod 700 "${REPLICA_DIR}"

REPLICA_STARTED=1
"${PG_CTL}" -D "${REPLICA_DIR}" -l "${WORK_DIR}/replica.log" -w -t 60 \
  -o "-p ${REPLICA_PORT} -k ${REPLICA_SOCK} -c listen_addresses=127.0.0.1 -c hot_standby=on -c fsync=off" \
  start >/dev/null 2>&1 || { cat "${WORK_DIR}/replica.log" >&2; fail "replica start failed"; }

for _ in $(seq 1 30); do
  "${PG_ISREADY}" -h 127.0.0.1 -p "${REPLICA_PORT}" -U postgres >/dev/null 2>&1 && break
  sleep 1
done
IN_RECOVERY="$(
  "${PSQL}" -h 127.0.0.1 -p "${REPLICA_PORT}" -U postgres -d "${PGVTEST_DB}" -tAc "SELECT pg_is_in_recovery();" 2>/dev/null || true
)"
[[ "${IN_RECOVERY}" == "t" ]] || { cat "${WORK_DIR}/replica.log" >&2; fail "the replica is not a hot standby"; }
STREAMING="$(
  "${PSQL}" -h 127.0.0.1 -p "${PRIMARY_PORT}" -U postgres -d "${PGVTEST_DB}" -tAc \
    "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming';"
)"
log "replica in recovery; streaming senders on the primary: ${STREAMING}"
log "PostgreSQL $("${PSQL}" -h 127.0.0.1 -p "${PRIMARY_PORT}" -U postgres -d "${PGVTEST_DB}" -tAc 'SHOW server_version;'), pgvector $("${PSQL}" -h 127.0.0.1 -p "${PRIMARY_PORT}" -U postgres -d "${PGVTEST_DB}" -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';")"
unset PGPASSWORD

export PGVECTOR_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PRIMARY_PORT}/${PGVTEST_DB}"
export PGVECTOR_TEST_REPLICA_URL="postgresql://postgres:postgres@127.0.0.1:${REPLICA_PORT}/${PGVTEST_DB}"

set +e
( cd "${SERVER_DIR}" && node --test --test-concurrency=1 test/postgres-replica.integration.test.mjs test/service-split-hardening.e2e.test.mjs )
SUITE_STATUS=$?
set -e

if [[ "${SUITE_STATUS}" -eq 0 ]]; then
  log "SUCCESS: read-replica integration suite passed"
else
  log "FAILURE: read-replica integration suite exited ${SUITE_STATUS}"
fi
exit "${SUITE_STATUS}"
