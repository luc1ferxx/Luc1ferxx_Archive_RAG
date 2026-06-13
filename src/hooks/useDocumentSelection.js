import { useCallback, useMemo, useState } from "react";
import { buildRelevantDocuments } from "../archiveWorkspace";

const EMPTY_DOCUMENTS = [];
const EMPTY_CONVERSATION = [];
const EMPTY_SOURCES = [];

export const useDocumentSelection = ({
  activeDocuments = EMPTY_DOCUMENTS,
  conversation = EMPTY_CONVERSATION,
  currentTurn = null,
  setActiveTurnIndex,
} = {}) => {
  const [selectedSource, setSelectedSource] = useState(null);
  const currentSources = currentTurn?.answer?.ragSources ?? EMPTY_SOURCES;
  const selectedDocId = selectedSource?.docId ?? null;
  const relevantDocuments = useMemo(
    () =>
      buildRelevantDocuments({
        activeDocuments,
        currentSources,
      }),
    [activeDocuments, currentSources]
  );
  const previewStatus = selectedSource
    ? `${selectedSource.fileName} · page ${selectedSource.pageNumber ?? 1}`
    : "Choose a citation or relevant document";

  const resetSelection = useCallback(() => {
    setSelectedSource(null);
  }, []);

  const selectTurn = useCallback(
    (turnIndex) => {
      setActiveTurnIndex(turnIndex);

      const selectedTurn = conversation[turnIndex];

      if (!selectedTurn) {
        return;
      }

      const turnSources = selectedTurn.answer?.ragSources ?? EMPTY_SOURCES;

      setSelectedSource((currentSelection) => {
        const selectionBelongsToTurn = turnSources.some(
          (source) =>
            source.docId === currentSelection?.docId &&
            source.chunkIndex === currentSelection?.chunkIndex
        );

        return selectionBelongsToTurn
          ? currentSelection
          : turnSources[0] ?? null;
      });
    },
    [conversation, setActiveTurnIndex]
  );

  return {
    previewStatus,
    relevantDocuments,
    resetSelection,
    selectedDocId,
    selectedSource,
    selectTurn,
    setSelectedSource,
  };
};
