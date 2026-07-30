import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  claimUploadSessionFinalization,
  cleanupExpiredUploadSessions,
  clearUploadSession,
  configureUploadSessionDirectory,
  finalizeUploadSession,
  getUploadSessionStatus,
  initializeUploadSession,
  recoverInterruptedUploadFinalizations,
  releaseUploadSessionFinalization,
  storeUploadChunk,
} from "../upload-session-store.js";
import {
  MAX_CHUNK_UPLOAD_SIZE,
  MAX_RESUMABLE_UPLOAD_SIZE,
} from "../upload-policy.js";

const ALICE_SCOPE = {
  userId: "alice",
  workspaceId: "workspace-a",
};
const BOB_SCOPE = {
  userId: "bob",
  workspaceId: "workspace-b",
};
const createMetadata = (overrides = {}) => ({
  fileId: "shared-file-id",
  fileName: "notes.pdf",
  fileSize: 10,
  lastModified: 1,
  totalChunks: 2,
  chunkSize: 6,
  ...overrides,
});

const assertUploadError = async (operation, { status, pattern }) => {
  await assert.rejects(operation, (error) => {
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
    return true;
  });
};

const finalizeClaimedUpload = async ({
  accessScope,
  fileId,
  destinationPath,
}) => {
  const claim = await claimUploadSessionFinalization({
    accessScope,
    fileId,
  });

  return finalizeUploadSession({
    accessScope,
    fileId,
    claimToken: claim.claimToken,
    destinationPath,
  });
};

