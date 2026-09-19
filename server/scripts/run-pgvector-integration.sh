#!/usr/bin/env bash
#
# run-pgvector-integration.sh — bring up a throwaway PostgreSQL + pgvector and run
# the real-database integration suite (test/vector-store-pgvector.integration.test.mjs)
# against it, then tear everything down. No Docker required.
#
# Why this exists: the integration suite self-skips unless PGVECTOR_TEST_DATABASE_URL
# points at a live pgvector-enabled PostgreSQL. CI provides `pgvector/pgvector:pg16`;
# locally this script provisions an equivalent, fully disposable cluster from a
# Postgres.app (or any on-PATH) install so the suite runs *unskipped* with one command.
#
# Safety properties:
#   * A brand-new data directory under $TMPDIR — never an existing cluster.
#   * An OS-assigned free TCP port on 127.0.0.1 — never assumes 5432, so a running
#     dev PostgreSQL (and the dev `agentai` database) is left completely untouched.
#   * A disposable database name (agentai_pgvtest) that is dropped with the cluster.
#   * An EXIT trap that stops the server and removes the data dir even on failure.
#
# Usage:
#   server/scripts/run-pgvector-integration.sh                  # focused: pgvector integration only
#   FULL_SUITE=1 server/scripts/run-pgvector-integration.sh     # whole backend suite + pgvector, unskipped
#
# Optional overrides (env):
#   PG_BIN_DIR   directory holding initdb/pg_ctl/createdb/psql (auto-detected otherwise)
#   PGVTEST_DB   disposable database name (default: agentai_pgvtest)
#   KEEP_CLUSTER if set to 1, leave the cluster running after the suite (for debugging)
#   FULL_SUITE   if set to 1, run the whole backend suite (npm test) against the
#                throwaway cluster: test/run.test.mjs globs *.test.mjs and passes
#                env through, so the pgvector integration runs UNSKIPPED *and* the
#                HTTP-route tests that need a real listen() pass — i.e. both
#                "全量 backend 通过" and "req-3 不再 skip" in a single command.
#
set -euo pipefail

log() { printf '[pgvector-it] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

# --- Locate the server/ directory (this script lives in server/scripts/) ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# --- Locate the PostgreSQL binaries -----------------------------------------------
detect_pg_bin_dir() {
  if [[ -n "${PG_BIN_DIR:-}" ]]; then
    printf '%s\n' "${PG_BIN_DIR}"
    return 0
  fi
  # Prefer a Postgres.app install (newest version first), then fall back to PATH.
  local candidate
  for candidate in /Applications/Postgres.app/Contents/Versions/*/bin; do
    [[ -x "${candidate}/initdb" ]] && printf '%s\n' "${candidate}" && return 0
  done
  if command -v initdb >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
    return 0
  fi
  if command -v pg_config >/dev/null 2>&1; then
    "$(command -v pg_config)" --bindir
    return 0
  fi
  return 1
}

# Newest-version-first glob relies on lexical order; PG18 > PG16 sorts correctly, but
# guard the two-digit-major era explicitly by re-sorting numerically just in case.
PG_BIN_DIR_RESOLVED="$(
  if [[ -n "${PG_BIN_DIR:-}" ]]; then printf '%s\n' "${PG_BIN_DIR}"; else
    ls -d /Applications/Postgres.app/Contents/Versions/*/bin 2>/dev/null \
      | sort -t/ -k6 -rn | head -n1
  fi
)"
if [[ -z "${PG_BIN_DIR_RESOLVED}" || ! -x "${PG_BIN_DIR_RESOLVED}/initdb" ]]; then
  PG_BIN_DIR_RESOLVED="$(detect_pg_bin_dir || true)"
fi
[[ -n "${PG_BIN_DIR_RESOLVED}" && -x "${PG_BIN_DIR_RESOLVED}/initdb" ]] \
  || fail "could not find PostgreSQL binaries; set PG_BIN_DIR to a dir containing initdb/pg_ctl/createdb/psql"

INITDB="${PG_BIN_DIR_RESOLVED}/initdb"
PG_CTL="${PG_BIN_DIR_RESOLVED}/pg_ctl"
CREATEDB="${PG_BIN_DIR_RESOLVED}/createdb"
PSQL="${PG_BIN_DIR_RESOLVED}/psql"
POSTGRES_BIN="${PG_BIN_DIR_RESOLVED}/postgres"
for tool in "${INITDB}" "${PG_CTL}" "${CREATEDB}" "${PSQL}" "${POSTGRES_BIN}"; do
  [[ -x "${tool}" ]] || fail "missing executable: ${tool}"
done
log "using PostgreSQL at ${PG_BIN_DIR_RESOLVED} ($("${POSTGRES_BIN}" --version))"

# Confirm pgvector is installable before spending time on initdb.
PG_SHARE_DIR="$(cd "${PG_BIN_DIR_RESOLVED}/.." && pwd)/share/postgresql"
if [[ ! -f "${PG_SHARE_DIR}/extension/vector.control" ]]; then
  # Some distributions use share/ (not share/postgresql/).
  PG_SHARE_DIR="$(cd "${PG_BIN_DIR_RESOLVED}/.." && pwd)/share"
fi
[[ -f "${PG_SHARE_DIR}/extension/vector.control" ]] \
  || fail "pgvector extension not found (looked for extension/vector.control under ${PG_SHARE_DIR}); install pgvector for this PostgreSQL"
log "pgvector extension available: ${PG_SHARE_DIR}/extension/vector.control"

# --- Provision a disposable cluster -----------------------------------------------
PGVTEST_DB="${PGVTEST_DB:-agentai_pgvtest}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pgvector-it.XXXXXX")"
DATA_DIR="${WORK_DIR}/data"
SOCK_DIR="${WORK_DIR}/sock"
LOG_FILE="${WORK_DIR}/postgres.log"
PWFILE="${WORK_DIR}/pw.txt"
mkdir -p "${SOCK_DIR}"

