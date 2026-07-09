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

const defaultT = (key, values = {}) =>
  Object.entries(values).reduce(
    (result, [valueKey, value]) => result.split(`{${valueKey}}`).join(String(value)),
    key
  );

const ChatComponent = (props) => {
  const {
    docIds = [],
    docLabel,
    chatScopeMode = "uploaded",
    chatScopeOptions = [],
    draftQuestion = "",
    sessionId,
    userId,
    handleResp,
    inputId,
    isDemoWorkbench = false,
    isLoading,
    onAttach,
    onChatScopeModeChange,
    onDraftQuestionConsumed,
    setIsLoading,
    locale = "en",
    t = defaultT,
  } = props;
  const [searchValue, setSearchValue] = useState("");
  const [isChatModeOn, setIsChatModeOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [retrievalMode, setRetrievalMode] = useState("auto");
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
          error.response?.data?.error ?? t("chat.errorRequest");

        handleResp(trimmedQuestion, {
          ragAnswer: t("chat.errorRagUnavailable", {
            message: backendMessage,
          }),
          ragSources: [],
          ragGapPlan: null,
          agentAnswer: t("chat.errorAgentUnavailable", {
            message: backendMessage,
          }),
          agentTrace: [],
          mcpAnswer: t("chat.errorWebUnavailable", {
            message: backendMessage,
          }),
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
      t,
      userId,
    ]
  );

  useEffect(() => {
    if (!draftQuestion) {
      return;
    }

    setSearchValue(draftQuestion);
    onDraftQuestionConsumed?.();
  }, [draftQuestion, onDraftQuestionConsumed]);

  useEffect(() => {
    const initializedSpeech = new Speech();
    const baseSpeechOptions = {
      volume: 1,
      lang: locale === "zh" ? "zh-CN" : "en-US",
      rate: 1,
      pitch: 1,
      splitSentences: false,
    };
    const speechOptions =
      locale === "zh"
        ? baseSpeechOptions
        : {
            voice: "Google US English",
            ...baseSpeechOptions,
          };

    initializedSpeech
      .init(speechOptions)
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
  }, [locale]);

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
      message.warning(t("chat.noDocumentsForVoice"));
      return;
    }

    setIsChatModeOn((prev) => !prev);
    setIsRecording(false);
    SpeechRecognition.stopListening();
    resetTranscript();
  };

  const recordingClickHandler = () => {
    if (!hasDocuments) {
      message.warning(t("chat.noDocumentsForRecording"));
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
      if (currentMode === "auto") {
        message.info(t("chat.retrievalModeDocs"));
        return "docs";
      }

      if (currentMode === "docs") {
        message.info(t("chat.retrievalModeWeb"));
        return "web";
      }

      message.info(t("chat.retrievalModeAuto"));
      return "auto";
    });
  };

  const handleScopeClick = (option) => {
    if (option.count <= 0) {
      message.info(t("chat.scopeEmpty", { label: option.label }));
      return;
    }

    onChatScopeModeChange?.(option.id);
  };

  const transcriptLabel = isChatModeOn
    ? isRecording
      ? transcript || t("chat.listeningForQuestion")
      : t("chat.voicePrompt")
    : hasDocuments
      ? t("chat.workingWith", { label: docLabel })
      : t("chat.agentEmptyWorkspace");
  const retrievalLabelByMode = {
    auto: t("chat.retrievalAuto"),
    docs: t("chat.retrievalDocs"),
    web: t("chat.retrievalWeb"),
  };

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
                ? t("chat.placeholderWithDocuments")
                : t("chat.placeholderWithoutDocuments")
            }
            enterButton={
              <span aria-label={t("chat.ask")} className="archive-send-icon">
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
                  ? t("chat.demoTranscript")
                  : transcriptLabel}
              </div>

              {!isDemoWorkbench && chatScopeOptions.length > 0 ? (
                <div className="archive-scope-segmented" aria-label={t("chat.scope")}>
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
              aria-label={t("chat.composerTools")}
              onClick={() => setIsToolsOpen((isOpen) => !isOpen)}
            >
              <AppstoreOutlined />
              {t("chat.tools")}
            </button>
          </div>

          {isToolsOpen ? (
            <div className="archive-composer-menu">
              <button type="button" onClick={() => onAttach?.()}>
                <PaperClipOutlined />
                {t("chat.attachPdfs")}
              </button>
              <button type="button" onClick={cycleRetrievalMode}>
                <AppstoreOutlined />
                {t("chat.retrievalPrefix")}: {retrievalLabelByMode[retrievalMode]}
              </button>
              <button type="button" onClick={chatModeClickHandler}>
                <SoundOutlined />
                {isChatModeOn ? t("chat.voiceOn") : t("chat.voiceMode")}
              </button>
              {isChatModeOn ? (
                <button
                  type="button"
                  className={isRecording ? "is-recording" : ""}
                  onClick={recordingClickHandler}
                >
                  <AudioOutlined />
                  {isRecording ? t("chat.listening") : t("chat.record")}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => message.info(t("chat.documentRagActive"))}
              >
                {t("chat.documentRag")}
              </button>
              <button
                type="button"
                onClick={() => message.info(t("chat.qualityGuardHint"))}
              >
                {t("chat.qualityGuard")}
              </button>
              <button
                type="button"
                onClick={() => message.info(t("chat.webLookupHint"))}
              >
                {t("chat.webLookup")}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default ChatComponent;
