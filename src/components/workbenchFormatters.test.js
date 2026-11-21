import { describe, expect, test } from "vitest";
// The one import here that reaches into server/. The frontend job installs no
// server packages, which works because this module and the two it imports
// (lib/normalize-text.js, rag/skills/skill-contract.js) import no package.
import {
  isStepRetryAllowed,
  listStepReplaySafetyPolicies,
} from "../../server/rag/agent-run-step-replay-safety.js";
import { createTranslator } from "../archiveI18n";
import {
  formatRecoveryActionLabel,
  formatStatusLabel,
  formatStepLabel,
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
    const en = createTranslator("en");
    const zh = createTranslator("zh");

    expect(formatRecoveryActionLabel("retry_failed_step", en)).toBe("Retry failed step");
    expect(formatRecoveryActionLabel("cancel", en)).toBe("Cancel");
    // No dedicated label or message is left for the removed action.
    expect(formatRecoveryActionLabel("resume_from_step", en)).toBe("resume from step");
    expect(getRecoveryActionSuccessMessage("resume_from_step", en)).toBe(
      "Agent run recovery action completed."
    );
    expect(getRecoveryActionSuccessMessage("cancel", en)).toBe("Agent run canceled.");
    expect(formatRecoveryActionLabel("retry_failed_step", zh)).toBe("重试失败的步骤");
    expect(formatRecoveryActionLabel("cancel", zh)).toBe("取消");
    expect(getRecoveryActionSuccessMessage("cancel", zh)).toBe("Agent 运行已取消。");
    expect(getRecoveryActionSuccessMessage("retry_failed_step", zh)).toBe(
      "Agent 运行的恢复操作已完成。"
    );
  });

  test("run, task and step statuses, recovery reasons and replay risks read as labels", () => {
    const en = createTranslator("en");
    const zh = createTranslator("zh");

    expect(formatStatusLabel("waiting_for_user", en)).toBe("Waiting for user");
    expect(formatStatusLabel("completed", en)).toBe("Completed");
    expect(formatStatusLabel("failed_step_ready", en)).toBe("A failed step can be retried");
    expect(formatStatusLabel("non_idempotent", en)).toBe("Not idempotent");
    expect(formatStatusLabel("unsupported_step_type", en)).toBe("Unsupported step type");
    expect(formatStatusLabel("waiting_for_user", zh)).toBe("等待用户处理");
    expect(formatStatusLabel("non_idempotent", zh)).toBe("非幂等");
    // A value without a label still reads as words; a missing one is pending.
    expect(formatStatusLabel("graph_resume_failed", en)).toBe("Graph resume failed");
    expect(formatStatusLabel(undefined, en)).toBe("Pending");
  });

  test("a capability call step is told apart from the step whose approval queued it", () => {
    const en = createTranslator("en");

    expect(formatStepLabel({ label: "Web Search", type: "capability_call" }, en)).toBe(
      "Web Search (capability call)"
    );
    expect(formatStepLabel({ label: "Web Search", type: "web_search" }, en)).toBe("Web Search");
    expect(
      formatStepLabel({ label: "Web Search", type: "capability_call" }, createTranslator("zh"))
    ).toBe("Web Search（能力调用）");
    expect(formatStepLabel({ type: "self_check" }, en)).toBe("self_check");
  });
});
