import { useCallback, useEffect, useMemo, useState } from "react";
import { isArxivDocument } from "../archiveWorkspace";

const CHAT_SCOPE_MODES = {
  uploaded: "uploaded",
  all: "all",
  selected: "selected",
};

export { CHAT_SCOPE_MODES };

export const useChatScope = ({ activeDocuments, t }) => {
  const [chatScopeMode, setChatScopeMode] = useState(CHAT_SCOPE_MODES.uploaded);
  const [selectedChatDocIds, setSelectedChatDocIds] = useState([]);

  const uploadedDocuments = useMemo(
    () => activeDocuments.filter((document) => !isArxivDocument(document)),
    [activeDocuments]
  );
  const selectedChatDocuments = useMemo(
    () =>
      activeDocuments.filter((document) =>
        selectedChatDocIds.includes(document.docId)
      ),
    [activeDocuments, selectedChatDocIds]
  );
  const chatScopeDocuments = useMemo(() => {
    if (chatScopeMode === CHAT_SCOPE_MODES.all) {
      return activeDocuments;
    }

    if (chatScopeMode === CHAT_SCOPE_MODES.selected) {
      return selectedChatDocuments;
    }

    return uploadedDocuments;
  }, [activeDocuments, chatScopeMode, selectedChatDocuments, uploadedDocuments]);
  const chatDocIds = useMemo(
    () => chatScopeDocuments.map((document) => document.docId),
    [chatScopeDocuments]
  );
  const chatDocLabel = useMemo(
    () =>
      chatScopeDocuments.length > 0
        ? t("common.docs", { count: chatScopeDocuments.length })
        : t("common.noDocumentsInScope"),
    [chatScopeDocuments.length, t]
  );
  const chatScopeOptions = useMemo(
    () => [
      {
        count: uploadedDocuments.length,
        id: CHAT_SCOPE_MODES.uploaded,
        label: t("common.uploaded"),
      },
      {
        count: activeDocuments.length,
        id: CHAT_SCOPE_MODES.all,
        label: t("common.all"),
      },
      {
        count: selectedChatDocuments.length,
        id: CHAT_SCOPE_MODES.selected,
        label: t("common.selected"),
      },
    ],
    [activeDocuments.length, selectedChatDocuments.length, t, uploadedDocuments.length]
  );
  const toggleChatScopeDocument = useCallback((docId) => {
    setSelectedChatDocIds((currentDocIds) =>
      currentDocIds.includes(docId)
        ? currentDocIds.filter((currentDocId) => currentDocId !== docId)
        : [...currentDocIds, docId]
    );
  }, []);

  useEffect(() => {
    const activeDocIdSet = new Set(activeDocuments.map((document) => document.docId));

    setSelectedChatDocIds((currentDocIds) =>
      currentDocIds.filter((docId) => activeDocIdSet.has(docId))
    );
  }, [activeDocuments]);

  useEffect(() => {
    if (activeDocuments.length === 0) {
      return;
    }

    if (
      chatScopeMode === CHAT_SCOPE_MODES.uploaded &&
      uploadedDocuments.length === 0
    ) {
      setChatScopeMode(CHAT_SCOPE_MODES.all);
      return;
    }

    if (
      chatScopeMode === CHAT_SCOPE_MODES.selected &&
      selectedChatDocuments.length === 0
    ) {
      setChatScopeMode(
        uploadedDocuments.length > 0 ? CHAT_SCOPE_MODES.uploaded : CHAT_SCOPE_MODES.all
      );
    }
  }, [
    activeDocuments.length,
    chatScopeMode,
    selectedChatDocuments.length,
    uploadedDocuments.length,
  ]);

  return {
    chatDocIds,
    chatDocLabel,
    chatScopeDocuments,
    chatScopeMode,
    chatScopeOptions,
    selectedChatDocIds,
    setChatScopeMode,
    setSelectedChatDocIds,
    toggleChatScopeDocument,
  };
};
