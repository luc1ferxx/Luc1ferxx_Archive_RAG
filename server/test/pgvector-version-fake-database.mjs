// An in-memory stand-in for the PostgreSQL the pgvector index-version code
// talks to, for the database-free unit suites
// (vector-store-pgvector-versions.test.mjs, -version-lifecycle.test.mjs,
// vector-index-cli.test.mjs). It answers the statements those modules emit --
// the registry statements by their `/* index_versions:<name> */` tag, the chunk
// statements by their shape -- well enough to run a build, an activation, a
// rollback and a retire end to end. Transactions snapshot the state and restore
// it on a throw. The real behaviour is covered by
// vector-store-pgvector-versions.integration.test.mjs.

const BASE_TABLE = "rag_document_chunks";
const VERSIONS = "rag_index_versions";

const undefinedTable = (name) => {
  const error = new Error(`relation "${name}" does not exist`);

  error.code = "42P01";
  return error;
};

const parseVector = (literal) =>
  String(literal)
    .replace(/[[\]]/g, "")
    .split(",")
    .filter(Boolean)
    .map(Number);

const cosine = (left, right) => {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * (right[index] ?? 0);
    leftNorm += left[index] ** 2;
    rightNorm += (right[index] ?? 0) ** 2;
  }

  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
};

export const createFakeVersionDatabase = ({
  baseDimensions = 4,
  extensionVersion = "0.7.4",
  now = Date.parse("2026-01-01T00:00:00.000Z"),
  registry = true,
} = {}) => {
  const clock = { now };
  const state = {
    documents: new Map(),
    pointer: null,
    progress: new Map(),
    tables: new Map([[BASE_TABLE, { dimensions: baseDimensions, rows: new Map() }]]),
    versions: new Map(),
  };
  const log = [];
  const failures = new Map();
  const hooks = new Map();

  if (registry) {
    state.versions.set(1, {
      activated_at: new Date(clock.now),
      build_documents_done: 0,
      build_documents_failed: 0,
      builder_id: null,
      chunk_table: BASE_TABLE,
      created_at: new Date(clock.now),
      dual_write_until: null,
      embedding_dimensions: baseDimensions,
      embedding_document_prefix: "",
      embedding_identity: "",
      embedding_model: "",
      embedding_query_prefix: "",
      embedding_space_source: "configuration",
      index_params: {},
      lease_expires_at: null,
      sparse_rank_function: `${BASE_TABLE}_sparse_rank`,
      status: "active",
      version_id: 1,
    });
    state.pointer = { active_version_id: 1, generation: 1, previous_version_id: null, switched_at: new Date(clock.now) };
  }

  const nowDate = () => new Date(clock.now);
  const isAfterNow = (value) => value instanceof Date && value.getTime() > clock.now;
  const table = (name) => {
    const entry = state.tables.get(name);

    if (!entry) {
      throw undefinedTable(name);
    }

    return entry;
  };
  const withFlags = (row) => ({
    ...row,
    generation: state.pointer?.generation ?? null,
    pointer_ttl_ms: state.pointer?.pointer_ttl_ms ?? null,
    in_dual_write_window: row.dual_write_until === null || isAfterNow(row.dual_write_until),
    is_active: state.pointer?.active_version_id === row.version_id,
    lease_expired: row.lease_expires_at !== null && !isAfterNow(row.lease_expires_at),
    previous_version_id: state.pointer?.previous_version_id ?? null,
    switched_at: state.pointer?.switched_at ?? null,
  });
  const requireRegistry = () => {
    if (!registry) {
      throw undefinedTable(VERSIONS);
    }
  };
  const rows = (list) => ({ rowCount: list.length, rows: list });
  const progressKey = (versionId, docId) => `${versionId}\u0000${docId}`;
  const progressFor = (versionId) =>
    [...state.progress.values()].filter((entry) => entry.version_id === versionId);
  const countRows = (name, filter = () => true) => [...table(name).rows.values()].filter(filter).length;

  const handleTagged = (tag, sql, values) => {
    requireRegistry();

    switch (tag) {
      case "snapshot": {
        if (!state.pointer) {
          return rows([]);
        }

        return rows(
          [...state.versions.values()]
            .filter(
              (row) =>
                row.version_id === state.pointer.active_version_id || ["building", "ready"].includes(row.status)
            )
            .sort((left, right) => left.version_id - right.version_id)
            .map(withFlags)
        );
      }
      case "write_lock":
      case "lifecycle_lock":
      case "lock_versions":
        return rows([{}]);
      case "write_targets":
        return rows(
          [...state.versions.values()]
            .filter(
              (row) =>
                row.version_id === state.pointer?.active_version_id ||
                row.status === "building" ||
                (row.status === "ready" && (row.dual_write_until === null || isAfterNow(row.dual_write_until)))
            )
            .map(withFlags)
            .sort((left, right) => Number(right.is_active) - Number(left.is_active) || left.version_id - right.version_id)
        );
      case "describe": {
        // The live versions and the pointer's two whatever their number, then
        // the newest `limit` of the rest.
        const isCurrent = (row) =>
          ["active", "building", "ready"].includes(row.status) ||
          row.version_id === state.pointer?.active_version_id ||
          row.version_id === state.pointer?.previous_version_id;
        const all = [...state.versions.values()].sort((left, right) => right.version_id - left.version_id);

        return rows(
          [
            ...all.filter(isCurrent),
            ...all.filter((row) => !isCurrent(row) && (values[0] || row.status !== "retired")).slice(0, values[1]),
          ].map(withFlags)
        );
      }
      case "fence": {
        const fenced = [...state.versions.values()].filter(
          (row) =>
            row.version_id !== state.pointer?.active_version_id &&
            ["building", "ready"].includes(row.status) &&
            row.embedding_space_source === "pinned" &&
            row.embedding_model === values[0] &&
            row.embedding_identity === values[1] &&
            row.embedding_document_prefix === values[2] &&
            row.embedding_dimensions === values[3]
        );

        for (const row of fenced) {
          Object.assign(row, {
            builder_id: null,
            dual_write_until: null,
            last_error: values[4],
            lease_expires_at: null,
            status: "failed",
          });
        }

        return rows(fenced.map((row) => ({ version_id: row.version_id })));
      }
      case "content_drift": {
        const name = /FROM\s+(\w+)\s+GROUP BY doc_id/.exec(sql)[1];
        const versionOf = (row) => {
          const value = row.metadata?.documentVersion;

          if (value === undefined) {
            return 1;
          }

          return /^[0-9]{1,9}$/.test(String(value)) ? Number(value) : -1;
        };
        const byDoc = new Map();

        for (const row of table(name).rows.values()) {
          const entry = byDoc.get(row.doc_id) ?? { max: -Infinity, min: Infinity };

          entry.min = Math.min(entry.min, versionOf(row));
          entry.max = Math.max(entry.max, versionOf(row));
          byDoc.set(row.doc_id, entry);
        }

        return rows(
          [...byDoc.entries()]
            .filter(([docId]) => state.documents.has(docId))
            .map(([docId, entry]) => ({
              content_version: state.documents.get(docId).content_version ?? 1,
              doc_id: docId,
              max_version: entry.max,
              min_version: entry.min,
            }))
            .filter((row) => row.min_version !== row.content_version || row.max_version !== row.content_version)
            .sort((left, right) => left.doc_id.localeCompare(right.doc_id))
        );
      }
      case "base_rows":
        return rows([{ has_rows: table(/FROM\s+(\w+)\)/.exec(sql)[1]).rows.size > 0 }]);
      case "deactivate_unreadable": {
        Object.assign(state.versions.get(values[0]), {
          deactivated_at: nowDate(),
          dual_write_until: null,
          last_error: values[1],
          status: "failed",
        });
        return rows([{ dual_write_until: null }]);
      }
      case "table_totals": {
        const name = /FROM\s+(\w+)/.exec(sql)[1];
        const tableRows = [...table(name).rows.values()];

        return rows([
          {
            chunk_count: String(tableRows.length),
            document_count: String(new Set(tableRows.map((row) => row.doc_id)).size),
          },
        ]);
      }
      case "lock_pointer":
        return rows(
          state.pointer
            ? [{ active_version_id: state.pointer.active_version_id, pointer_ttl_ms: state.pointer.pointer_ttl_ms ?? null }]
            : []
        );
      case "find_building":
        return rows([...state.versions.values()].filter((row) => row.status === "building"));
      case "next_id":
        return rows([{ next_version_id: Math.max(0, ...state.versions.keys()) + 1 }]);
      case "relation_exists":
        return rows([{ relation: state.tables.has(values[0]) ? values[0] : null }]);
      case "register": {
        const row = {
          activated_at: null,
          build_documents_done: 0,
          build_documents_failed: 0,
          build_documents_total: null,
          build_started_at: nowDate(),
          builder_id: values[9],
          chunk_count: null,
          chunk_table: values[1],
          created_at: nowDate(),
          deactivated_at: null,
          document_count: null,
          dual_write_until: null,
          embedding_dimensions: values[7],
          embedding_document_prefix: values[5],
          embedding_identity: values[4],
          embedding_model: values[3],
          embedding_query_prefix: values[6],
          embedding_space_source: "pinned",
          index_params: JSON.parse(values[8]),
          last_error: null,
          lease_expires_at: values[9] === null ? null : new Date(clock.now + values[10]),
          sparse_rank_function: values[2],
          status: "building",
          version_id: values[0],
        };

        state.versions.set(row.version_id, row);
        return rows([row]);
      }
      case "claim": {
        const row = state.versions.get(values[0]);

        if (
          row &&
          row.status === "building" &&
          (row.builder_id === null ||
            row.builder_id === values[1] ||
            row.lease_expires_at === null ||
            !isAfterNow(row.lease_expires_at))
        ) {
          row.builder_id = values[1];
          row.lease_expires_at = new Date(clock.now + values[2]);
          row.last_error = null;
          return rows([row]);
        }

        return rows([]);
      }
      case "read_version": {
        const row = state.versions.get(values[0]);

        return rows(row ? [withFlags(row)] : []);
      }
      case "renew_lease":
      case "progress_counters": {
        const row = state.versions.get(values[0]);

        if (!row || row.builder_id !== values[1] || row.status !== "building") {
          return rows([]);
        }

        row.lease_expires_at = new Date(clock.now + values[2]);

        if (tag === "progress_counters") {
          row.build_documents_done = progressFor(row.version_id).filter((entry) => entry.outcome !== "failed").length;
          row.build_documents_failed = progressFor(row.version_id).filter((entry) => entry.outcome === "failed").length;
          row.build_documents_total = state.documents.size;
        }

        return rows([{ version_id: row.version_id }]);
      }
      case "progress": {
        state.progress.set(progressKey(values[0], values[1]), {
          chunk_count: values[3],
          doc_id: values[1],
          error: values[5],
          outcome: values[2],
          source_uploaded_at: values[4],
          version_id: values[0],
        });
        return rows([]);
      }
      case "pending_documents": {
        const done = new Set(
          progressFor(values[0])
            .filter((entry) => entry.outcome !== "failed")
            .map((entry) => entry.doc_id)
        );

        return rows(
          [...state.documents.keys()]
            .filter((docId) => docId > values[1] && !done.has(docId))
            .sort()
            .slice(0, values[2])
            .map((docId) => ({ doc_id: docId }))
        );
      }
      case "document_source":
      case "lock_document": {
        const document = state.documents.get(values[0]);

        return rows(document ? [{ ...document, uploaded_at: document.uploaded_at }] : []);
      }
      case "complete_build": {
        const row = state.versions.get(values[0]);

        if (!row || row.builder_id !== values[1] || row.status !== "building") {
          return rows([]);
        }

        const tableRows = [...table(row.chunk_table).rows.values()];

        Object.assign(row, {
          build_completed_at: nowDate(),
          build_documents_done: progressFor(row.version_id).filter((entry) => entry.outcome !== "failed").length,
          build_documents_failed: progressFor(row.version_id).filter((entry) => entry.outcome === "failed").length,
          builder_id: null,
          chunk_count: String(tableRows.length),
          document_count: new Set(tableRows.map((entry) => entry.doc_id)).size,
          dual_write_until: null,
          last_error: null,
          lease_expires_at: null,
          status: "ready",
        });
        return rows([row]);
      }
      case "fail_build":
      case "release_build": {
        const row = state.versions.get(values[0]);

        if (row && row.builder_id === values[1] && row.status === "building") {
          Object.assign(row, {
            builder_id: null,
            last_error: values[2],
            lease_expires_at: null,
            ...(tag === "fail_build" ? { status: "failed" } : {}),
          });
        }

        return rows([]);
      }
      case "probe_sample": {
        const name = /FROM\s+(\w+)/.exec(sql)[1];

        return rows(
          [...table(name).rows.values()]
            .sort((left, right) => left.chunk_id.localeCompare(right.chunk_id))
            .slice(0, values[0])
        );
      }
      case "probe_nearest": {
        const name = /FROM\s+(\w+)/.exec(sql)[1];
        const vector = parseVector(values[0]);

        return rows(
          [...table(name).rows.values()]
            .filter((row) => row.embedding_model === values[1] && row.embedding_dimensions === values[2])
            .map((row) => ({ chunk_id: row.chunk_id, score: cosine(vector, parseVector(row.embedding)) }))
            .sort((left, right) => right.score - left.score || left.chunk_id.localeCompare(right.chunk_id))
            .slice(0, values[3])
        );
      }
      case "count_drift": {
        const [activeName, targetName] = [...sql.matchAll(/FROM\s+(\w+)\s+GROUP BY doc_id/g)].map((match) => match[1]);
        const countFor = (name, docId) => countRows(name, (row) => row.doc_id === docId);

        return rows(
          [...state.documents.keys()]
            .sort()
            .map((docId) => ({
              active_count: countFor(activeName, docId),
              doc_id: docId,
              target_count: countFor(targetName, docId),
            }))
            .filter((row) => row.active_count !== row.target_count)
        );
      }
      case "count_totals": {
        const names = [...sql.matchAll(/FROM\s+(\w+)\)/g)].map((match) => match[1]);
        const activeUnread = /NULL::bigint AS active_chunks/.test(sql);

        return rows([
          {
            active_chunks: activeUnread ? null : String(countRows(names[1])),
            document_count: String(state.documents.size),
            target_chunks: String(countRows(names[activeUnread ? 1 : 2])),
          },
        ]);
      }
      case "switch_state": {
        const row = state.versions.get(values[0]);

        return rows(
          row
            ? [{ status: row.status, writable: row.dual_write_until === null || isAfterNow(row.dual_write_until) }]
            : []
        );
      }
      case "pin": {
        Object.assign(state.versions.get(values[0]), {
          embedding_dimensions: values[5],
          embedding_document_prefix: values[3],
          embedding_identity: values[2],
          embedding_model: values[1],
          embedding_query_prefix: values[4],
          embedding_space_source: "pinned",
          index_params: JSON.parse(values[6]),
        });
        return rows([]);
      }
      case "deactivate": {
        const row = state.versions.get(values[0]);

        Object.assign(row, {
          chunk_count: String(values[2]),
          deactivated_at: nowDate(),
          dual_write_until: new Date(clock.now + values[1]),
          status: "ready",
        });
        return rows([{ dual_write_until: row.dual_write_until }]);
      }
      case "activate":
        Object.assign(state.versions.get(values[0]), {
          activated_at: nowDate(),
          chunk_count: String(values[1]),
          dual_write_until: null,
          status: "active",
        });
        return rows([]);
      case "switch_pointer":
        state.pointer = {
          ...state.pointer,
          active_version_id: values[0],
          generation: state.pointer.generation + 1,
          previous_version_id: values[1],
          switched_at: nowDate(),
        };
        return rows([{ generation: String(state.pointer.generation), switched_at: state.pointer.switched_at }]);
      case "stop_build": {
        const row = state.versions.get(values[0]);

        if (
          row &&
          row.status === "building" &&
          (values[1] || row.lease_expires_at === null || !isAfterNow(row.lease_expires_at))
        ) {
          Object.assign(row, { builder_id: null, last_error: values[2], lease_expires_at: null, status: "failed" });
          return rows([{ version_id: row.version_id }]);
        }

        return rows([]);
      }
      case "lock_retire": {
        const row = state.versions.get(values[0]);

        return rows(
          row
            ? [
                {
                  ...row,
                  in_grace: row.dual_write_until !== null && isAfterNow(row.dual_write_until),
                  lease_live: row.lease_expires_at !== null && isAfterNow(row.lease_expires_at),
                  recently_deactivated:
                    row.deactivated_at !== null && row.deactivated_at.getTime() + values[1] > clock.now,
                },
              ]
            : []
        );
      }
      case "empty_base_table":
        table(/TRUNCATE\s+(\w+)/.exec(sql)[1]).rows.clear();
        return rows([]);
      case "retire":
        Object.assign(state.versions.get(values[0]), {
          builder_id: null,
          dual_write_until: null,
          lease_expires_at: null,
          retired_at: nowDate(),
          status: "retired",
        });
        return rows([]);
      case "clear_progress":
        for (const [key, entry] of state.progress) {
          if (entry.version_id === values[0]) {
            state.progress.delete(key);
          }
        }

        return rows([]);
      case "clear_previous":
        if (state.pointer?.previous_version_id === values[0]) {
          state.pointer.previous_version_id = null;
        }

        return rows([]);
      default:
        throw new Error(`The fake database does not know the statement tagged ${tag}.`);
    }
  };

  const insertChunks = (sql, values) => {
    const name = /INSERT INTO (\w+)/.exec(sql)[1];
    const target = table(name);
    let count = 0;

    for (let offset = 0; offset < values.length; offset += 13) {
      const [chunkId, docId, chunkIndex, pageNumber, heading, content, searchText, metadata, owner, workspace, model, dims, embedding] =
        values.slice(offset, offset + 13);

      if (parseVector(embedding).length !== target.dimensions) {
        const error = new Error(`expected ${target.dimensions} dimensions, not ${parseVector(embedding).length}`);

        error.code = "22000";
        throw error;
      }

      if (registry && !state.documents.has(docId) && state.documents.size > 0) {
        const error = new Error(`insert on table "${name}" violates foreign key constraint`);

        error.code = "23503";
        throw error;
      }

      target.rows.set(chunkId, {
        chunk_id: chunkId,
        chunk_index: chunkIndex,
        content,
        doc_id: docId,
        embedding,
        embedding_dimensions: dims,
        embedding_model: model,
        metadata: JSON.parse(metadata),
        owner_user_id: owner,
        page_number: pageNumber,
        search_text: searchText,
        section_heading: heading,
        workspace_id: workspace,
      });
      count += 1;
    }

    return { rowCount: count, rows: [] };
  };

  const handleUntagged = (compact, sql, values) => {
    if (/FROM pg_extension/.test(compact)) {
      return rows([{ extversion: extensionVersion }]);
    }

    if (/FROM pg_attribute/.test(compact)) {
      const entry = state.tables.get(values[0]);

      return rows(entry ? [{ typmod: entry.dimensions }] : []);
    }

    if (/GROUP BY embedding_model, embedding_dimensions/.test(compact)) {
      const name = /FROM (\w+) GROUP BY/.exec(compact)[1];
      const groups = new Map();

      for (const row of table(name).rows.values()) {
        const key = `${row.embedding_model}\u0000${row.embedding_dimensions}`;
        const group = groups.get(key) ?? {
          chunk_count: 0,
          embedding_dimensions: row.embedding_dimensions,
          embedding_model: row.embedding_model,
        };

        group.chunk_count += 1;
        groups.set(key, group);
      }

      return rows([...groups.values()]);
    }

    if (/FROM pg_indexes/.test(compact)) {
      const name = values[0];

      return rows(
        state.tables.has(name)
          ? ["doc_id_idx", "scope_idx", "embedding_model_idx", "search_vector_idx", "embedding_idx"].map(
              (suffix) => ({ indexname: `${name}_${suffix}` })
            )
          : []
      );
    }

    if (/AS access_method/.test(compact)) {
      return rows([{ access_method: "hnsw" }]);
    }

    if (/SELECT to_regclass\(\$1\) AS relation/.test(compact)) {
      return rows([{ relation: state.tables.has(values[0]) ? values[0] : null }]);
    }

    if (/AS document_count FROM/.test(compact)) {
      return rows([{ document_count: state.documents.size }]);
    }

    if (/AS chunk_count FROM (\w+)/.test(compact)) {
      const name = /AS chunk_count FROM (\w+)/.exec(compact)[1];
      const docIds = values[0] ? new Set(values[0]) : null;

      return rows([{ chunk_count: countRows(name, (row) => !docIds || docIds.has(row.doc_id)) }]);
    }

    if (/set_config/.test(compact)) {
      return rows([{}]);
    }

    if (/^CREATE TABLE (\w+)/m.test(sql.trim()) || /\bCREATE TABLE (\w+) \(/.test(sql)) {
      const name = /CREATE TABLE (\w+) \(/.exec(sql)[1];

      if (state.tables.has(name)) {
        throw new Error(`relation "${name}" already exists`);
      }

      state.tables.set(name, { ddl: sql, dimensions: Number(/embedding vector\((\d+)\)/.exec(sql)[1]), rows: new Map() });
      return rows([]);
    }

    if (/DROP TABLE IF EXISTS (\w+)/.test(compact)) {
      const dropped = /DROP TABLE IF EXISTS (\w+)/.exec(compact)[1];

      if (state.lockedTables?.has(dropped)) {
        const error = new Error("canceling statement due to lock timeout");

        error.code = "55P03";
        throw error;
      }

      state.tables.delete(dropped);
      return rows([]);
    }

    if (/^DELETE FROM (\w+) WHERE doc_id = ANY/.test(compact)) {
      const name = /^DELETE FROM (\w+)/.exec(compact)[1];
      const docIds = new Set(values[0]);
      let removed = 0;

      for (const [chunkId, row] of table(name).rows) {
        if (docIds.has(row.doc_id)) {
          table(name).rows.delete(chunkId);
          removed += 1;
        }
      }

      return { rowCount: removed, rows: [] };
    }

    if (/^DELETE FROM (\w+)$/.test(compact)) {
      const target = table(/^DELETE FROM (\w+)$/.exec(compact)[1]);
      const removed = target.rows.size;

      target.rows.clear();
      return { rowCount: removed, rows: [] };
    }

    if (/^INSERT INTO (\w+) \(chunk_id/.test(compact)) {
      return insertChunks(compact, values);
    }

    if (/AS vector_score/.test(compact)) {
      const name = /FROM (\w+) WHERE doc_id = ANY\(\$2/.exec(compact)[1];
      const vector = parseVector(values[0]);
      const docIds = new Set(values[1]);

      return rows(
        [...table(name).rows.values()]
          .filter(
            (row) =>
              docIds.has(row.doc_id) && row.embedding_model === values[2] && row.embedding_dimensions === values[3]
          )
          .map((row) => ({ ...row, vector_score: cosine(vector, parseVector(row.embedding)) }))
          .sort((left, right) => right.vector_score - left.vector_score)
          .slice(0, values[4])
      );
    }

    if (/AS sparse_score/.test(compact) || /_sparse_rank\(/.test(compact)) {
      const name = /_sparse_rank\(/.test(compact)
        ? /JOIN (\w+) c ON/.exec(compact)[1]
        : /FROM (\w+) WHERE doc_id = ANY\(\$3/.exec(compact)[1];
      const tokens = String(values[1]).replace(/'/g, "").split(" | ");
      const docIds = new Set(values[2]);

      return rows(
        [...table(name).rows.values()]
          .filter((row) => docIds.has(row.doc_id) && tokens.some((token) => row.search_text.split(" ").includes(token)))
          .map((row) => ({ ...row, sparse_score: 0.5 }))
          .slice(0, values[3])
      );
    }

    throw new Error(`The fake database does not know: ${compact.slice(0, 160)}`);
  };

  const query = async (sql, values = []) => {
    const text = String(sql);
    const compact = text.replace(/\s+/g, " ").trim();
    const tag = /\/\* index_versions:([a-z_]+) \*\//.exec(text)?.[1] ?? null;
    const entry = { sql: compact, tag, values };

    log.push(entry);
    await hooks.get(tag)?.(entry);

    const failure = failures.get(tag ?? compact);

    if (failure) {
      failures.delete(tag ?? compact);
      throw failure;
    }

    return tag ? handleTagged(tag, text, values) : handleUntagged(compact, text, values);
  };

  const withTransaction = async (callback) => {
    const saved = structuredClone({ ...state });

    log.push({ sql: "BEGIN", tag: null, values: [] });

    try {
      const result = await callback({ query });

      log.push({ sql: "COMMIT", tag: null, values: [] });
      return result;
    } catch (error) {
      Object.assign(state, saved);
      log.push({ sql: "ROLLBACK", tag: null, values: [] });
      throw error;
    }
  };

  return {
    clock,
    failNext: (key, error) => failures.set(key, error),
    hooks,
    log,
    runtime: {
      checkPostgresHealth: async () => ({ message: "ok", status: "ok" }),
      isPostgresConfigured: () => true,
      now: () => clock.now,
      query,
      runMigrations: async () => ({ appliedMigrations: [], status: "ok" }),
      withTransaction,
    },
    state,
    tags: () => log.map((entry) => entry.tag).filter(Boolean),
    // A document as the registry row stores it; `pages` become the "PDF" bytes
    // the unit suites' page loader decodes.
    addDocument: ({
      contentVersion = 1,
      docId,
      owner = "",
      pages,
      uploadedAt = "2026-01-01 00:00:00+00",
      workspace = "",
    }) => {
      state.documents.set(docId, {
        content_version: contentVersion,
        doc_id: docId,
        file_bytes: Buffer.from(JSON.stringify(pages ?? [])),
        file_name: `${docId}.pdf`,
        owner_user_id: owner,
        profile: {},
        uploaded_at: uploadedAt,
        workspace_id: workspace,
      });
    },
  };
};

/** The unit suites' page loader: the fake documents' bytes are JSON pages. */
export const loadFakePages = async ({ fileBuffer }) => {
  const pages = JSON.parse(Buffer.from(fileBuffer).toString("utf8"));

  if (!Array.isArray(pages)) {
    throw new Error("not a PDF");
  }

  return pages.map((text, index) => ({ pageNumber: index + 1, text }));
};
