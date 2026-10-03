import net from "node:net";

// A fake PostgreSQL server on an OS-assigned 127.0.0.1 port, for the replica
// routing suites: the real pg client and pool connect to it, and it records
// every frontend message per connection. It models just enough transaction
// state (implicit block up to Sync, explicit block after BEGIN, skip-to-Sync
// after an error) to answer with the right status; the same model as
// postgres-tenant-pipeline.test.mjs, plus `stop()`, which closes the listener
// and every open connection, so a pool then sees a refused connection exactly
// as from a server that went down. Real PostgreSQL behaviour (a hot standby,
// row-level security through it) is proven by
// postgres-replica.integration.test.mjs.

export const TENANT_SETTINGS_TEXT =
  /set_config\('role', \$1, true\),\s*set_config\('archive_rag\.user_id', \$2, true\),\s*set_config\('archive_rag\.workspace_id', \$3, true\)/;

const message = (type, body = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5);

  header.write(type, 0, "latin1");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};
const cstring = (value) => Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
const int16 = (value) => {
  const buffer = Buffer.alloc(2);

  buffer.writeInt16BE(value);
  return buffer;
};
const int32 = (value) => {
  const buffer = Buffer.alloc(4);

  buffer.writeInt32BE(value);
  return buffer;
};

// Every column is text (oid 25); a boolean is sent as "t" / "f" and the test
// reads it as text.
const rowDescription = (fields) =>
  message(
    "T",
    Buffer.concat([
      int16(fields.length),
      ...fields.map((field) => {
        const { name, typeOid } = typeof field === "string" ? { name: field, typeOid: 25 } : field;

        return Buffer.concat([cstring(name), int32(0), int16(0), int32(typeOid), int16(-1), int32(-1), int16(0)]);
      }),
    ])
  );
const dataRow = (row) =>
  message(
    "D",
    Buffer.concat([
      int16(row.length),
      ...row.map((value) => {
        if (value === null) return int32(-1);
        const bytes = Buffer.from(String(value), "utf8");

        return Buffer.concat([int32(bytes.length), bytes]);
      }),
    ])
  );
const errorResponse = ({ code, message: text }) =>
  message(
    "E",
    Buffer.concat([
      Buffer.from("S"), cstring("ERROR"),
      Buffer.from("V"), cstring("ERROR"),
      Buffer.from("C"), cstring(code),
      Buffer.from("M"), cstring(text),
      Buffer.from([0]),
    ])
  );

class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  cstring() {
    const end = this.buffer.indexOf(0, this.offset);
    const value = this.buffer.toString("utf8", this.offset, end);

    this.offset = end + 1;
    return value;
  }

  int16() {
    const value = this.buffer.readInt16BE(this.offset);

    this.offset += 2;
    return value;
  }

  int32() {
    const value = this.buffer.readInt32BE(this.offset);

    this.offset += 4;
    return value;
  }

  bytes(length) {
    const value = this.buffer.subarray(this.offset, this.offset + length);

    this.offset += length;
    return value;
  }
}

/**
 * `respond(text, values)` answers a statement: { fields, rows, command } or
 * { error: { code, message } }, or undefined for the default (the tenant
 * settings' one row, otherwise no rows). BEGIN, COMMIT and ROLLBACK are
 * answered here and move the modelled transaction status.
 */
