import React, { useEffect, useState } from "react";
import axios from "axios";
import { Button, Layout, Tag, Typography, message } from "antd";
import PdfUploader from "./components/PdfUploader";
import ChatComponent from "./components/ChatComponent";
import RenderQA from "./components/RenderQA";
import PdfPreview from "./components/PdfPreview";
import { API_DOMAIN } from "./config";
import "./App.css";

const SESSION_STORAGE_KEY = "archive-session-id";

const createSessionId = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : null) ??
  `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const readStoredSessionId = () => {
  try {
    const storedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
    return storedSessionId?.trim() ? storedSessionId : createSessionId();
  } catch {
    return createSessionId();
  }
};

const persistSessionId = (sessionId) => {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch {
    // Ignore localStorage failures for browsers with restricted storage access.
  }
};

const fetchDocuments = async () => {
  const response = await axios.get(`${API_DOMAIN}/documents`);
  return response.data;
};

const requestDocumentDelete = async (docId) => {
  const response = await axios.delete(`${API_DOMAIN}/documents/${docId}`);
  return response.data;
};

const requestDocumentClear = async () => {
  const response = await axios.post(`${API_DOMAIN}/documents/clear`);
  return response.data;
};

const requestSessionClear = async (sessionId) => {
  if (!sessionId) {
    return;
  }

  await axios.delete(`${API_DOMAIN}/sessions/${sessionId}`);
};

const App = () => {
  const [conversation, setConversation] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeDocuments, setActiveDocuments] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [sessionId, setSessionId] = useState(() => readStoredSessionId());
  const { Content } = Layout;
  const { Paragraph, Text, Title } = Typography;

  useEffect(() => {
    persistSessionId(sessionId);
  }, [sessionId]);

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
          const backendMessage =
            error.response?.data?.error ?? "Unable to load persisted documents.";
          message.error(backendMessage);
        }
      }
    };

    void loadDocuments();

    return () => {
      cancelled = true;
    };
  }, []);

  const resetConversationState = () => {
    setConversation([]);
    setSelectedSource(null);
  };

  const rotateSession = async () => {
    const previousSessionId = sessionId;
    const nextSessionId = createSessionId();

    try {
      await requestSessionClear(previousSessionId);
    } catch (error) {
      console.error("Failed to clear persisted session memory:", error);
    }

    setSessionId(nextSessionId);
    persistSessionId(nextSessionId);
  };

  const handleResp = (question, answer) => {
    setConversation((prev) => [...prev, { question, answer }]);
    setSelectedSource(answer?.ragSources?.[0] ?? null);
  };

  const handleUploadSuccess = (document) => {
    setActiveDocuments((prev) => {
      if (prev.some((existingDocument) => existingDocument.docId === document.docId)) {
        return prev;
      }

      return [...prev, document];
    });
    setSelectedSource(null);
  };

  const removeDocument = async (docId) => {
    try {
      await requestDocumentDelete(docId);
      setActiveDocuments((prev) =>
        prev.filter((document) => document.docId !== docId)
      );
      resetConversationState();
      await rotateSession();
      message.success("Document removed.");
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? "Unable to remove the document.";
      message.error(backendMessage);
    }
  };

  const clearDocuments = async () => {
    try {
      await requestDocumentClear();
      setActiveDocuments([]);
      resetConversationState();
      await rotateSession();
      message.success("All documents cleared.");
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? "Unable to clear documents.";
      message.error(backendMessage);
    }
  };

  const docIds = activeDocuments.map((document) => document.docId);
  const docLabel =
    activeDocuments.length === 1
      ? activeDocuments[0].fileName
      : `${activeDocuments.length} documents`;

  return (
    <div className="archive-shell">
      <Layout className="archive-layout">
        <Content className="archive-content">
          <header className="archive-header">
            <div>
              <div className="archive-mark">Luc1ferxx</div>
              <Title className="archive-title">Luc1ferxx Archive</Title>
              <Paragraph className="archive-subtitle">
                Search your PDFs and compare the answer with live web results.
              </Paragraph>
              <div className="archive-status-row">
                <span className="archive-status-pill">
                  {activeDocuments.length} documents
                </span>
                <span className="archive-status-pill">
                  {conversation.length} responses
                </span>
              </div>
            </div>

            <div className="archive-header-meta">
              <Text className="archive-meta-text">
                {activeDocuments.length} active
              </Text>
              <Button
                className="archive-secondary-button"
                onClick={() => void clearDocuments()}
                disabled={activeDocuments.length === 0}
              >
                Clear
              </Button>
            </div>
          </header>

          <section className="archive-grid">
            <div className="archive-card archive-upload-card">
              <div className="section-label">Upload</div>
              <PdfUploader onUploadSuccess={handleUploadSuccess} />
            </div>

            <div className="archive-card archive-doc-card">
              <div className="section-label">Documents</div>

              {activeDocuments.length > 0 ? (
                <div className="document-list">
                  {activeDocuments.map((document) => (
                    <Tag
                      key={document.docId}
                      closable
                      className="document-pill"
                      onClose={(event) => {
                        event.preventDefault();
                        void removeDocument(document.docId);
                      }}
                    >
                      <span className="document-pill-name">{document.fileName}</span>
                      <span className="document-pill-meta">
                        {document.pageCount ?? "?"} pages
                      </span>
                    </Tag>
                  ))}
                </div>
              ) : (
                <div className="archive-empty-state">
                  Add one or more PDFs to start a session.
                </div>
              )}
            </div>
          </section>

          <section className="archive-main-grid">
            <div className="archive-card archive-conversation-card">
              <div className="conversation-header">
                <div className="section-label">Conversation</div>
                <Text className="archive-meta-text">
                  {conversation.length} messages
                </Text>
              </div>
              <RenderQA
                conversation={conversation}
                isLoading={isLoading}
                selectedSource={selectedSource}
                onSelectSource={setSelectedSource}
              />
            </div>

            <div className="archive-card archive-preview-card">
              <div className="section-label">Preview</div>
              <PdfPreview source={selectedSource} />
            </div>
          </section>

          <div className="archive-composer">
            <ChatComponent
              docIds={docIds}
              docLabel={docLabel}
              sessionId={sessionId}
              handleResp={handleResp}
              isLoading={isLoading}
              setIsLoading={setIsLoading}
            />
          </div>
        </Content>
      </Layout>
    </div>
  );
};

export default App;
