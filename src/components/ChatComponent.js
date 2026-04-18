import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Button, Input, message } from "antd";
import { AudioOutlined } from "@ant-design/icons";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import Speech from "speak-tts";
import { API_DOMAIN } from "../config";

const { Search } = Input;

const requestChat = async ({ docIds, question, sessionId }) => {
  const response = await axios.post(`${API_DOMAIN}/chat`, {
    question,
    docIds: docIds.join(","),
    sessionId,
  });

  return response.data;
};

const ChatComponent = (props) => {
  const {
    docIds = [],
    docLabel,
    sessionId,
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
      if (!hasDocuments) {
        message.warning("Upload at least one PDF before asking a question.");
        return;
      }

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
        });

        handleResp(trimmedQuestion, data);

        if (isChatModeOn) {
          talk(data?.ragAnswer);
        }
      } catch (error) {
        console.error("Error fetching chat response:", error);

        const backendMessage =
          error.response?.data?.error ?? "Unable to complete the request.";

        handleResp(trimmedQuestion, {
          ragAnswer: `RAG unavailable: ${backendMessage}`,
          ragSources: [],
          mcpAnswer: `Web search unavailable: ${backendMessage}`,
        });
      } finally {
        setIsLoading(false);
      }
    },
    [docIds, handleResp, hasDocuments, isChatModeOn, sessionId, setIsLoading, talk]
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
      message.warning("Upload at least one PDF before starting chat mode.");
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

  return (
    <div className="archive-composer-bar">
      <div className="archive-composer-meta">
        {hasDocuments ? `Asking ${docLabel}` : "No documents selected"}
      </div>

      <div className="archive-composer-controls">
        {!isChatModeOn && (
          <Search
            className="archive-search"
            placeholder={
              hasDocuments
                ? "Ask a question"
                : "Upload PDFs to start"
            }
            enterButton="Ask"
            size="large"
            onSearch={onSearch}
            loading={isLoading}
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
            disabled={!hasDocuments}
          />
        )}

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
  );
};

export default ChatComponent;
