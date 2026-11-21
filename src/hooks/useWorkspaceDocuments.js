import { useCallback, useEffect, useMemo, useState } from "react";
import { message } from "antd";
import {
  fetchDocuments,
  requestDocumentClear,
  requestDocumentDelete,
} from "../archiveApi";
import { createTranslator } from "../archiveI18n";
import { getTotalPages } from "../archiveWorkspace";

// English unless the app hands in its translator.
const defaultT = createTranslator("en");

const getBackendMessage = (error, fallbackMessage) =>
  error.response?.data?.error ?? fallbackMessage;

export const useWorkspaceDocuments = ({ t = defaultT } = {}) => {
  const [activeDocuments, setActiveDocuments] = useState([]);

  const refreshDocuments = useCallback(async () => {
    const documents = await fetchDocuments();

    setActiveDocuments(documents);
    return documents;
  }, []);

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
            message.error(getBackendMessage(error, t("app.loadDocumentsFailed")));
          }
        }
      }
    };

    void loadDocuments();

    return () => {
      cancelled = true;
    };
    // Loads once: a language switch is no reason to fetch again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      message.success(t("app.documentRemoved"));
    } catch (error) {
      message.error(getBackendMessage(error, t("app.removeDocumentFailed")));
    }
  }, [t]);

  const clearDocuments = useCallback(async ({ afterSuccess } = {}) => {
    try {
      await requestDocumentClear();
      setActiveDocuments([]);
      await afterSuccess?.();
      message.success(t("app.documentsCleared"));
    } catch (error) {
      message.error(getBackendMessage(error, t("app.clearDocumentsFailed")));
    }
  }, [t]);

  const docIds = useMemo(
    () => activeDocuments.map((document) => document.docId),
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
    handleUploadSuccess,
    refreshDocuments,
    removeDocument,
    totalPages,
  };
};