const withUploadStore = async (label, operation) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `upload-store-${label}-`));
  const sessionsDirectory = path.join(tempRoot, "sessions");
  configureUploadSessionDirectory(sessionsDirectory);

  try {
    return await operation({
      sessionsDirectory,
      tempRoot,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

test("upload sessions are isolated by user and workspace scope", async () => {
  await withUploadStore("scope", async () => {
    await initializeUploadSession({
      accessScope: ALICE_SCOPE,
      ...createMetadata(),
    });
    await storeUploadChunk({
      accessScope: ALICE_SCOPE,
      fileId: "shared-file-id",
      chunkIndex: 0,
      totalChunks: 2,
      chunkBuffer: Buffer.from("123456"),
    });

    assert.equal(
      await getUploadSessionStatus({
        accessScope: BOB_SCOPE,
        fileId: "shared-file-id",
      }),
      null
    );
    await assertUploadError(
      () =>
        storeUploadChunk({
          accessScope: BOB_SCOPE,
          fileId: "shared-file-id",
          chunkIndex: 0,
          totalChunks: 2,
          chunkBuffer: Buffer.from("ABCDEF"),
        }),
      {
        status: 404,
        pattern: /Upload session not found/,
      }
    );

    const bobSession = await initializeUploadSession({
      accessScope: BOB_SCOPE,
      ...createMetadata({
        fileName: "bob.pdf",
      }),
    });
    assert.deepEqual(bobSession.uploadedChunks, []);

    const aliceSession = await getUploadSessionStatus({
      accessScope: ALICE_SCOPE,
      fileId: "shared-file-id",
    });
    assert.equal(aliceSession.fileName, "notes.pdf");
    assert.deepEqual(aliceSession.uploadedChunks, [0]);

    await clearUploadSession({
      accessScope: BOB_SCOPE,
      fileId: "shared-file-id",
    });
    assert.deepEqual(
      (
        await getUploadSessionStatus({
          accessScope: ALICE_SCOPE,
          fileId: "shared-file-id",
        })
      ).uploadedChunks,
      [0]
    );
  });
});

test("same-scope resume is idempotent and metadata conflicts preserve the session", async () => {
  await withUploadStore("resume", async () => {
    await initializeUploadSession({
      accessScope: ALICE_SCOPE,
      ...createMetadata(),
    });
    await storeUploadChunk({
      accessScope: ALICE_SCOPE,
      fileId: "shared-file-id",
      chunkIndex: 0,
      totalChunks: 2,
      chunkBuffer: Buffer.from("123456"),
    });

    const resumed = await initializeUploadSession({
      accessScope: ALICE_SCOPE,
      ...createMetadata(),
    });
    assert.deepEqual(resumed.uploadedChunks, [0]);

    await assertUploadError(
      () =>
        initializeUploadSession({
          accessScope: ALICE_SCOPE,
          ...createMetadata({
            chunkSize: 5,
          }),
        }),
      {
        status: 409,
        pattern: /metadata does not match/i,
      }
    );

    const preserved = await getUploadSessionStatus({
      accessScope: ALICE_SCOPE,
      fileId: "shared-file-id",
    });
    assert.equal(preserved.chunkSize, 6);
    assert.deepEqual(preserved.uploadedChunks, [0]);
  });
});

test("upload metadata enforces bounded and internally consistent geometry", async () => {
  await withUploadStore("geometry", async () => {
    const cases = [
      {
        metadata: createMetadata({
          fileSize: MAX_RESUMABLE_UPLOAD_SIZE + 1,
          totalChunks: 21,
          chunkSize: MAX_CHUNK_UPLOAD_SIZE,
        }),
        status: 413,
        pattern: /exceeds the maximum/i,
      },
      {
        metadata: createMetadata({
          fileSize: 101,
          totalChunks: 101,
          chunkSize: 1,
        }),
        status: 413,
        pattern: /too many chunks/i,
      },
      {
        metadata: createMetadata({
          fileSize: MAX_CHUNK_UPLOAD_SIZE + 1,
          totalChunks: 1,
          chunkSize: MAX_CHUNK_UPLOAD_SIZE + 1,
        }),
        status: 413,
        pattern: /chunkSize exceeds/i,
      },
      {
        metadata: createMetadata({
          fileSize: 10,
          totalChunks: 3,
          chunkSize: 6,
        }),
        status: 400,
        pattern: /totalChunks does not match/i,
      },
      {
        metadata: createMetadata({
          fileSize: 0,
          totalChunks: 1,
          chunkSize: 1,
        }),
        status: 400,
        pattern: /fileSize must be a positive/i,
      },
      {
        metadata: createMetadata({
          fileSize: "10junk",
        }),
        status: 400,
        pattern: /fileSize must be a positive/i,
      },
    ];

    for (const [index, entry] of cases.entries()) {
      await assertUploadError(
        () =>
          initializeUploadSession({
            accessScope: ALICE_SCOPE,
            ...entry.metadata,
            fileId: `invalid-${index}`,
          }),
        entry
      );
    }
  });
});

test("chunks require exact lengths and cannot overwrite different content", async () => {
  await withUploadStore("chunks", async ({ tempRoot }) => {
    await initializeUploadSession({
      accessScope: ALICE_SCOPE,
      ...createMetadata(),
    });

    await assertUploadError(
      () =>
        storeUploadChunk({
          accessScope: ALICE_SCOPE,
          fileId: "shared-file-id",
          chunkIndex: 0,
          totalChunks: 2,
          chunkBuffer: Buffer.from("short"),
        }),
      {
        status: 400,
        pattern: /chunk 0 must contain exactly 6 bytes/i,
      }
    );

    const firstChunk = Buffer.from("123456");
    await storeUploadChunk({
      accessScope: ALICE_SCOPE,
      fileId: "shared-file-id",
      chunkIndex: "0",
      totalChunks: "2",
      chunkBuffer: firstChunk,
    });
    const retry = await storeUploadChunk({
      accessScope: ALICE_SCOPE,
      fileId: "shared-file-id",
      chunkIndex: 0,
      totalChunks: 2,
      chunkBuffer: Buffer.from(firstChunk),
    });
    assert.deepEqual(retry.uploadedChunks, [0]);

    await assertUploadError(
      () =>
        storeUploadChunk({
          accessScope: ALICE_SCOPE,
          fileId: "shared-file-id",
          chunkIndex: 0,
          totalChunks: 2,
          chunkBuffer: Buffer.from("ABCDEF"),
        }),
      {
        status: 409,
        pattern: /already contains different content/i,
      }
    );
    await assertUploadError(
      () =>
        storeUploadChunk({
          accessScope: ALICE_SCOPE,
          fileId: "shared-file-id",
          chunkIndex: "0junk",
          totalChunks: 2,
          chunkBuffer: firstChunk,
        }),
      {
        status: 400,
        pattern: /chunkIndex must be a non-negative integer/i,
      }
    );

    const secondChunk = Buffer.from("7890");
    await storeUploadChunk({
      accessScope: ALICE_SCOPE,
      fileId: "shared-file-id",
      chunkIndex: 1,
      totalChunks: 2,
      chunkBuffer: secondChunk,
    });

    const destinationPath = path.join(tempRoot, "merged.pdf");
    const result = await finalizeClaimedUpload({
      accessScope: ALICE_SCOPE,
      fileId: "shared-file-id",
      destinationPath,
    });
    const expected = Buffer.concat([firstChunk, secondChunk]);

    assert.deepEqual(await readFile(destinationPath), expected);
    assert.equal(result.fileSize, expected.byteLength);
    assert.equal(
      result.sha256,
      createHash("sha256").update(expected).digest("hex")
    );
  });
});

test("finalization rejects tampered chunk bytes and does not publish a merged file", async () => {
  await withUploadStore(
    "tamper",
    async ({ sessionsDirectory, tempRoot }) => {
      await initializeUploadSession({
        accessScope: ALICE_SCOPE,
        ...createMetadata(),
      });
      await storeUploadChunk({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
        chunkIndex: 0,
        totalChunks: 2,
        chunkBuffer: Buffer.from("123456"),
      });
      await storeUploadChunk({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
        chunkIndex: 1,
        totalChunks: 2,
        chunkBuffer: Buffer.from("7890"),
      });

      const [sessionDirectoryName] = await readdir(sessionsDirectory);
      await writeFile(
        path.join(sessionsDirectory, sessionDirectoryName, "chunk-1"),
        "tampered"
      );

      const destinationPath = path.join(tempRoot, "must-not-exist.pdf");
      await assertUploadError(
        () =>
          finalizeClaimedUpload({
            accessScope: ALICE_SCOPE,
            fileId: "shared-file-id",
            destinationPath,
          }),
        {
          status: 409,
          pattern: /chunk 1 has an invalid size/i,
        }
      );
      await assert.rejects(() => access(destinationPath), {
        code: "ENOENT",
      });
    }
  );
});

test("concurrent different writes cannot replace the first installed chunk", async () => {
  await withUploadStore("concurrent-chunk", async ({ tempRoot }) => {
    await initializeUploadSession({
      accessScope: ALICE_SCOPE,
      ...createMetadata({
        fileSize: 6,
        totalChunks: 1,
        chunkSize: 6,
      }),
    });

    const attempts = await Promise.allSettled([
      storeUploadChunk({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
        chunkIndex: 0,
        totalChunks: 1,
        chunkBuffer: Buffer.from("AAAAAA"),
      }),
      storeUploadChunk({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
        chunkIndex: 0,
        totalChunks: 1,
        chunkBuffer: Buffer.from("BBBBBB"),
      }),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.status, 409);

    const destinationPath = path.join(tempRoot, "concurrent.pdf");
    await finalizeClaimedUpload({
      accessScope: ALICE_SCOPE,
      fileId: "shared-file-id",
      destinationPath,
    });
    const content = await readFile(destinationPath, "utf8");
    assert.ok(
      content === "AAAAAA" || content === "BBBBBB",
      "the merged file must contain one complete winning chunk"
    );
  });
});

test("finalization claims serialize completion and require the winning token", async () => {
  await withUploadStore("finalization-claim", async ({ tempRoot }) => {
    await initializeUploadSession({
      accessScope: ALICE_SCOPE,
      ...createMetadata({
        fileSize: 6,
        totalChunks: 1,
        chunkSize: 6,
      }),
    });
    await storeUploadChunk({
      accessScope: ALICE_SCOPE,
      fileId: "shared-file-id",
      chunkIndex: 0,
      totalChunks: 1,
      chunkBuffer: Buffer.from("ABCDEF"),
    });

    const claims = await Promise.allSettled([
      claimUploadSessionFinalization({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
      }),
      claimUploadSessionFinalization({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
      }),
    ]);
    const winningClaim = claims.find((claim) => claim.status === "fulfilled");
    const losingClaim = claims.find((claim) => claim.status === "rejected");

    assert.ok(winningClaim);
    assert.equal(losingClaim.reason.status, 409);
    await assertUploadError(
      () =>
        finalizeUploadSession({
          accessScope: ALICE_SCOPE,
          fileId: "shared-file-id",
          claimToken: "not-the-winning-token",
          destinationPath: path.join(tempRoot, "must-not-publish.pdf"),
        }),
      {
        status: 409,
        pattern: /not claimed for finalization/i,
      }
    );
    assert.equal(
      await releaseUploadSessionFinalization({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
        claimToken: "not-the-winning-token",
      }),
      false
    );
    assert.equal(
      await releaseUploadSessionFinalization({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
        claimToken: winningClaim.value.claimToken,
      }),
      true
    );

    const retryClaim = await claimUploadSessionFinalization({
      accessScope: ALICE_SCOPE,
      fileId: "shared-file-id",
    });
    await finalizeUploadSession({
      accessScope: ALICE_SCOPE,
      fileId: "shared-file-id",
      claimToken: retryClaim.claimToken,
      destinationPath: path.join(tempRoot, "published.pdf"),
    });
    assert.equal(
      await readFile(path.join(tempRoot, "published.pdf"), "utf8"),
      "ABCDEF"
    );
  });
});

test("startup recovery removes an interrupted or malformed finalization claim", async () => {
  await withUploadStore(
    "finalization-recovery",
    async ({ sessionsDirectory }) => {
      await initializeUploadSession({
        accessScope: ALICE_SCOPE,
        ...createMetadata({
          fileSize: 6,
          totalChunks: 1,
          chunkSize: 6,
        }),
      });
      await storeUploadChunk({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
        chunkIndex: 0,
        totalChunks: 1,
        chunkBuffer: Buffer.from("ABCDEF"),
      });
      await claimUploadSessionFinalization({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
      });

      assert.deepEqual(await recoverInterruptedUploadFinalizations(), {
        recoveredClaims: 0,
      });
      assert.deepEqual(
        await cleanupExpiredUploadSessions({
          ttlMs: 1,
          now: Date.now() + 10_000,
        }),
        {
          removedSessions: 0,
        }
      );
      assert.ok(
        await getUploadSessionStatus({
          accessScope: ALICE_SCOPE,
          fileId: "shared-file-id",
        })
      );
      await assertUploadError(
        () =>
          claimUploadSessionFinalization({
            accessScope: ALICE_SCOPE,
            fileId: "shared-file-id",
          }),
        {
          status: 409,
          pattern: /already being finalized/i,
        }
      );

      const [sessionDirectoryName] = await readdir(sessionsDirectory);
      const claimPath = path.join(
        sessionsDirectory,
        sessionDirectoryName,
        "finalizing.json"
      );
      await writeFile(
        claimPath,
        JSON.stringify({
          ownerPid: process.ppid,
        })
      );
      assert.deepEqual(await recoverInterruptedUploadFinalizations(), {
        recoveredClaims: 1,
      });

      await claimUploadSessionFinalization({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
      });
      const interruptedClaim = JSON.parse(await readFile(claimPath, "utf8"));
      await writeFile(
        claimPath,
        JSON.stringify({
          ...interruptedClaim,
          ownerInstanceId: "interrupted-process",
          ownerPid: 0,
        })
      );
      assert.deepEqual(await recoverInterruptedUploadFinalizations(), {
        recoveredClaims: 1,
      });
      const recoveredClaim = await claimUploadSessionFinalization({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
      });
      assert.ok(recoveredClaim.claimToken);

      await writeFile(claimPath, "{");
      assert.deepEqual(await recoverInterruptedUploadFinalizations(), {
        recoveredClaims: 1,
      });
    }
  );
});

test("TTL cleanup and finalization cannot both win the same session", async () => {
  await withUploadStore(
    "cleanup-finalization-race",
    async ({ sessionsDirectory }) => {
      await initializeUploadSession({
        accessScope: ALICE_SCOPE,
        ...createMetadata({
          fileSize: 6,
          totalChunks: 1,
          chunkSize: 6,
        }),
      });
      await storeUploadChunk({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
        chunkIndex: 0,
        totalChunks: 1,
        chunkBuffer: Buffer.from("ABCDEF"),
      });

      const [sessionDirectoryName] = await readdir(sessionsDirectory);
      const sessionDirectory = path.join(
        sessionsDirectory,
        sessionDirectoryName
      );
      await Promise.all(
        Array.from({ length: 400 }, (_, index) =>
          writeFile(path.join(sessionDirectory, `filler-${index}`), "x")
        )
      );

      const cleanupPromise = cleanupExpiredUploadSessions({
        ttlMs: 1,
        now: Date.now() + 10_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
      const claimPromise = claimUploadSessionFinalization({
        accessScope: ALICE_SCOPE,
        fileId: "shared-file-id",
      });
      const [cleanupResult, claimResult] = await Promise.allSettled([
        cleanupPromise,
        claimPromise,
      ]);

      assert.equal(cleanupResult.status, "fulfilled");

      if (claimResult.status === "fulfilled") {
        assert.deepEqual(cleanupResult.value, {
          removedSessions: 0,
        });
        assert.ok(
          await getUploadSessionStatus({
            accessScope: ALICE_SCOPE,
            fileId: "shared-file-id",
          })
        );
      } else {
        assert.ok(
          claimResult.reason.status === 404 ||
            claimResult.reason.status === 409
        );
        assert.deepEqual(cleanupResult.value, {
          removedSessions: 1,
        });
      }
    }
  );
});

test("legacy unscoped session directories are not claimed by the v2 trust domain", async () => {
  await withUploadStore("legacy", async ({ sessionsDirectory }) => {
    const fileId = "legacy-file";
    const legacyDirectory = path.join(
      sessionsDirectory,
      createHash("sha256").update(fileId).digest("hex")
    );
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(
      path.join(legacyDirectory, "manifest.json"),
      JSON.stringify(createMetadata({ fileId }))
    );
    await writeFile(path.join(legacyDirectory, "chunk-0"), "legacy");

    assert.equal(
      await getUploadSessionStatus({
        accessScope: {},
        fileId,
      }),
      null
    );

    const fresh = await initializeUploadSession({
      accessScope: {},
      ...createMetadata({ fileId }),
    });
    assert.deepEqual(fresh.uploadedChunks, []);
    assert.equal(await readFile(path.join(legacyDirectory, "chunk-0"), "utf8"), "legacy");
  });
});
