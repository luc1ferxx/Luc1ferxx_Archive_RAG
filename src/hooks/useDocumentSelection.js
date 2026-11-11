import { useCallback, useMemo, useState } from "react";
import { buildRelevantDocuments } from "../archiveWorkspace";
import { formatDocumentLocation, getLocationUnit } from "../documentLocation";

const EMPTY_DOCUMENTS = [];
const EMPTY_CONVERSATION = [];
const EMPTY_SOURCES = [];

// A slide, sheet or section is named the way the citation list names it
// ("deck.pptx · Slide 3 · Revenue") and never gets a page 1 it does not have;
// a PDF keeps the caption it always had.
const describePreviewStatus = (source, t) => {
  if (!getLocationUnit(source)) {
    return `${source.fileName} · page ${source.pageNumber ?? 1}`;
  }

  return [source.fileName, formatDocumentLocation(source, t)]
    .filter(Boolean)
    .join(" · ");
};

export const useDocumentSelection = ({
  activeDocuments = EMPTY_DOCUMENTS,
  conversation = EMPTY_CONVERSATION,
  currentTurn = null,
  setActiveTurnIndex,
  t,
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
    ? describePreviewStatus(selectedSource, t)
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
