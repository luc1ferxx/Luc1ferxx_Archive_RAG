import { describe, expect, test } from "vitest";
// The one import here that reaches into server/. The frontend job installs no
// server packages, which works because this module and the two it imports
// (lib/normalize-text.js, rag/skills/skill-contract.js) import no package.
import {
  isStepRetryAllowed,
  listStepReplaySafetyPolicies,
} from "../../server/rag/agent-run-step-replay-safety.js";
import {
  formatRecoveryActionLabel,
  formatReplaySafetyReasonCodes,
  getRecoveryActionSuccessMessage,
  isStepRetrySupported,
  listSelfRetryableStepTypes,
} from "./workbenchFormatters";

describe("workbench formatters", () => {
  // The chat's run panel only has the steps, so it decides by itself whether a
  // failed step gets a Retry button. Its list has to be the server's: the
  // server refuses the retry of every other type with 409.
  test("the client's self-retryable step types are the server's replay matrix", () => {
    expect(listSelfRetryableStepTypes()).toEqual(
      listStepReplaySafetyPolicies()
        .map((policy) => policy.stepType)
        .filter(isStepRetryAllowed)
        .sort()
    );
  });

  test("a graph node's step and an approval-capable primary step are not retried from the client", () => {
    expect(isStepRetrySupported("document_rag")).toBe(true);
    expect(isStepRetrySupported(" Document_RAG ")).toBe(true);
    expect(isStepRetrySupported("capability_call")).toBe(true);

    for (const stepType of [
      "custom_skill",
      "graph_node",
      "web_search",
      "arxiv_import",
      "inventory",
      "",
      undefined,
      null,
    ]) {
      expect(isStepRetrySupported(stepType)).toBe(false);
    }
  });

  test("recovery actions are retry and cancel; resume is not one of them", () => {
    expect(formatRecoveryActionLabel("retry_failed_step")).toBe("Retry failed step");
    expect(formatRecoveryActionLabel("cancel")).toBe("Cancel");
    // No dedicated label or message is left for the removed action.
    expect(formatRecoveryActionLabel("resume_from_step")).toBe("resume from step");
    expect(getRecoveryActionSuccessMessage("resume_from_step")).toBe(
      "Agent run recovery action completed."
    );
    expect(getRecoveryActionSuccessMessage("cancel")).toBe("Agent run canceled.");
  });

  test("replay safety is shown as the server's reason codes", () => {
    expect(
      formatReplaySafetyReasonCodes({ reasonCodes: ["graph_node_step", "external_write"] })
    ).toBe("graph_node_step, external_write");
    expect(formatReplaySafetyReasonCodes({})).toBe("No reason codes reported");
    expect(formatReplaySafetyReasonCodes()).toBe("No reason codes reported");
  });
});
