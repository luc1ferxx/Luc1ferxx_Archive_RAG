import React from "react";
import { useWorkspace } from "./WorkspaceProvider";

const fallbackT = (key) => key;

// Header control next to AuthStatus: a compact workspace selector, shown only
// when the credential may act in more than one workspace (WorkspaceProvider
// decides). Nothing renders with one workspace, with auth off, or outside a
// WorkspaceProvider.
const WorkspaceSwitcher = ({ t = fallbackT }) => {
  const { choice, selectWorkspace, selected, switching } = useWorkspace();

  if (!choice?.switchable) {
    return null;
  }

  return (
    <label className="archive-workspace-switch">
      <span className="archive-workspace-switch-label">{t("auth.workspace")}</span>
      <select
        aria-label={t("auth.workspaceSwitch")}
        disabled={switching}
        onChange={(event) => void selectWorkspace(event.target.value)}
        value={selected}
      >
        <option disabled={!choice.personal} value="">
          {t(choice.personal ? "auth.workspacePersonal" : "auth.workspaceChoose")}
        </option>
        {choice.options.map((workspaceId) => (
          <option key={workspaceId} value={workspaceId}>
            {workspaceId}
          </option>
        ))}
      </select>
    </label>
  );
};

export default WorkspaceSwitcher;
