import { useCallback, useEffect, useMemo, useState } from "react";
import { message } from "antd";
import {
  fetchDocuments,
  requestDocumentClear,
  requestDocumentDelete,
} from "../archiveApi";
import {
  formatDocumentCount,
  getTotalPages,
} from "../archiveWorkspace";

const getBackendMessage = (error, fallbackMessage) =>
  error.response?.data?.error ?? fallbackMessage;

export const useWorkspaceDocuments = () => {
  const [activeDocuments, setActiveDocuments] = useState([]);

  useEffect(() => {
    let cancelled = false;

    const loadDocuments = async () => {
      try {
        const documents = await fetchDocuments();

        if (!cancelled) {
          setActiveDocuments(documents);
        }
      } catch (error) {
        if (!cancelled) {
          if (error.code === "ERR_NETWORK") {
            console.warn("Persisted documents are unavailable:", error.message);
          } else {
            message.error(
              getBackendMessage(error, "Unable to load persisted documents.")
            );
          }
        }
      }
    };

    void loadDocuments();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleUploadSuccess = useCallback((document) => {
    setActiveDocuments((prev) => {
      if (
        prev.some(
          (existingDocument) => existingDocument.docId === document.docId
        )
      ) {
        return prev;
      }

      return [...prev, document];
    });
  }, []);

  const removeDocument = useCallback(async (docId, { afterSuccess } = {}) => {
    try {
      await requestDocumentDelete(docId);
      setActiveDocuments((prev) =>
        prev.filter((document) => document.docId !== docId)
      );
      await afterSuccess?.();
      message.success("Document removed.");
    } catch (error) {
      message.error(
        getBackendMessage(error, "Unable to remove the document.")
      );
    }
  }, []);

  const clearDocuments = useCallback(async ({ afterSuccess } = {}) => {
    try {
      await requestDocumentClear();
      setActiveDocuments([]);
      await afterSuccess?.();
      message.success("All documents cleared.");
    } catch (error) {
      message.error(getBackendMessage(error, "Unable to clear documents."));
    }
  }, []);

  const docIds = useMemo(
    () => activeDocuments.map((document) => document.docId),
    [activeDocuments]
  );
  const docLabel = useMemo(
    () =>
      activeDocuments.length === 1
        ? activeDocuments[0].fileName
        : formatDocumentCount(activeDocuments.length),
    [activeDocuments]
  );
  const totalPages = useMemo(
    () => getTotalPages(activeDocuments),
    [activeDocuments]
  );

  return {
    activeDocuments,
    clearDocuments,
    docIds,
    docLabel,
    handleUploadSuccess,
    removeDocument,
    totalPages,
  };
};
