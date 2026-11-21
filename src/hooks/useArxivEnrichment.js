import { useCallback, useRef, useState } from "react";
import { message } from "antd";
import {
  fetchDocumentArxivSuggestions,
  fetchSavedArxivSuggestions,
  fetchSavedDocumentArxivSuggestion,
  requestDocumentArxivImport,
  requestTaskAction,
} from "../archiveApi";
import { createTranslator } from "../archiveI18n";

const DEFAULT_SUGGESTION_LIMIT = 3;

// English unless the app hands in its translator.
const defaultT = createTranslator("en");

const getBackendMessage = (error, fallbackMessage) =>
  error.response?.data?.error ?? fallbackMessage;

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

export const useArxivEnrichment = ({
  onImportComplete,
  onTaskChange,
  t = defaultT,
} = {}) => {
  const [suggestion, setSuggestion] = useState(null);
  const [savedSuggestionsByDocId, setSavedSuggestionsByDocId] = useState({});
  const [isSuggestionLoading, setIsSuggestionLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  // Read when a toast shows: the loaders stay the same functions across a
  // language switch, so the app's effects that call them do not refetch.
  const tRef = useRef(t);

  tRef.current = t;

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
      message.warning(getBackendMessage(error, tRef.current("arxiv.loadSavedFailed")));
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

        message.info(tRef.current("arxiv.noSaved"));
        return false;
      } catch (error) {
        message.warning(getBackendMessage(error, tRef.current("arxiv.loadSavedFailed")));
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

      return nextSuggestion;
    } catch (error) {
      message.warning(getBackendMessage(error, tRef.current("arxiv.checkFailed")));
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
      message.info(tRef.current("arxiv.selectAtLeastOne"));
      return;
    }

    setIsImporting(true);

    try {
      const taskId = suggestion?.task?.id;

      if (taskId) {
        await requestTaskAction(taskId, "confirm", {
          docId,
          selectedArxivIds,
          selectionToken,
        });
        await onTaskChange?.();
        await loadSavedSuggestions();
        setSuggestion(null);
        message.success(tRef.current("arxiv.importQueued"));
        return;
      }

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
      const t = tRef.current;

      if (importedCount > 0 && skippedCount > 0) {
        message.success(
          t("arxiv.importedSkipped", {
            imported: t("arxiv.paperCount", { count: importedCount }),
            skipped: t("arxiv.paperCount", { count: skippedCount }),
          })
        );
      } else if (importedCount > 0) {
        message.success(
          t("arxiv.imported", { papers: t("arxiv.paperCount", { count: importedCount }) })
        );
      } else if (completedCount > 0) {
        message.info(t("arxiv.alreadyIndexed"));
      } else {
        message.info(t("arxiv.noneImported"));
      }
    } catch (error) {
      message.error(getBackendMessage(error, tRef.current("arxiv.importFailed")));
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
