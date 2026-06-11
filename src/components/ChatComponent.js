import React, { useCallback, useEffect, useState } from "react";
import { Button, Input, message } from "antd";
import { AudioOutlined } from "@ant-design/icons";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import Speech from "speak-tts";
import { requestChat } from "../archiveApi";

const { Search } = Input;

const ChatComponent = (props) => {
  const {
    docIds = [],
    docLabel,
    sessionId,
    userId,
    handleResp,
    isLoading,
    setIsLoading,
  } = props;
  const [searchValue, setSearchValue] = useState("");
  const [isChatModeOn, setIsChatModeOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [speech, setSpeech] = useState();
  const hasDocuments = docIds.length > 0;

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
      isChatModeOn,
      sessionId,
      setIsLoading,
      talk,
      userId,
    ]
  );

  useEffect(() => {
    const initializedSpeech = new Speech();

    initializedSpeech
      .init({
        volume: 1,
        lang: "en-US",
        rate: 1,
        pitch: 1,
        voice: "Google US English",
        splitSentences: false,
      })
      .then(() => {
        setSpeech(initializedSpeech);
      })
      .catch((error) => {
        console.error("An error occurred while initializing speech:", error);
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

  const transcriptLabel = isChatModeOn
    ? isRecording
      ? transcript || "Listening for your question."
      : "Voice mode is on. Press record to ask the next question."
    : hasDocuments
      ? `Working with ${docLabel}`
      : "Agent can inspect the empty workspace or answer web-current questions.";

  return (
    <div className="archive-composer-bar">
      <div className="archive-composer-top">
        <div className="archive-composer-summary">
          <div className="archive-composer-kicker">Workspace</div>
          <div className="archive-composer-meta">
            {hasDocuments ? docLabel : "No active documents"}
          </div>
        </div>

        <div className="archive-voice-buttons">
          <Button
            type="primary"
            size="large"
            className={`archive-action-button ${isChatModeOn ? "is-active" : ""}`}
            onClick={chatModeClickHandler}
          >
            Voice
          </Button>

          {isChatModeOn && (
            <Button
              type="primary"
              icon={<AudioOutlined />}
              size="large"
              className={`archive-action-button ${
                isRecording ? "is-recording" : ""
              }`}
              onClick={recordingClickHandler}
            >
              {isRecording ? "Listening" : "Record"}
            </Button>
          )}
        </div>
      </div>

      <div className="archive-composer-controls">
        {!isChatModeOn && (
          <Search
            className="archive-search"
            placeholder={
              hasDocuments
                ? "Ask the agent about the current documents"
                : "Ask the agent what documents are indexed"
            }
            enterButton="Ask"
            size="large"
            onSearch={onSearch}
            loading={isLoading}
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
          />
        )}

        <div className="archive-composer-transcript">{transcriptLabel}</div>
      </div>
    </div>
  );
};

export default ChatComponent;
