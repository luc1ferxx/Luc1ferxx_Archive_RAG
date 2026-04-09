import React from "react";
import { Spin } from "antd";

const RenderQA = (props) => {
  const { conversation, isLoading, selectedSource, onSelectSource } = props;

  if (!conversation?.length && !isLoading) {
    return (
      <div className="archive-empty-log">
        Ask a question after uploading your PDFs.
      </div>
    );
  }

  return (
    <div className="archive-log">
      {conversation?.map((each, index) => {
        return (
          <article key={index} className="archive-entry">
            <div className="archive-question">{each.question}</div>

            <div className="archive-answer-grid">
              <section className="archive-answer-card">
                <div className="archive-answer-label">Document answer</div>
                <div className="archive-answer-text">{each.answer.ragAnswer}</div>

                {each.answer.ragSources?.length > 0 && (
                  <div className="archive-source-list">
                    {each.answer.ragSources.map((source) => (
                      <button
                        key={`${source.docId}-${source.chunkIndex}-${source.rank}`}
                        type="button"
                        className={`archive-source-item ${
                          selectedSource?.docId === source.docId &&
                          selectedSource?.chunkIndex === source.chunkIndex
                            ? "is-selected"
                            : ""
                        }`}
                        onClick={() => onSelectSource?.(source)}
                      >
                        <div className="archive-source-head">
                          <span>{source.fileName}</span>
                          <span>
                            {source.pageNumber ? `Page ${source.pageNumber}` : ""}
                          </span>
                        </div>
                        <div className="archive-source-copy">{source.excerpt}</div>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="archive-answer-card archive-answer-card-secondary">
                <div className="archive-answer-label">Web answer</div>
                <div className="archive-answer-text">{each.answer.mcpAnswer}</div>
              </section>
            </div>
          </article>
        );
      })}

      {isLoading && (
        <div className="archive-loading">
          <Spin size="large" />
        </div>
      )}
    </div>
  );
};

export default RenderQA;
