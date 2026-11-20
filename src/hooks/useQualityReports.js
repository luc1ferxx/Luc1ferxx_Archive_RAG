import { useCallback, useState } from "react";
import { message } from "antd";
import {
  fetchLatestQualityReport,
  fetchQualityHistory,
  requestSyntheticQualityRun,
} from "../archiveApi";

export const useQualityReports = ({ t }) => {
  const [isQualityLoading, setIsQualityLoading] = useState(false);
  const [qualityHistory, setQualityHistory] = useState(null);
  const [qualityReport, setQualityReport] = useState(null);

  const loadLatestQualityReport = useCallback(async () => {
    setIsQualityLoading(true);

    try {
      setQualityReport(await fetchLatestQualityReport());
      setQualityHistory(await fetchQualityHistory());
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? t("app.latestQualityFailed");
      message.error(backendMessage);
    } finally {
      setIsQualityLoading(false);
    }
  }, [t]);

  const loadQualityHistory = useCallback(async () => {
    setIsQualityLoading(true);

    try {
      setQualityHistory(await fetchQualityHistory());
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? t("app.qualityHistoryFailed");
      message.error(backendMessage);
    } finally {
      setIsQualityLoading(false);
    }
  }, [t]);

  const runSyntheticQualityReport = useCallback(async () => {
    setIsQualityLoading(true);

    try {
      setQualityReport(await requestSyntheticQualityRun());
      setQualityHistory(await fetchQualityHistory());
      message.success(t("app.syntheticComplete"));
    } catch (error) {
      const backendMessage =
        error.response?.data?.error ?? t("app.syntheticFailed");
      message.error(backendMessage);
    } finally {
      setIsQualityLoading(false);
    }
  }, [t]);

  return {
    isQualityLoading,
    loadLatestQualityReport,
    loadQualityHistory,
    qualityHistory,
    qualityReport,
    runSyntheticQualityReport,
  };
};
