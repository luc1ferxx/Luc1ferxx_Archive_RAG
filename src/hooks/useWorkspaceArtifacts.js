import { useCallback, useEffect, useRef, useState } from "react";

import {
  downloadWorkspaceArtifact,
  fetchWorkspaceArtifact,
  fetchWorkspaceArtifacts,
  requestWorkspaceArtifactArchive,
} from "../archiveApi";

const getBackendMessage = (error, fallbackMessage) => {
  const backendMessage = String(error?.response?.data?.error ?? "").trim();
  const errorMessage = String(error?.message ?? "").trim();

  return backendMessage || errorMessage || fallbackMessage;
};

const ARTIFACT_PAGE_SIZE = 50;

export const useWorkspaceArtifacts = ({ t = (key) => key } = {}) => {
  const [artifacts, setArtifacts] = useState([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState("");
  const [selectedArtifact, setSelectedArtifact] = useState(null);
  const [status, setStatus] = useState("active");
  const [total, setTotal] = useState(0);
  const [isListLoading, setIsListLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [action, setAction] = useState(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [detailRetryNonce, setDetailRetryNonce] = useState(0);
  const [loadMoreError, setLoadMoreError] = useState("");
  const [actionError, setActionError] = useState(null);
  const actionRef = useRef(null);
  const listRequestIdRef = useRef(0);
  const loadMoreInFlightRef = useRef(false);
  const statusRef = useRef(status);

  statusRef.current = status;

  const loadArtifacts = useCallback(
    async ({ targetStatus = statusRef.current } = {}) => {
      const requestId = listRequestIdRef.current + 1;
      listRequestIdRef.current = requestId;
      loadMoreInFlightRef.current = false;
      setIsListLoading(true);
      setIsLoadingMore(false);
      setError("");
      setLoadMoreError("");

      try {
        const result = await fetchWorkspaceArtifacts({
          limit: ARTIFACT_PAGE_SIZE,
          offset: 0,
          status: targetStatus,
        });
        const nextArtifacts = Array.isArray(result?.artifacts)
          ? result.artifacts
          : [];

        if (
          requestId !== listRequestIdRef.current ||
          targetStatus !== statusRef.current
        ) {
          return;
        }

        setArtifacts(nextArtifacts);
        setTotal(Number(result?.total ?? nextArtifacts.length));
        setSelectedArtifactId((currentArtifactId) =>
          nextArtifacts.some(
            (artifact) => artifact.artifactId === currentArtifactId
          )
            ? currentArtifactId
            : nextArtifacts[0]?.artifactId ?? ""
        );
      } catch (loadError) {
        if (
          requestId !== listRequestIdRef.current ||
          targetStatus !== statusRef.current
        ) {
          return;
        }

        setArtifacts([]);
        setSelectedArtifact(null);
        setSelectedArtifactId("");
        setTotal(0);
        setError(getBackendMessage(loadError, t("artifact.error.list")));
      } finally {
        if (
          requestId === listRequestIdRef.current &&
          targetStatus === statusRef.current
        ) {
          setIsListLoading(false);
        }
      }
    },
    [t]
  );

  useEffect(() => {
    void loadArtifacts({ targetStatus: status });
  }, [loadArtifacts, status]);

  const loadMoreArtifacts = useCallback(async () => {
    const targetStatus = statusRef.current;
    const offset = artifacts.length;

    if (
      loadMoreInFlightRef.current ||
      isListLoading ||
      offset >= total
    ) {
      return;
    }

    const requestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = requestId;
    loadMoreInFlightRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreError("");

    try {
      const result = await fetchWorkspaceArtifacts({
        limit: ARTIFACT_PAGE_SIZE,
        offset,
        status: targetStatus,
      });
      const nextArtifacts = Array.isArray(result?.artifacts)
        ? result.artifacts
        : [];

      if (
        requestId !== listRequestIdRef.current ||
        targetStatus !== statusRef.current
      ) {
        return;
      }

      setArtifacts((currentArtifacts) => {
        const artifactsById = new Map(
          currentArtifacts.map((artifact) => [artifact.artifactId, artifact])
        );

        nextArtifacts.forEach((artifact) => {
          artifactsById.set(artifact.artifactId, artifact);
        });

        return [...artifactsById.values()];
      });
      setTotal(Number(result?.total ?? offset + nextArtifacts.length));
    } catch (loadError) {
      if (
        requestId === listRequestIdRef.current &&
        targetStatus === statusRef.current
      ) {
        setLoadMoreError(
          getBackendMessage(loadError, t("artifact.error.loadMore"))
        );
      }
    } finally {
      if (requestId === listRequestIdRef.current) {
        loadMoreInFlightRef.current = false;
        setIsLoadingMore(false);
      }
    }
  }, [artifacts.length, isListLoading, t, total]);

  useEffect(() => {
    let cancelled = false;

    if (!selectedArtifactId) {
      setSelectedArtifact(null);
      setIsDetailLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const loadDetail = async () => {
      setIsDetailLoading(true);
      setDetailError("");

      try {
        const result = await fetchWorkspaceArtifact(selectedArtifactId);

        if (!cancelled) {
          setSelectedArtifact(result?.artifact ?? null);
        }
      } catch (detailError) {
        if (!cancelled) {
          setSelectedArtifact(null);
          setDetailError(
            getBackendMessage(detailError, t("artifact.error.detail"))
          );
        }
      } finally {
        if (!cancelled) {
          setIsDetailLoading(false);
        }
      }
    };

    void loadDetail();

    return () => {
      cancelled = true;
    };
  }, [detailRetryNonce, selectedArtifactId, t]);

  const retryDetail = useCallback(() => {
    if (selectedArtifactId) {
      setDetailRetryNonce((currentNonce) => currentNonce + 1);
    }
  }, [selectedArtifactId]);

  const archiveArtifact = useCallback(
    async (artifactId) => {
      if (!artifactId || actionRef.current) {
        return;
      }

      const nextAction = {
        artifactId,
        type: "archive",
      };
      actionRef.current = nextAction;
      setAction(nextAction);
      setActionError(null);

      try {
        await requestWorkspaceArtifactArchive(artifactId);
        await loadArtifacts();
      } catch (archiveError) {
        setActionError({
          artifactId,
          message: getBackendMessage(
            archiveError,
            t("artifact.error.archive")
          ),
          type: "archive",
        });
      } finally {
        if (actionRef.current === nextAction) {
          actionRef.current = null;
          setAction(null);
        }
      }
    },
    [loadArtifacts, t]
  );

  const downloadArtifact = useCallback(async (artifact) => {
    if (!artifact?.artifactId || actionRef.current) {
      return;
    }

    const nextAction = {
      artifactId: artifact.artifactId,
      type: "download",
    };
    actionRef.current = nextAction;
    setAction(nextAction);
    setActionError(null);

    try {
      const result = await downloadWorkspaceArtifact(artifact.artifactId);
      const objectUrl = window.URL.createObjectURL(result.blob);
      const link = document.createElement("a");

      link.href = objectUrl;
      link.download = result.fileName || artifact.fileName || "workspace-artifact";
      document.body.appendChild(link);

      try {
        link.click();
      } finally {
        link.remove();
        window.URL.revokeObjectURL(objectUrl);
      }
    } catch (downloadError) {
      setActionError({
        artifactId: artifact.artifactId,
        message: getBackendMessage(
          downloadError,
          t("artifact.error.download")
        ),
        type: "download",
      });
    } finally {
      if (actionRef.current === nextAction) {
        actionRef.current = null;
        setAction(null);
      }
    }
  }, [t]);

  return {
    action,
    actionError,
    archiveArtifact,
    artifacts,
    downloadArtifact,
    detailError,
    error,
    isDetailLoading,
    isListLoading,
    isLoadingMore,
    loadArtifacts,
    loadMoreArtifacts,
    loadMoreError,
    retryDetail,
    selectedArtifact,
    selectedArtifactId,
    selectArtifact: setSelectedArtifactId,
    setStatus,
    status,
    total,
  };
};