STARTED_SERVER=0
cleanup() {
  local status=$?
  if [[ "${STARTED_SERVER}" -eq 1 && "${KEEP_CLUSTER:-0}" != "1" ]]; then
    log "stopping ephemeral PostgreSQL"
    "${PG_CTL}" -D "${DATA_DIR}" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "${KEEP_CLUSTER:-0}" == "1" ]]; then
    log "KEEP_CLUSTER=1 — leaving cluster at ${DATA_DIR} (port ${PG_PORT:-?}); remove ${WORK_DIR} when done"
  else
    rm -rf "${WORK_DIR}" 2>/dev/null || true
  fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

# Ask the OS for a free TCP port on the loopback (bind :0, read it back, release).
PG_PORT="$(
  python3 - <<'PY' 2>/dev/null || true
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
if [[ -z "${PG_PORT}" ]]; then
  # Fallback: try a handful of high ports until one is free.
  for p in 54329 54330 54331 54332 54333 54334; do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/${p}") 2>/dev/null; then PG_PORT="${p}"; break; fi
    exec 3>&- 2>/dev/null || true
  done
fi
[[ -n "${PG_PORT}" ]] || fail "could not find a free TCP port"
log "ephemeral cluster: port=${PG_PORT} db=${PGVTEST_DB} data=${DATA_DIR}"

printf 'postgres\n' > "${PWFILE}"
log "initializing data directory"
"${INITDB}" -D "${DATA_DIR}" -U postgres -A md5 --pwfile="${PWFILE}" \
  -E UTF8 --no-locale >/dev/null 2>"${LOG_FILE}" \
  || { cat "${LOG_FILE}" >&2; fail "initdb failed"; }

# Listen on loopback TCP + a private unix socket dir; disable fsync for test speed.
log "starting PostgreSQL"
"${PG_CTL}" -D "${DATA_DIR}" -l "${LOG_FILE}" -w -t 60 \
  -o "-p ${PG_PORT} -k ${SOCK_DIR} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off" \
  start >/dev/null 2>&1 || { cat "${LOG_FILE}" >&2; fail "pg_ctl start failed"; }
STARTED_SERVER=1

export PGPASSWORD=postgres
# Wait until it actually accepts connections.
for _ in $(seq 1 30); do
  if "${PG_BIN_DIR_RESOLVED}/pg_isready" -h 127.0.0.1 -p "${PG_PORT}" -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
"${PG_BIN_DIR_RESOLVED}/pg_isready" -h 127.0.0.1 -p "${PG_PORT}" -U postgres >/dev/null 2>&1 \
  || { cat "${LOG_FILE}" >&2; fail "PostgreSQL did not become ready"; }

log "creating disposable database ${PGVTEST_DB} and pgvector extension"
"${CREATEDB}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres "${PGVTEST_DB}"
"${PSQL}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres -d "${PGVTEST_DB}" \
  -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
PGVECTOR_VERSION="$(
  "${PSQL}" -h 127.0.0.1 -p "${PG_PORT}" -U postgres -d "${PGVTEST_DB}" -tAc \
    "SELECT extversion FROM pg_extension WHERE extname='vector';"
)"
log "pgvector extension version: ${PGVECTOR_VERSION:-unknown}"

# --- Run the real-database suite(s) against the throwaway cluster ------------------
export PGVECTOR_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${PGVTEST_DB}"
log "PGVECTOR_TEST_DATABASE_URL=${PGVECTOR_TEST_DATABASE_URL}"

if [[ "${FULL_SUITE:-0}" == "1" ]]; then
  # test/run.test.mjs globs every *.test.mjs and passes env through, so `npm test`
  # here runs the pgvector integration UNSKIPPED alongside the HTTP-route tests that
  # need a real listen() — "全量 backend 通过" + "req-3 不再 skip" in one shell.
  # release-evidence-gate.test.mjs shells `git`; make sure a working git is first on
  # PATH (the bare /usr/bin/git shim can fail the Xcode license, exit 69). Scoped to
  # this process only — it does not touch the user's shell.
  if [[ -x /Library/Developer/CommandLineTools/usr/bin/git ]]; then
    export PATH="/Library/Developer/CommandLineTools/usr/bin:${PATH}"
  fi
  RUN_LABEL="full backend suite (npm test) with pgvector unskipped"
  log "running: npm test (cwd=${SERVER_DIR}) — ${RUN_LABEL}"
  set +e
  ( cd "${SERVER_DIR}" && npm test )
  SUITE_STATUS=$?
  set -e
else
  RUN_LABEL="pgvector integration suite (npm run test:pgvector)"
  log "running: npm run test:pgvector (cwd=${SERVER_DIR})"
  set +e
  ( cd "${SERVER_DIR}" && npm run --silent test:pgvector )
  SUITE_STATUS=$?
  set -e
fi

PG_VERSION_SHORT="$("${POSTGRES_BIN}" --version | awk '{print $3}')"
if [[ "${SUITE_STATUS}" -eq 0 ]]; then
  log "SUCCESS: ${RUN_LABEL} passed on PostgreSQL ${PG_VERSION_SHORT}, pgvector ${PGVECTOR_VERSION:-unknown}"
else
  log "FAILURE: ${RUN_LABEL} exited ${SUITE_STATUS}"
fi
exit "${SUITE_STATUS}"
