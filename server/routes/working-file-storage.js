// The multer storage engine of POST /upload and PUT /documents/:docId: the
// stock disk storage, except that with TENANT_ENCRYPTION=on the file is
// encrypted as it streams in (a working file, rag/working-files.js), so the
// upload never rests on disk in plaintext, not even for the request. Readers
// go through readWorkingFile; req.file.size is the plaintext size. Off, every
// call goes to multer's own disk storage unchanged.
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream";
import multer from "multer";

import { isTenantEncryptionEnabled } from "../rag/config.js";
import { createWorkingFileEncryptStream } from "../rag/working-files.js";

// Marks a file this engine encrypted, on the file object and on the info
// multer spreads into its copies, so _removeFile knows which way to remove it.
const ENCRYPTED_WORKING_FILE = Symbol("encryptedWorkingFile");

export const createWorkingFileDiskStorage = ({ destination, filename }) => {
  const disk = multer.diskStorage({ destination, filename });

  return {
    _handleFile(req, file, cb) {
      if (!isTenantEncryptionEnabled()) {
        disk._handleFile(req, file, cb);
        return;
      }

      destination(req, file, (destinationError, directory) => {
        if (destinationError) {
          cb(destinationError);
          return;
        }

        filename(req, file, (filenameError, name) => {
          if (filenameError) {
            cb(filenameError);
            return;
          }

          if (file.stream.destroyed) {
            cb(new multer.MulterError("STREAM_DESTROYED"));
            return;
          }

          const finalPath = path.join(directory, name);
          const encryptor = createWorkingFileEncryptStream();
          const output = createWriteStream(finalPath, { flags: "wx", mode: 0o600 });

          // As the disk storage does: an abort that lands while the file is
          // still being written finds it here and removes it.
          file.path = finalPath;
          file[ENCRYPTED_WORKING_FILE] = true;

          pipeline(file.stream, encryptor, output, (pipelineError) => {
            if (pipelineError) {
              rm(finalPath, { force: true }).then(
                () => cb(pipelineError),
                () => cb(pipelineError)
              );
              return;
            }

            cb(null, {
              [ENCRYPTED_WORKING_FILE]: true,
              destination: directory,
              filename: name,
              path: finalPath,
              size: encryptor.plaintextBytes,
            });
          });
        });
      });
    },

    _removeFile(req, file, cb) {
      if (!file?.[ENCRYPTED_WORKING_FILE]) {
        disk._removeFile(req, file, cb);
        return;
      }

      const filePath = file.path;

      delete file.destination;
      delete file.filename;
      delete file.path;
      rm(filePath, { force: true }).then(() => cb(null), cb);
    },
  };
};
