import React, { useCallback, useEffect, useState } from "react";
import { Input, message } from "antd";
import {
  AudioOutlined,
  AppstoreOutlined,
  PaperClipOutlined,
  SendOutlined,
  SoundOutlined,
} from "@ant-design/icons";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import Speech from "speak-tts";
import { requestChat } from "../archiveApi";
import { DEMO_CONVERSATION } from "../demoWorkbench";

const { Search } = Input;

const ChatComponent = (props) => {
  const {
    docIds = [],
    docLabel,
    chatScopeMode = "uploaded",
    chatScopeOptions = [],
    sessionId,
    userId,
    handleResp,
    inputId,
    isDemoWorkbench = false,
    isLoading,
    onAttach,
    onChatScopeModeChange,
    setIsLoading,
  } = props;
  const [searchValue, setSearchValue] = useState("");
  const [isChatModeOn, setIsChatModeOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [retrievalMode, setRetrievalMode] = useState("Auto");
  const [speech, setSpeech] = useState();
  const hasDocuments = isDemoWorkbench || docIds.length > 0;

  const { transcript, listening, resetTranscript } = useSpeechRecognition();

  const userStartConvo = useCallback(() => {
    if (!hasDocuments) {
      return;
    }

    SpeechRecognition.startListening();
    setIsRecording(true);
    resetTranscript();
  }, [hasDocuments, resetTranscript]);

  const talk = useCallback(
    (whatToSay) => {
      if (!speech) {
        return;
      }

      speech
        .speak({
          text: whatToSay,
          queue: false,
        })
        .then(() => {
          userStartConvo();
        })
        .catch((error) => {
          console.error("An error occurred during speech:", error);
        });
    },
    [speech, userStartConvo]
  );

  const onSearch = useCallback(
    async (question) => {
      const trimmedQuestion = question.trim();

      if (!trimmedQuestion) {
        return;
      }

      setSearchValue("");

      if (isDemoWorkbench) {
        const demoAnswer = {
          ...DEMO_CONVERSATION[0].answer,
          agentAnswer: DEMO_CONVERSATION[0].answer.agentAnswer,
        };

        handleResp(trimmedQuestion, demoAnswer);

        if (isChatModeOn) {
          talk(demoAnswer.agentAnswer);
        }

        return;
      }

      setIsLoading(true);

      try {
        const data = await requestChat({
          docIds,
          question: trimmedQuestion,
          sessionId,
          userId,
        });

        handleResp(trimmedQuestion, data);

        if (isChatModeOn) {
          talk(data?.agentAnswer ?? data?.ragAnswer);
        }
      } catch (error) {
        console.error("Error fetching chat response:", error);

        const backendMessage =
          error.response?.data?.error ?? "Unable to complete the request.";

        handleResp(trimmedQuestion, {
          ragAnswer: `RAG unavailable: ${backendMessage}`,
          ragSources: [],
          ragGapPlan: null,
          agentAnswer: `Agent unavailable: ${backendMessage}`,
          agentTrace: [],
          mcpAnswer: `Web search unavailable: ${backendMessage}`,
        });
      } finally {
        setIsLoading(false);
      }
    },
    [
      docIds,
      handleResp,
      isDemoWorkbench,
      isChatModeOn,
      sessionId,
      setIsLoading,
      talk,
      userId,
    ]
  );

  useEffect(() => {
    const initializedSpeech = new Speech();
    const baseSpeechOptions = {
      volume: 1,
      lang: "en-US",
      rate: 1,
      pitch: 1,
      splitSentences: false,
    };

    initializedSpeech
      .init({
        voice: "Google US English",
        ...baseSpeechOptions,
      })
      .then(() => {
        setSpeech(initializedSpeech);
      })
      .catch((error) => {
        initializedSpeech
          .init(baseSpeechOptions)
          .then(() => {
            setSpeech(initializedSpeech);
          })
          .catch((fallbackError) => {
            console.warn("Speech synthesis is unavailable:", fallbackError ?? error);
          });
      });
  }, []);

  useEffect(() => {
    if (!listening && transcript) {
      const spokenQuestion = transcript.trim();
      resetTranscript();
      setIsRecording(false);

      if (spokenQuestion) {
        void onSearch(spokenQuestion);
      }
    }
  }, [listening, onSearch, resetTranscript, transcript]);

  useEffect(() => {
    if (!hasDocuments) {
      setIsChatModeOn(false);
      setIsRecording(false);
      SpeechRecognition.stopListening();
      resetTranscript();
    }
  }, [hasDocuments, resetTranscript]);

  const chatModeClickHandler = () => {
    if (!hasDocuments) {
      message.warning("Upload at least one PDF before starting voice mode.");
      return;
    }

    setIsChatModeOn((prev) => !prev);
    setIsRecording(false);
    SpeechRecognition.stopListening();
    resetTranscript();
  };

  const recordingClickHandler = () => {
    if (!hasDocuments) {
      message.warning("Upload at least one PDF before recording a question.");
      return;
    }

    if (isRecording) {
      setIsRecording(false);
      SpeechRecognition.stopListening();
      resetTranscript();
    } else {
      setIsRecording(true);
      SpeechRecognition.startListening();
    }
  };

  const cycleRetrievalMode = () => {
    setRetrievalMode((currentMode) => {
      if (currentMode === "Auto") {
        message.info("Retrieval mode: Documents");
        return "Docs";
      }

      if (currentMode === "Docs") {
        message.info("Retrieval mode: Web");
        return "Web";
      }

      message.info("Retrieval mode: Auto");
      return "Auto";
    });
  };

  const handleScopeClick = (option) => {
    if (option.count <= 0) {
      message.info(`${option.label} scope has no documents.`);
      return;
    }

    onChatScopeModeChange?.(option.id);
  };

  const transcriptLabel = isChatModeOn
    ? isRecording
      ? transcript || "Listening for your question."
      : "Voice mode is on. Press record to ask the next question."
    : hasDocuments
      ? `Working with ${docLabel}`
      : "Agent can inspect the empty workspace or answer web-current questions.";

  return (
    <div className="archive-composer-border">
      <div
        className={`archive-composer-bar ${isDemoWorkbench ? "is-demo" : ""} ${
          isLoading ? "is-running" : ""
        }`}
      >
        <div className="archive-composer-controls">
          <Search
            id={inputId}
            className="archive-search"
            placeholder={
              hasDocuments
                ? "Ask the agent about the current documents"
                : "Ask the agent what documents are indexed"
            }
            enterButton={
              <span aria-label="Ask" className="archive-send-icon">
                <SendOutlined />
              </span>
            }
            size="large"
            onSearch={onSearch}
            loading={isLoading}
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
          />

          <div className="archive-composer-toolbar">
            <div className="archive-composer-context">
              <div className="archive-composer-transcript">
                {isDemoWorkbench
                  ? "Enter to send · Shift + Enter for new line"
                  : transcriptLabel}
              </div>

              {!isDemoWorkbench && chatScopeOptions.length > 0 ? (
                <div className="archive-scope-segmented" aria-label="Chat scope">
                  {chatScopeOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={chatScopeMode === option.id}
                      className={chatScopeMode === option.id ? "is-active" : ""}
                      onClick={() => handleScopeClick(option)}
                      title={`${option.label}: ${option.count} document${
                        option.count === 1 ? "" : "s"
                      }`}
                    >
                      <span>{option.label}</span>
                      <small>{option.count}</small>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className="archive-composer-tools-trigger"
              aria-expanded={isToolsOpen}
              aria-label="Composer tools"
              onClick={() => setIsToolsOpen((isOpen) => !isOpen)}
            >
              <AppstoreOutlined />
              Tools
            </button>
          </div>

          {isToolsOpen ? (
            <div className="archive-composer-menu">
              <button type="button" onClick={() => onAttach?.()}>
                <PaperClipOutlined />
                Attach PDFs
              </button>
              <button type="button" onClick={cycleRetrievalMode}>
                <AppstoreOutlined />
                Retrieval: {retrievalMode}
              </button>
              <button type="button" onClick={chatModeClickHandler}>
                <SoundOutlined />
                {isChatModeOn ? "Voice on" : "Voice mode"}
              </button>
              {isChatModeOn ? (
                <button
                  type="button"
                  className={isRecording ? "is-recording" : ""}
                  onClick={recordingClickHandler}
                >
                  <AudioOutlined />
                  {isRecording ? "Listening" : "Record"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => message.info("Document RAG is active for this workspace.")}
              >
                Document RAG
              </button>
              <button
                type="button"
                onClick={() => message.info("Quality Guard checks are shown in the sidebar.")}
              >
                Quality Guard
              </button>
              <button
                type="button"
                onClick={() => message.info("Web lookup runs only when the agent needs fresh external context.")}
              >
                Web lookup
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default ChatComponent;
