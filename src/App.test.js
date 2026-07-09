import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axios from "axios";
import App from "./App";

jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
}));

jest.mock("./components/PdfUploader", () => ({ onUploadSuccess }) => (
  <button
    type="button"
    onClick={() =>
      onUploadSuccess?.({
        docId: "doc-upload",
        fileName: "rag-notes.pdf",
        pageCount: 2,
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      })
    }
  >
    Upload mock
  </button>
));
jest.mock("./components/ChatComponent", () => (props) => (
  <div>
    <div>Chat</div>
    <div data-testid="chat-docids">{props.docIds.join(",")}</div>
    {props.draftQuestion ? (
      <div data-testid="chat-draft">{props.draftQuestion}</div>
    ) : null}
    <button
      type="button"
      onClick={() =>
        props.handleResp?.("Mock question", {
          agentAnswer: "Mock answer",
          ragAnswer: "Mock document answer",
          ragSources: [],
          agentTrace: [],
        })
      }
    >
      Submit mock chat
    </button>
    {(props.chatScopeOptions ?? []).map((option) => (
      <button
        key={option.id}
        type="button"
        onClick={() => props.onChatScopeModeChange?.(option.id)}
      >
        {`scope-${option.id}-${option.count}`}
      </button>
    ))}
  </div>
));
jest.mock("./components/RenderQA", () => (props) => (
  <div>
    {props.conversation?.map((turn, index) => (
      <div key={`${turn.question}-${index}`}>
        {turn.answer?.agentAnswer ?? turn.answer?.ragAnswer}
      </div>
    ))}
    <button
      type="button"
      onClick={() =>
        props.onFeedback?.({
          turnIndex: 0,
          feedbackType: "hallucination",
          note: "This answer is not supported.",
          question: "What changed?",
          answer: {
            agentAnswer: "Unsupported answer.",
            ragSources: [],
          },
        })
      }
    >
      Send feedback
    </button>
  </div>
));
jest.mock("./components/PdfPreview", () => () => <div>Preview</div>);

const openWorkspace = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Open workspace" }));
};

