import { useCallback, useState } from "react";
import { message } from "antd";
import {
  fetchLatestQualityReport,
  fetchQualityHistory,
  requestSyntheticQualityRun,
} from "../archiveApi";

export const useQualityReports = ({ demoQualityHistory, demoQualityReport, isDemoWorkbench, t }) => {
  const [isQualityLoading, setIsQualityLoading] = useState(false);
  const [qualityHistory, setQualityHistory] = useState(null);
  const [qualityReport, setQualityReport] = useState(null);

  const loadLatestQualityReport = useCallback(async () => {
    if (isDemoWorkbench) {
      setQualityReport(demoQualityReport);
      setQualityHistory(demoQualityHistory);
      message.success(t("app.demoQualityLoaded"));
      return;
    }

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
  }, [demoQualityHistory, demoQualityReport, isDemoWorkbench, t]);

  const loadQualityHistory = useCallback(async () => {
    if (isDemoWorkbench) {
      setQualityHistory(demoQualityHistory);
      message.success(t("app.demoQualityHistoryLoaded"));
      return;
    }

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
  }, [demoQualityHistory, isDemoWorkbench, t]);

  const runSyntheticQualityReport = useCallback(async () => {
    if (isDemoWorkbench) {
      setQualityReport(demoQualityReport);
      setQualityHistory(demoQualityHistory);
      message.success(t("app.demoSyntheticComplete"));
      return;
    }

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
  }, [demoQualityHistory, demoQualityReport, isDemoWorkbench, t]);

  return {
    isQualityLoading,
    loadLatestQualityReport,
    loadQualityHistory,
    qualityHistory,
    qualityReport,
    runSyntheticQualityReport,
  };
};
