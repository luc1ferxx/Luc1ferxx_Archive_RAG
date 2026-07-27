import { Router } from "express";
import { z } from "zod";

import { getRequestAccessScope } from "../auth.js";
import {
  toWorkspaceArtifactDetail,
  toWorkspaceArtifactSummary,
} from "../rag/workspace-artifacts/index.js";

import { sendBufferedFile, serializeError } from "./helpers.js";
import { parseOrRespond, requiredTrimmedString } from "./validation.js";

const artifactIdSchema = z.object({
  artifactId: requiredTrimmedString("artifactId is required."),
});

export const createArtifactsRouter = (services) => {
  const router = Router();
  const { workspaceArtifactService } = services;

  router.get("/artifacts", async (req, res) => {
    try {
      const result = await workspaceArtifactService.listArtifacts({
        accessScope: getRequestAccessScope(req),
        artifactType: req.query.artifactType,
        limit: req.query.limit,
        offset: req.query.offset,
        status: req.query.status,
      });

      return res.json({
        ...result,
        artifacts: (result.artifacts ?? []).map(toWorkspaceArtifactSummary),
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        ...(error.code ? { code: error.code } : {}),
        error: serializeError(error, "Failed to list workspace artifacts."),
      });
    }
  });

  router.get("/artifacts/:artifactId/download", async (req, res) => {
    const parsed = parseOrRespond(artifactIdSchema, req.params, res);
    if (!parsed) return;
    const { artifactId } = parsed;

    try {
      const download = await workspaceArtifactService.getArtifactDownload({
        accessScope: getRequestAccessScope(req),
        artifactId,
      });

      if (!download) {
        return res.status(404).json({
          error: "Workspace artifact not found.",
        });
      }

      sendBufferedFile({
        req,
        res,
        disposition: "attachment",
        ...download,
      });
      return;
    } catch (error) {
      return res.status(error.status ?? 500).json({
        ...(error.code ? { code: error.code } : {}),
        error: serializeError(error, "Failed to download workspace artifact."),
      });
    }
  });

  router.post("/artifacts/:artifactId/archive", async (req, res) => {
    const parsed = parseOrRespond(artifactIdSchema, req.params, res);
    if (!parsed) return;
    const { artifactId } = parsed;

    try {
      const artifact = await workspaceArtifactService.archiveArtifact({
        accessScope: getRequestAccessScope(req),
        artifactId,
      });

      if (!artifact) {
        return res.status(404).json({
          error: "Workspace artifact not found.",
        });
      }

      return res.json({
        artifact: toWorkspaceArtifactDetail(artifact),
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        ...(error.code ? { code: error.code } : {}),
        error: serializeError(error, "Failed to archive workspace artifact."),
      });
    }
  });

  router.get("/artifacts/:artifactId", async (req, res) => {
    const parsed = parseOrRespond(artifactIdSchema, req.params, res);
    if (!parsed) return;
    const { artifactId } = parsed;

    try {
      const artifact = await workspaceArtifactService.getArtifact({
        accessScope: getRequestAccessScope(req),
        artifactId,
      });

      if (!artifact) {
        return res.status(404).json({
          error: "Workspace artifact not found.",
        });
      }

      return res.json({
        artifact: toWorkspaceArtifactDetail(artifact),
      });
    } catch (error) {
      return res.status(error.status ?? 500).json({
        ...(error.code ? { code: error.code } : {}),
        error: serializeError(error, "Failed to load workspace artifact."),
      });
    }
  });

  return router;
};
