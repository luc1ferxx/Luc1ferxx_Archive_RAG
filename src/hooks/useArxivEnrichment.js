import { useCallback, useState } from "react";
import { message } from "antd";
import {
  fetchDocumentArxivSuggestions,
  fetchSavedArxivSuggestions,
  fetchSavedDocumentArxivSuggestion,
  requestDocumentArxivImport,
} from "../archiveApi";

const DEFAULT_SUGGESTION_LIMIT = 3;

const getBackendMessage = (error, fallbackMessage) =>
  error.response?.data?.error ?? fallbackMessage;

const formatArxivPaperCount = (count) =>
  `${count} arXiv paper${count === 1 ? "" : "s"}`;

const getSuggestionDocId = (suggestion) => suggestion?.document?.docId ?? "";

const hasImportablePapers = (suggestion) =>
  (suggestion?.papers ?? []).length > 0 && Boolean(suggestion?.selectionToken);

const buildSavedSuggestionMap = (suggestions = []) =>
  Object.fromEntries(
    suggestions
      .filter(hasImportablePapers)
      .map((suggestion) => [getSuggestionDocId(suggestion), suggestion])
      .filter(([docId]) => docId)
  );

export const useArxivEnrichment = ({ onImportComplete, onTaskChange } = {}) => {
  const [suggestion, setSuggestion] = useState(null);
  const [savedSuggestionsByDocId, setSavedSuggestionsByDocId] = useState({});
  const [isSuggestionLoading, setIsSuggestionLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const clearSuggestion = useCallback(() => {
    setSuggestion(null);
  }, []);

  const clearSavedSuggestions = useCallback(() => {
    setSavedSuggestionsByDocId({});
  }, []);

  const upsertSavedSuggestion = useCallback((nextSuggestion) => {
    const docId = getSuggestionDocId(nextSuggestion);

    if (!docId) {
      return;
    }

    setSavedSuggestionsByDocId((currentSuggestionsByDocId) => {
      if (!hasImportablePapers(nextSuggestion)) {
        const remainingSuggestions = {
          ...currentSuggestionsByDocId,
        };

        delete remainingSuggestions[docId];
        return remainingSuggestions;
      }

      return {
        ...currentSuggestionsByDocId,
        [docId]: nextSuggestion,
      };
    });
  }, []);

  const loadSavedSuggestions = useCallback(async ({ merge = false } = {}) => {
    try {
      const result = await fetchSavedArxivSuggestions();
      const savedSuggestions = Array.isArray(result?.suggestions)
        ? result.suggestions
        : [];
      const nextSavedSuggestionMap = buildSavedSuggestionMap(savedSuggestions);

      setSavedSuggestionsByDocId((currentSuggestionsByDocId) =>
        merge
          ? {
              ...currentSuggestionsByDocId,
              ...nextSavedSuggestionMap,
            }
          : nextSavedSuggestionMap
      );
      return savedSuggestions;
    } catch (error) {
      message.warning(
        getBackendMessage(error, "Unable to load saved arXiv recommendations.")
      );
      return [];
    }
  }, []);

  const openSavedSuggestion = useCallback(
    async (docId) => {
      const cachedSuggestion = savedSuggestionsByDocId[docId];

      if (hasImportablePapers(cachedSuggestion)) {
        setSuggestion(cachedSuggestion);
        return true;
      }

      try {
        const savedSuggestion = await fetchSavedDocumentArxivSuggestion(docId);

        upsertSavedSuggestion(savedSuggestion);

        if (hasImportablePapers(savedSuggestion)) {
          setSuggestion(savedSuggestion);
          return true;
        }

        message.info("No saved arXiv recommendations for this document.");
        return false;
      } catch (error) {
        message.warning(
          getBackendMessage(error, "Unable to load saved arXiv recommendations.")
        );
        return false;
      }
    },
    [savedSuggestionsByDocId, upsertSavedSuggestion]
  );

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

      upsertSavedSuggestion(nextSuggestion);
      await onTaskChange?.();

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
  }, [onTaskChange, upsertSavedSuggestion]);

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
      await onTaskChange?.();
      await loadSavedSuggestions();
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
  }, [loadSavedSuggestions, onImportComplete, onTaskChange, suggestion]);

  return {
    clearSuggestion,
    clearSavedSuggestions,
    importSuggestion,
    isImporting,
    isSuggestionLoading,
    loadSavedSuggestions,
    openSavedSuggestion,
    requestSuggestions,
    savedSuggestionsByDocId,
    suggestion,
  };
};