describe("App", () => {
  beforeEach(() => {
    axios.get.mockImplementation((url) => {
      if (url.endsWith("/agent-runs/recovery")) {
        return Promise.resolve({
          data: {
            runs: [],
          },
        });
      }

      if (url.endsWith("/tasks")) {
        return Promise.resolve({
          data: {
            tasks: [],
          },
        });
      }

      return Promise.resolve({
        data: [
          {
            docId: "doc-1",
            fileName: "benefits-2025.pdf",
            pageCount: 3,
          },
        ],
      });
    });
    axios.post.mockResolvedValue({ data: {} });
    axios.delete.mockResolvedValue({ data: {} });
    window.localStorage.clear();
  });

  test("starts on the launch page and opens persisted documents in the workspace", async () => {
    render(<App />);

    expect(
      await screen.findByText("Document AI workspace")
    ).toBeInTheDocument();

    await openWorkspace();

    expect(await screen.findByText("benefits-2025.pdf")).toBeInTheDocument();
    expect(screen.getByText("Corpus")).toBeInTheDocument();
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.getByText("Quality")).toBeInTheDocument();
    expect(screen.getByText("Recovery")).toBeInTheDocument();
    expect(screen.getByText("History")).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith("http://localhost:5001/documents");
  });

  test("switches the launch page and workspace shell between English and Chinese", async () => {
    render(<App />);

    expect(
      await screen.findByText("Document AI workspace")
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Switch language to 中文" })
    );

    expect(await screen.findByText("文档智能工作台")).toBeInTheDocument();
    expect(window.localStorage.getItem("archive-rag.locale")).toBe("zh");

    const homeNavigation = screen.getByRole("navigation", {
      name: "首页导航",
    });

    fireEvent.click(within(homeNavigation).getByRole("button", { name: "技能" }));
    expect(screen.getByRole("region", { name: "文档技能" })).toBeInTheDocument();
    expect(screen.queryByText("Corpus")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开工作台" }));

    expect(await screen.findByText("语料")).toBeInTheDocument();
    expect(screen.getByText("范围")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "切换语言到English" })
    ).toBeInTheDocument();
  });

  test("keeps home navigation on the launch surface until the workspace is opened", async () => {
    render(<App />);

    expect(
      await screen.findByText("Document AI workspace")
    ).toBeInTheDocument();

    const homeNavigation = screen.getByRole("navigation", {
      name: "Home navigation",
    });

    fireEvent.click(within(homeNavigation).getByRole("button", { name: "Skills" }));
    expect(
      screen.getByRole("region", { name: "Document skills" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Corpus")).not.toBeInTheDocument();

    fireEvent.click(
      within(homeNavigation).getByRole("button", { name: "Workflows" })
    );
    expect(
      screen.getByRole("region", { name: "Document workflows" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Corpus")).not.toBeInTheDocument();

    fireEvent.click(within(homeNavigation).getByRole("button", { name: "Drive" }));
    expect(
      screen.getByRole("region", { name: "Workspace drive" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Corpus")).not.toBeInTheDocument();

    fireEvent.click(within(homeNavigation).getByRole("button", { name: "Runs" }));
    expect(screen.getByRole("region", { name: "Recent runs" })).toBeInTheDocument();
    expect(screen.queryByText("Corpus")).not.toBeInTheDocument();
  });

  test("keeps the launch page on Drive after uploading from home", async () => {
    render(<App />);

    const homeNavigation = await screen.findByRole("navigation", {
      name: "Home navigation",
    });

    fireEvent.click(within(homeNavigation).getByRole("button", { name: "Drive" }));
    fireEvent.click(screen.getByText("Upload mock"));

    expect(
      await screen.findByRole("region", { name: "Workspace drive" })
    ).toBeInTheDocument();
    expect(screen.getByText("rag-notes.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Corpus")).not.toBeInTheDocument();
  });

  test("prepares a document comparison on the launch page without opening the workspace", async () => {
    render(<App />);

    const homeNavigation = await screen.findByRole("navigation", {
      name: "Home navigation",
    });

    fireEvent.click(within(homeNavigation).getByRole("button", { name: "Drive" }));
    expect(await screen.findByText("benefits-2025.pdf")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Upload mock"));
    expect(await screen.findByText("rag-notes.pdf")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Compare documents" }));
    fireEvent.click(screen.getByLabelText(/benefits-2025\.pdf/i));
    fireEvent.click(screen.getByLabelText(/rag-notes\.pdf/i));
    fireEvent.click(screen.getByRole("button", { name: "Stage comparison" }));

    expect(screen.getByTestId("chat-docids")).toHaveTextContent(
      "doc-1,doc-upload"
    );
    expect(screen.getByTestId("chat-draft")).toHaveTextContent(
      "Compare the selected documents"
    );
    expect(screen.getByText("Staged task")).toBeInTheDocument();
    expect(screen.queryByText("Corpus")).not.toBeInTheDocument();
  });

  test("opens the workspace after a successful home chat submission", async () => {
    render(<App />);

    expect(
      await screen.findByText("Document AI workspace")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Submit mock chat" }));

    expect(await screen.findByText("Corpus")).toBeInTheDocument();
    expect(screen.getByText("Mock answer")).toBeInTheDocument();
  });

  test("keeps arxiv documents out of chat scope until all scope is selected", async () => {
    axios.get.mockImplementation((url) => {
      if (url.endsWith("/agent-runs/recovery")) {
        return Promise.resolve({
          data: {
            runs: [],
          },
        });
      }

      return Promise.resolve({
        data: [
          {
            docId: "doc-uploaded",
            fileName: "private-notes.pdf",
            pageCount: 2,
          },
          {
            docId: "doc-arxiv",
            fileName: "arxiv-2401.00001.pdf",
            pageCount: 12,
            profile: {
              source: {
                sourceType: "arxiv",
                arxivId: "2401.00001v1",
                relatedToDocId: "doc-uploaded",
                importedByUserConfirmation: true,
              },
            },
          },
        ],
      });
    });

    render(<App />);
    await openWorkspace();

    expect(await screen.findByText("private-notes.pdf")).toBeInTheDocument();
    expect(screen.getByText("arXiv 2401.00001v1")).toBeInTheDocument();
    expect(screen.getByTestId("chat-docids")).toHaveTextContent("doc-uploaded");

    fireEvent.click(screen.getByText("scope-all-2"));

    expect(screen.getByTestId("chat-docids")).toHaveTextContent(
      "doc-uploaded,doc-arxiv"
    );

    fireEvent.click(
      screen.getByLabelText("Include arxiv-2401.00001.pdf in selected chat scope")
    );
    fireEvent.click(screen.getByText("scope-selected-1"));

    expect(screen.getByTestId("chat-docids")).toHaveTextContent("doc-arxiv");
  });

  test("shows agent run recovery actions in the sidebar", async () => {
    axios.get.mockImplementation((url) => {
      if (url.endsWith("/agent-runs/recovery")) {
        return Promise.resolve({
          data: {
            runs: [
              {
                runId: "run-recovery",
                goal: "Recover interrupted document answer",
                status: "waiting_for_user",
                recovery: {
                  actions: [
                    {
                      safety: {
                        canAutoReplay: true,
                        reasonCodes: [],
                        stepId: "step-document",
                        stepType: "document_rag",
                      },
                      stepId: "step-document",
                      type: "resume_from_step",
                    },
                    {
                      type: "cancel",
                    },
                  ],
                  reason: "server_startup_recovery",
                  replaySafety: {
                    steps: [
                      {
                        canAutoReplay: true,
                        reasonCodes: [],
                        stepId: "step-document",
                        stepType: "document_rag",
                      },
                    ],
                  },
                },
              },
              {
                runId: "run-web-recovery",
                goal: "Recover interrupted web search",
                status: "waiting_for_user",
                recovery: {
                  actions: [
                    {
                      type: "cancel",
                    },
                  ],
                  reason: "requires_approval",
                  replaySafety: {
                    steps: [
                      {
                        canAutoReplay: false,
                        reasonCodes: ["requires_approval", "non_idempotent"],
                        stepId: "step-web",
                        stepType: "web_search",
                      },
                    ],
                  },
                },
              },
            ],
          },
        });
      }

      if (url.endsWith("/tasks")) {
        return Promise.resolve({
          data: {
            tasks: [],
          },
        });
      }

      return Promise.resolve({
        data: [
          {
            docId: "doc-1",
            fileName: "benefits-2025.pdf",
            pageCount: 3,
          },
        ],
      });
    });
    axios.post.mockResolvedValue({
      data: {
        run: {
          recovery: {
            actions: [],
          },
          runId: "run-recovery",
          status: "canceled",
          steps: [],
        },
      },
    });

    render(<App />);
    await openWorkspace();

    expect(await screen.findByText("benefits-2025.pdf")).toBeInTheDocument();

    expect(
      await screen.findByText("Recover interrupted document answer")
    ).toBeInTheDocument();
    expect(screen.getByText("server_startup_recovery")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resume step" })
    ).toBeInTheDocument();
    expect(screen.getAllByText("Run status").length).toBeGreaterThan(0);
    expect(screen.getByText("document_rag")).toBeInTheDocument();
    expect(screen.getAllByText("Auto replay allowed").length).toBeGreaterThan(0);
    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(
      screen.getAllByText("Auto replay blocked").length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("requires_approval, non_idempotent").length
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);

    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith(
        "http://localhost:5001/agent-runs/run-recovery/recovery/actions/cancel",
        {}
      )
    );
  });

  test("removes a document from the UI after delete succeeds", async () => {
    render(<App />);
    await openWorkspace();

    const removeButton = await screen.findByLabelText("Remove benefits-2025.pdf");
    removeButton.click();

    await waitFor(() =>
      expect(screen.queryByText("benefits-2025.pdf")).not.toBeInTheDocument()
    );
    expect(axios.delete).toHaveBeenCalledWith(
      "http://localhost:5001/documents/doc-1"
    );
  });

  test("posts answer feedback from the conversation panel", async () => {
    render(<App />);
    await openWorkspace();

    await screen.findByText("benefits-2025.pdf");
    fireEvent.click(screen.getByText("Send feedback"));

    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith(
        "http://localhost:5001/feedback",
        expect.objectContaining({
          docIds: ["doc-1"],
          feedbackType: "hallucination",
          note: "This answer is not supported.",
          question: "What changed?",
          answer: expect.objectContaining({
            agentAnswer: "Unsupported answer.",
          }),
        })
      )
    );
  });

  test("suggests arxiv papers after upload and imports after confirmation", async () => {
    let documentFetchCount = 0;

    axios.get.mockImplementation((url) => {
      if (url.endsWith("/agent-runs/recovery")) {
        return Promise.resolve({
          data: {
            runs: [],
          },
        });
      }

      if (url.includes("/documents/doc-upload/arxiv/suggestions")) {
        return Promise.resolve({
          data: {
            document: {
              docId: "doc-upload",
              fileName: "rag-notes.pdf",
            },
            topic: "retrieval augmented generation",
            queryPolicy: {
              allowed: true,
              policyVersion: "external_query_policy_v1",
              removedTermCount: 2,
              removedTerms: [
                {
                  reason: "sensitive_profile_term",
                  value: "[redacted]",
                },
                {
                  reason: "generic_or_restricted_term",
                  value: "[redacted]",
                },
              ],
              riskFlags: ["query_sanitized"],
              sanitizedQuery: "retrieval augmented generation",
            },
            requestedMaxResults: 3,
            selectionToken: "selection-token-1",
            papers: [
              {
                arxivId: "2401.00001v1",
                title: "Retrieval Augmented Generation for Archives",
              },
              {
                arxivId: "2401.00002v1",
                title: "Grounded Question Answering with Documents",
              },
              {
                arxivId: "2401.00003v1",
                title: "Hybrid Retrieval for Private Workspaces",
              },
            ],
            task: {
              id: "external_recommendation:arxiv:doc-upload",
              type: "external_recommendation",
              status: "waiting_for_user",
              label: "arXiv recommendations",
              summary: "Found 3 arXiv recommendations for review.",
            },
            trace: {
              externalQueryPolicy: {
                sanitizedQuery: "retrieval augmented generation",
              },
            },
          },
        });
      }

      if (url.endsWith("/documents/arxiv/suggestions")) {
        return Promise.resolve({
          data: {
            suggestions: [],
          },
        });
      }

      if (url.endsWith("/tasks")) {
        return Promise.resolve({
          data: {
            tasks: [
              {
                id: "external_recommendation:arxiv:doc-upload",
                type: "external_recommendation",
                status: "waiting_for_user",
                label: "arXiv recommendations",
                summary: "Found 3 arXiv recommendations for review.",
                items: [
                  {
                    id: "2401.00001v1",
                    label: "Retrieval Augmented Generation for Archives",
                    status: "waiting_for_user",
                  },
                ],
              },
            ],
          },
        });
      }

      documentFetchCount += 1;

      return Promise.resolve({
        data:
          documentFetchCount > 1
            ? [
                {
                  docId: "doc-1",
                  fileName: "benefits-2025.pdf",
                  pageCount: 3,
                },
                {
                  docId: "doc-upload",
                  fileName: "rag-notes.pdf",
                  pageCount: 2,
                },
                {
                  docId: "doc-arxiv",
                  fileName: "arxiv-2401.00001.pdf",
                  pageCount: 12,
                  profile: {
                    source: {
                      sourceType: "arxiv",
                      arxivId: "2401.00001v1",
                      relatedToDocId: "doc-upload",
                      importedByUserConfirmation: true,
                    },
                  },
                },
              ]
            : [
                {
                  docId: "doc-1",
                  fileName: "benefits-2025.pdf",
                  pageCount: 3,
                },
              ],
      });
    });
    axios.post.mockImplementation((url, payload) => {
      if (
        url.includes(
          "/tasks/external_recommendation%3Aarxiv%3Adoc-upload/actions/confirm"
        )
      ) {
        return Promise.resolve({
          data: {
            task: {
              id: "external_recommendation:arxiv:doc-upload",
              type: "external_recommendation",
              status: "queued",
              label: "arXiv import",
              summary: "Queued 2 selected arXiv recommendations for import.",
            },
          },
        });
      }

      if (url.includes("/documents/doc-upload/arxiv/import")) {
        return Promise.resolve({
          data: {
            importedCount: 1,
            skippedCount: 0,
            failedCount: 0,
            importedPapers: [
              {
                docId: "doc-arxiv",
                fileName: "arxiv-2401.00001.pdf",
              },
            ],
          },
        });
      }

      return Promise.resolve({
        data: {},
      });
    });

    render(<App />);
    await openWorkspace();

    await screen.findByText("benefits-2025.pdf");
    fireEvent.click(screen.getByText("Upload mock"));

    expect(await screen.findByText("arXiv recommendations")).toBeInTheDocument();
    expect(
      await screen.findByText("Retrieval Augmented Generation for Archives")
    ).toBeInTheDocument();
    expect(
      screen.getByText("arXiv search uses cleaned topic:")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Customer Alpha|ACME-X42|Evelyn Stone/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Not now/i }));

    await waitFor(() =>
      expect(
        screen.queryByText("Retrieval Augmented Generation for Archives")
      ).not.toBeInTheDocument()
    );

    fireEvent.click(
      await screen.findByLabelText(
        "Review saved arXiv recommendations for rag-notes.pdf"
      )
    );

    expect(
      await screen.findByText("Retrieval Augmented Generation for Archives")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(
      await screen.findByText("Found 3 arXiv recommendations for review.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    const groundedPaperCheckbox = screen.getByLabelText(
      "Select Grounded Question Answering with Documents"
    );
    expect(groundedPaperCheckbox).toBeChecked();
    fireEvent.click(groundedPaperCheckbox);
    expect(groundedPaperCheckbox).not.toBeChecked();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Import 2/i })).toBeEnabled()
    );

    fireEvent.click(screen.getByRole("button", { name: /Import 2/i }));

    await waitFor(() =>
      expect(axios.post).toHaveBeenCalledWith(
        "http://localhost:5001/tasks/external_recommendation%3Aarxiv%3Adoc-upload/actions/confirm",
        {
          docId: "doc-upload",
          selectedArxivIds: ["2401.00001v1", "2401.00003v1"],
          selectionToken: "selection-token-1",
        }
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(
      await screen.findByText("Retrieval Augmented Generation for Archives")
    ).toBeInTheDocument();
  });
});
