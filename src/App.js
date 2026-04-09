import React, { useState } from "react";
import { Button, Layout, Tag, Typography } from "antd";
import PdfUploader from "./components/PdfUploader";
import ChatComponent from "./components/ChatComponent";
import RenderQA from "./components/RenderQA";
import PdfPreview from "./components/PdfPreview";
import "./App.css";

const App = () => {
  const [conversation, setConversation] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeDocuments, setActiveDocuments] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const { Content } = Layout;
  const { Paragraph, Text, Title } = Typography;

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

  const removeDocument = (docId) => {
    setActiveDocuments((prev) =>
      prev.filter((document) => document.docId !== docId)
    );
    setSelectedSource((prev) => (prev?.docId === docId ? null : prev));
  };

  const clearDocuments = () => {
    setActiveDocuments([]);
    setSelectedSource(null);
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
                onClick={clearDocuments}
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
                        removeDocument(document.docId);
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
