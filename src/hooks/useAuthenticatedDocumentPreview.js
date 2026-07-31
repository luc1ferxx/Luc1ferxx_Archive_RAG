import { useEffect, useState } from "react";
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
