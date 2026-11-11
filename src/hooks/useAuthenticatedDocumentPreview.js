import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDocumentFile } from "../archiveApi";

const IDLE_PREVIEW = {
  objectUrl: "",
  status: "idle",
};

const LOADING_PREVIEW = {
  objectUrl: "",
  status: "loading",
};

const ERROR_PREVIEW = {
  objectUrl: "",
  status: "error",
};

const getBaseMimeType = (value) =>
  String(value ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

const isPdfDownload = (download) => {
  if (!(download?.blob instanceof Blob)) {
    return false;
  }

  const declaredMimeTypes = [download.mimeType, download.blob.type]
    .map(getBaseMimeType)
    .filter(Boolean);

  return (
    declaredMimeTypes.length > 0 &&
    declaredMimeTypes.every((mimeType) => mimeType === "application/pdf")
  );
};

export const useAuthenticatedDocumentPreview = ({
  docId,
  enabled = false,
} = {}) => {
  const normalizedDocId = String(docId ?? "").trim();
  const [preview, setPreview] = useState({
    ...IDLE_PREVIEW,
    ownerDocId: "",
  });

  useEffect(() => {
    if (!enabled) {
      setPreview({
        ...IDLE_PREVIEW,
        ownerDocId: "",
      });
      return undefined;
    }

    if (!normalizedDocId) {
      setPreview({
        ...ERROR_PREVIEW,
        ownerDocId: "",
      });
      return undefined;
    }

    const controller = new AbortController();
    let isClosed = false;
    let ownedObjectUrl = "";

    setPreview({
      objectUrl: "",
      ownerDocId: normalizedDocId,
      status: "loading",
    });

    void fetchDocumentFile(normalizedDocId, {
      signal: controller.signal,
    })
      .then((download) => {
        if (isClosed || controller.signal.aborted) {
          return;
        }

        if (!isPdfDownload(download)) {
          throw new Error("The document response is not a PDF.");
        }

        const objectUrl = window.URL.createObjectURL(download.blob);

        if (isClosed || controller.signal.aborted) {
          window.URL.revokeObjectURL(objectUrl);
          return;
        }

        ownedObjectUrl = objectUrl;
        setPreview({
          objectUrl,
          ownerDocId: normalizedDocId,
          status: "ready",
        });
      })
      .catch(() => {
        if (isClosed || controller.signal.aborted) {
          return;
        }

        setPreview({
          objectUrl: "",
          ownerDocId: normalizedDocId,
          status: "error",
        });
      });

    return () => {
      isClosed = true;
      controller.abort();

      if (ownedObjectUrl) {
        window.URL.revokeObjectURL(ownedObjectUrl);
      }
    };
  }, [enabled, normalizedDocId]);

  if (!enabled) {
    return IDLE_PREVIEW;
  }

  if (!normalizedDocId) {
    return ERROR_PREVIEW;
  }

  if (preview.ownerDocId !== normalizedDocId) {
    return LOADING_PREVIEW;
  }

  return {
    objectUrl: preview.objectUrl,
    status: preview.status,
  };
};

const IDLE_DOWNLOAD = {
  errorMessage: "",
  ownerDocId: "",
  status: "idle",
};

// Only the server's own JSON refusal ("Document not found.", the permission
// message apiClient builds for a 403) is shown; a client-side error message
// can quote request details, so it never reaches the page.
const getDownloadErrorMessage = (error) => {
  const serverError = error?.response?.data?.error;

  if (typeof serverError === "string" && serverError.trim()) {
    return serverError;
  }

  return typeof serverError?.message === "string" ? serverError.message : "";
};

const saveBlob = (blob, fileName) => {
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);

  try {
    link.click();
  } finally {
    link.remove();
    window.URL.revokeObjectURL(objectUrl);
  }
};

/**
 * Saves a document's stored file through the same authenticated request the
 * inline PDF preview makes (fetchDocumentFile), for the formats a browser
 * cannot show inline (Word, PowerPoint, Excel). The saved name is the
 * server's Content-Disposition name, else `fileName`. A click while a
 * download runs is ignored; switching documents or unmounting aborts it and
 * saves nothing. `status` is "idle", "downloading" or "error" (with the
 * server's message in `errorMessage` when it sent one).
 */
export const useAuthenticatedDocumentDownload = ({ docId, fileName } = {}) => {
  const normalizedDocId = String(docId ?? "").trim();
  const [download, setDownload] = useState(IDLE_DOWNLOAD);
  const controllerRef = useRef(null);
  const downloadCountRef = useRef(0);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [normalizedDocId]
  );

  const startDownload = useCallback(async () => {
    if (!normalizedDocId || controllerRef.current) {
      return;
    }

    const controller = new AbortController();
    downloadCountRef.current += 1;
    const downloadId = downloadCountRef.current;
    controllerRef.current = controller;
    setDownload({
      downloadId,
      errorMessage: "",
      ownerDocId: normalizedDocId,
      status: "downloading",
    });

    // An aborted download (the user moved to another document, or the view
    // unmounted) goes back to idle, unless another download has started since:
    // left "downloading", coming back to the document would show a button
    // that ignores every click.
    const settleAborted = () =>
      setDownload((current) => (current.downloadId === downloadId ? IDLE_DOWNLOAD : current));

    try {
      const result = await fetchDocumentFile(normalizedDocId, {
        signal: controller.signal,
      });

      if (controller.signal.aborted) {
        settleAborted();
        return;
      }

      if (!(result?.blob instanceof Blob)) {
        throw new Error("The document response is not a file.");
      }

      saveBlob(result.blob, result.fileName || fileName || "document");
      setDownload(IDLE_DOWNLOAD);
    } catch (error) {
      if (controller.signal.aborted) {
        settleAborted();
        return;
      }

      setDownload({
        errorMessage: getDownloadErrorMessage(error),
        ownerDocId: normalizedDocId,
        status: "error",
      });
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }, [fileName, normalizedDocId]);

  const isCurrent = Boolean(normalizedDocId) && download.ownerDocId === normalizedDocId;

  return {
    download: startDownload,
    errorMessage: isCurrent ? download.errorMessage : "",
    status: isCurrent ? download.status : "idle",
  };
};