export const startFakePostgres = async (respond) => {
  const state = { closed: new Set(), connections: 0, messages: [] };
  const sockets = new Set();

  const answer = (text, values) => {
    const keyword = text.trim().split(/\s+/)[0]?.toUpperCase();

    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(keyword)) {
      return { command: keyword, control: keyword };
    }

    const answered = respond(text, values);

    if (answered) return answered;

    return TENANT_SETTINGS_TEXT.test(text)
      ? { command: "SELECT 1", fields: ["set_config", "set_config", "set_config"], rows: [values] }
      : { command: "SELECT 0", fields: [], rows: [] };
  };

  const server = net.createServer((socket) => {
    const connectionId = ++state.connections;
    let pending = Buffer.alloc(0);
    let started = false;
    let status = "I";
    let skipping = false;
    let statement = null;
    let portal = null;
    const record = (entry) => state.messages.push({ connectionId, ...entry });

    sockets.add(socket);

    const execute = (result, { send, simple }) => {
      if (result.error) {
        send(errorResponse(result.error));
        status = status === "I" ? "I" : "E";
        return false;
      }

      if (status === "E" && result.control !== "ROLLBACK" && result.control !== "COMMIT") {
        send(errorResponse({ code: "25P02", message: "current transaction is aborted" }));
        return false;
      }

      if (result.control === "BEGIN") status = "T";
      if (result.control === "COMMIT" || result.control === "ROLLBACK") status = "I";
      if (simple && result.fields?.length) send(rowDescription(result.fields));
      (result.rows ?? []).forEach((row) => send(dataRow(row)));
      send(message("C", cstring(result.command)));
      return true;
    };

    const handle = (type, body) => {
      const reader = new Reader(body);
      const send = (buffer) => socket.write(buffer);

      if (type === "X") {
        record({ type: "Terminate" });
        socket.end();
        return;
      }

      if (type === "S") {
        record({ type: "Sync" });
        skipping = false;
        send(message("Z", Buffer.from(status)));
        return;
      }

      if (skipping) {
        record({ code: type, type: "skipped" });
        return;
      }

      if (type === "Q") {
        const text = reader.cstring();

        record({ text, type: "Query" });
        execute(answer(text, []), { send, simple: true });
        send(message("Z", Buffer.from(status)));
        return;
      }

      if (type === "P") {
        reader.cstring();
        const text = reader.cstring();

        statement = { text };
        record({ text, type: "Parse" });
        send(message("1"));
        return;
      }

      if (type === "B") {
        reader.cstring();
        reader.cstring();
        const formats = Array.from({ length: reader.int16() }, () => reader.int16());
        const values = Array.from({ length: reader.int16() }, (_, index) => {
          const length = reader.int32();

          if (length < 0) return null;
          const bytes = reader.bytes(length);

          return (formats[index] ?? formats[0] ?? 0) === 1 ? bytes : bytes.toString("utf8");
        });

        portal = { result: answer(statement.text, values), text: statement.text, values };
        record({ type: "Bind", values });
        send(message("2"));
        return;
      }

      if (type === "D") {
        record({ type: "Describe" });
        send(portal.result.fields?.length ? rowDescription(portal.result.fields) : message("n"));
        return;
      }

      if (type === "E") {
        record({ text: portal.text, type: "Execute" });

        if (!execute(portal.result, { send, simple: false })) {
          skipping = true;
        }

        return;
      }

      if (type === "H") {
        return;
      }

      throw new Error(`fake postgres: unhandled message ${type}`);
    };

    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);

      while (true) {
        if (!started) {
          if (pending.length < 8) return;
          const length = pending.readInt32BE(0);

          if (pending.length < length) return;
          pending = pending.subarray(length);
          started = true;
          socket.write(
            Buffer.concat([
              message("R", int32(0)),
              message("S", Buffer.concat([cstring("client_encoding"), cstring("UTF8")])),
              message("K", Buffer.concat([int32(connectionId), int32(42)])),
              message("Z", Buffer.from("I")),
            ])
          );
          continue;
        }

        if (pending.length < 5) return;
        const length = pending.readInt32BE(1);

        if (pending.length < length + 1) return;
        const type = pending.toString("latin1", 0, 1);
        const body = pending.subarray(5, length + 1);

        pending = pending.subarray(length + 1);
        handle(type, body);
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      state.closed.add(connectionId);
    });
    socket.on("error", () => {});
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  // Closes the listener and drops every connection: a server that is gone.
  const stop = () =>
    new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });

  return {
    close: stop,
    port,
    // Listens again on the same port: the server is back.
    restart: () => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)),
    state,
    stop,
    url: (database = "fake") => `postgresql://tester@127.0.0.1:${port}/${database}`,
  };
};

// The statements a connection executed, in order, compacted.
export const executedTexts = (messages) =>
  messages
    .filter((entry) => entry.type === "Execute" || entry.type === "Query")
    .map((entry) => entry.text.replace(/\s+/g, " ").trim());

// Round trips: every Sync and every simple Query is answered by one
// ReadyForQuery the client waits for.
export const roundTrips = (messages) =>
  messages.filter((entry) => entry.type === "Sync" || entry.type === "Query").length;
