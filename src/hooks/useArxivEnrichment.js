import { useCallback, useState } from "react";
import { message } from "antd";
import {
  fetchDocumentArxivSuggestions,
  requestDocumentArxivImport,
} from "../archiveApi";

const DEFAULT_SUGGESTION_LIMIT = 3;

const getBackendMessage = (error, fallbackMessage) =>
  error.response?.data?.error ?? fallbackMessage;

const formatArxivPaperCount = (count) =>
  `${count} arXiv paper${count === 1 ? "" : "s"}`;

export const useArxivEnrichment = ({ onImportComplete } = {}) => {
  const [suggestion, setSuggestion] = useState(null);
  const [isSuggestionLoading, setIsSuggestionLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const clearSuggestion = useCallback(() => {
    setSuggestion(null);
  }, []);

  const requestSuggestions = useCallback(async (document) => {
    if (!document?.docId) {
      return;
    }

    setSuggestion(null);
    setIsSuggestionLoading(true);

    try {
      const nextSuggestion = await fetchDocumentArxivSuggestions(
        document.docId,
        DEFAULT_SUGGESTION_LIMIT
      );

      if ((nextSuggestion.papers ?? []).length > 0) {
        setSuggestion(nextSuggestion);
      }
    } catch (error) {
      message.warning(
        getBackendMessage(error, "Unable to check arXiv suggestions.")
      );
    } finally {
      setIsSuggestionLoading(false);
    }
  }, []);

  const importSuggestion = useCallback(async (selectedArxivIds) => {
    const docId = suggestion?.document?.docId;
    const selectionToken = suggestion?.selectionToken;

    if (!docId || !selectionToken) {
      return;
    }

    if (Array.isArray(selectedArxivIds) && selectedArxivIds.length === 0) {
      message.info("Select at least one arXiv paper to import.");
      return;
    }

    setIsImporting(true);

    try {
      const result = await requestDocumentArxivImport(
        docId,
        selectionToken,
        selectedArxivIds
      );
      const completedCount =
        (result.importedCount ?? 0) + (result.skippedCount ?? 0);

      await onImportComplete?.(result);
      setSuggestion(null);

      const importedCount = result.importedCount ?? 0;
      const skippedCount = result.skippedCount ?? 0;

      if (importedCount > 0 && skippedCount > 0) {
        message.success(
          `Imported ${formatArxivPaperCount(
            importedCount
          )}; ${formatArxivPaperCount(skippedCount)} already indexed.`
        );
      } else if (importedCount > 0) {
        message.success(`Imported ${formatArxivPaperCount(importedCount)}.`);
      } else if (completedCount > 0) {
        message.info("Suggested arXiv papers were already indexed.");
      } else {
        message.info("No arXiv papers were imported.");
      }
    } catch (error) {
      message.error(
        getBackendMessage(error, "Unable to import arXiv papers.")
      );
    } finally {
      setIsImporting(false);
    }
  }, [onImportComplete, suggestion]);

  return {
    clearSuggestion,
    importSuggestion,
    isImporting,
    isSuggestionLoading,
    requestSuggestions,
    suggestion,
  };
};
