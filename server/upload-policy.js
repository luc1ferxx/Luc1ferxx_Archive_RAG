export const DEFAULT_UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024;
export const MAX_DIRECT_UPLOAD_SIZE = 50 * 1024 * 1024;
export const MAX_CHUNK_UPLOAD_SIZE = 5 * 1024 * 1024;
export const MAX_RESUMABLE_UPLOAD_SIZE = 100 * 1024 * 1024;
export const MAX_UPLOAD_CHUNKS = 100;
export const MAX_UPLOAD_FILE_NAME_BYTES = 255;
export const MAX_UPLOAD_FILE_ID_BYTES = 512;
export const MAX_UPLOAD_MULTIPART_FIELD_BYTES = 1024;
export const MAX_UPLOAD_MULTIPART_FIELDS = 4;

const unsafeUploadFileNamePattern = /[\u0000-\u001f\u007f-\u009f/\\]/u;

export const isSafeUploadFileName = (value) => {
  const fileName = String(value ?? "");

  return (
    fileName.length > 0 &&
    fileName === fileName.trim() &&
    Buffer.byteLength(fileName, "utf8") <= MAX_UPLOAD_FILE_NAME_BYTES &&
    !unsafeUploadFileNamePattern.test(fileName)
  );
};
