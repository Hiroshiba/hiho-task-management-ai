import { ipcFailureSchema } from "../../../shared/ipc-contracts/common";
import { settingsContracts, type SettingsApi } from "../../../shared/ipc-contracts/settings";
import type {
  SetupCodexAvailability,
  SetupExternalToolSelection,
  SetupState,
} from "../../../shared/ipc-contracts/setup-schemas";

type AuthenticationState = Extract<Awaited<ReturnType<SettingsApi["getAsanaAuthenticationState"]>>, { readonly kind: "ok" }>["value"];
type SetupKind = SetupState["kind"];
type AuthenticationKind = AuthenticationState["kind"];
type MockAuthenticationKind = AuthenticationKind | "failure" | "failure_once";

const authorizationId = "mock-authorization-id-012345678901234567890";
const expiry = "2099-01-01T00:00:00.000Z";
const codex = { kind: "available" } satisfies SetupCodexAvailability;
const workspace = { gid: "mock-workspace", name: "画面確認用ワークスペース" };
const project = { gid: "mock-project", name: "画面確認用プロジェクト" };
const context = {
  device_id: "mock-device",
  client_id: "mock-client",
  workspace_gid: workspace.gid,
  workspace_name: workspace.name,
  project_gid: project.gid,
  project_name: project.name,
  section_gids: {
    not_started: "mock-section-not-started",
    in_progress: "mock-section-in-progress",
    completed: "mock-section-completed",
    withdrawn: "mock-section-withdrawn",
  },
  tag_gids: {
    importance_1: "mock-tag-importance-1",
    importance_2: "mock-tag-importance-2",
    importance_3: "mock-tag-importance-3",
    importance_4: "mock-tag-importance-4",
    importance_5: "mock-tag-importance-5",
    area_unclassified: "mock-tag-area",
    block_none: "mock-tag-block-none",
    block_partial: "mock-tag-block-partial",
    block_full: "mock-tag-block-full",
  },
  codex,
};
const contextWithTestTask = { ...context, test_task_gid: "mock-test-task" };
const externalTool = { kind: "skipped" } satisfies SetupExternalToolSelection;

function setupFixture(kind: SetupKind): SetupState {
  switch (kind) {
    case "created": return { kind, step: "codex_cli" };
    case "codex_cli_ready": return { kind, step: "codex_authentication", codex };
    case "codex_authentication_required": return { kind, step: "codex_authentication", codex };
    case "credentials_required": return { kind, step: "credentials", codex };
    case "asana_authorization_pending": return { kind, step: "credentials", codex,
      client_id: "mock-client", authorization_id: authorizationId, expires_at: expiry };
    case "workspace_listing_required": return { kind, step: "workspace", codex, client_id: "mock-client" };
    case "workspace_selection_required": return { kind, step: "workspace", codex,
      client_id: "mock-client", workspaces: [workspace] };
    case "project_selection_required": return { kind, step: "project", codex,
      client_id: "mock-client", workspace, projects: [project] };
    case "project_requires_action": return { kind, step: "project", codex,
      client_id: "mock-client", workspace, projects: [project], reason_code: "duplicate_project_name" };
    case "resources_requires_action": return { kind, step: "resources", codex,
      client_id: "mock-client", workspace, project, issues: [{ resource: "section", name: "未着手", reason: "renamed" }] };
    case "resources_ready": return { kind, step: "asana_capability", context };
    case "asana_capability_failed": return { kind, step: "asana_capability", context,
      reason_code: "read_back_failed" };
    case "vault_choice_required": return { kind, step: "vault", context: contextWithTestTask };
    case "vault_skipped": return { kind, step: "external_tool", context: contextWithTestTask };
    case "vault_configured": return { kind, step: "external_tool", context: contextWithTestTask, vault_id: "tasks" };
    case "external_tool_skipped": return { kind, step: "full_sync", context: contextWithTestTask };
    case "external_tool_configured": return { kind, step: "full_sync", context: contextWithTestTask,
      tool_id: "discord-context", allowed_channel_ids: ["12345678901234567"] };
    case "external_tool_unavailable": return { kind, step: "full_sync", context: contextWithTestTask,
      reason_code: "startup_failed" };
    case "full_sync_required": return { kind, step: "full_sync", context: contextWithTestTask, external_tool: externalTool };
    case "codex_capability_required": return { kind, step: "codex_capability", context: contextWithTestTask, external_tool: externalTool };
    case "ready": return { kind, step: "ready", context: contextWithTestTask, external_tool: externalTool };
  }
}

function authenticationFixture(kind: AuthenticationKind): AuthenticationState {
  switch (kind) {
    case "idle": return { kind };
    case "opening":
    case "authorization_pending": return { kind, authorization_id: authorizationId, expires_at: expiry };
    case "completing":
    case "synchronizing": return { kind, authorization_id: authorizationId };
  }
}

/** 画面確認用の設定APIを単一の状態として作成します。 */
export function createMockSettingsApi(initialSetupKind: SetupKind, initialAuthenticationKind: MockAuthenticationKind): SettingsApi {
  let setup: SetupState = setupFixture(initialSetupKind);
  let authentication: AuthenticationState = authenticationFixture(
    initialAuthenticationKind === "failure" || initialAuthenticationKind === "failure_once"
      ? "idle" : initialAuthenticationKind,
  );
  let authenticationFailure: "persistent" | "once" | "none" = "none";
  if (initialAuthenticationKind === "failure") {
    authenticationFailure = "persistent";
  } else if (initialAuthenticationKind === "failure_once") {
    authenticationFailure = "once";
  }
  settingsContracts.getState.response.parse({ kind: "ok", value: setup });
  settingsContracts.getAsanaAuthenticationState.response.parse({ kind: "ok", value: authentication });

  function setSetup(kind: SetupKind): ReturnType<SettingsApi["getState"]> {
    setup = setupFixture(kind);
    return Promise.resolve(settingsContracts.getState.response.parse({ kind: "ok", value: setup }));
  }

  function setupConflict(): ReturnType<SettingsApi["getState"]> {
    return Promise.resolve(settingsContracts.getState.response.parse({
      kind: "error", code: "conflict", message: "初回設定の手順を確認してください。",
    }));
  }

  function requireSetup(kind: SetupKind, next: SetupKind): ReturnType<SettingsApi["getState"]> {
    return setup.kind === kind ? setSetup(next) : setupConflict();
  }

  function setAuthentication(kind: AuthenticationKind): ReturnType<SettingsApi["getAsanaAuthenticationState"]> {
    authentication = authenticationFixture(kind);
    return Promise.resolve(settingsContracts.getAsanaAuthenticationState.response.parse({
      kind: "ok", value: authentication,
    }));
  }

  function authenticationConflict() {
    return ipcFailureSchema.parse({
      kind: "error", code: "conflict", message: "Asana認証の状態を確認してください。",
    });
  }

  return {
    getState: () => Promise.resolve(settingsContracts.getState.response.parse({ kind: "ok", value: setup })),
    start: () => requireSetup("created", "codex_authentication_required"),
    completeCodexAuthentication: () => setup.kind === "ready"
      ? Promise.resolve(settingsContracts.getState.response.parse({ kind: "ok", value: setup })) : requireSetup("codex_authentication_required", "credentials_required"),
    beginAsanaAuthorization: (input) => {
      settingsContracts.beginAsanaAuthorization.request.parse(input);
      return setup.kind === "credentials_required" ? setSetup("asana_authorization_pending") : setupConflict();
    },
    completeAsanaAuthorization: (input) => {
      settingsContracts.completeAsanaAuthorization.request.parse(input);
      return setup.kind === "asana_authorization_pending" && input.authorization_id === authorizationId
        ? setSetup("workspace_listing_required") : setupConflict();
    },
    cancelAsanaAuthorization: (input) => {
      settingsContracts.cancelAsanaAuthorization.request.parse(input);
      return setup.kind === "asana_authorization_pending" && input.authorization_id === authorizationId
        ? setSetup("credentials_required") : setupConflict();
    },
    listWorkspaces: () => requireSetup("workspace_listing_required", "workspace_selection_required"),
    selectWorkspace: (workspaceGid) => {
      const input = settingsContracts.selectWorkspace.request.parse({ workspace_gid: workspaceGid });
      return input.workspace_gid === workspace.gid
        ? requireSetup("workspace_selection_required", "project_selection_required") : setupConflict();
    },
    selectProject: (input) => {
      settingsContracts.selectProject.request.parse(input);
      return setup.kind === "project_selection_required" || setup.kind === "project_requires_action"
        ? setSetup("resources_requires_action") : setupConflict();
    },
    retryResources: () => requireSetup("resources_requires_action", "resources_ready"),
    runCapability: () => setup.kind === "resources_ready" || setup.kind === "asana_capability_failed"
      ? setSetup("vault_choice_required") : setupConflict(),
    chooseVault: (input) => {
      settingsContracts.chooseVault.request.parse(input);
      return setup.kind === "vault_choice_required"
        ? setSetup(input.kind === "skip" ? "vault_skipped" : "vault_configured") : setupConflict();
    },
    chooseExternalTool: (input) => {
      settingsContracts.chooseExternalTool.request.parse(input);
      return setup.kind === "vault_skipped" || setup.kind === "vault_configured"
        ? setSetup(input.kind === "skip" ? "external_tool_skipped" : "external_tool_configured") : setupConflict();
    },
    runFullSync: () => ["external_tool_skipped", "external_tool_configured", "external_tool_unavailable", "full_sync_required"]
      .includes(setup.kind) ? setSetup("codex_capability_required") : setupConflict(),
    runCodexCapability: () => requireSetup("codex_capability_required", "ready"),
    getAsanaAuthenticationState: () => {
      if (authenticationFailure !== "none") {
        if (authenticationFailure === "once") {
          authenticationFailure = "none";
        }
        return Promise.resolve(settingsContracts.getAsanaAuthenticationState.response.parse({
          kind: "error", code: "operation_failed", message: "Asana認証状態を確認できませんでした。",
          error_id: "00000000-0000-4000-8000-000000000045",
        }));
      }
      if (authentication.kind === "opening") {
        return setAuthentication("authorization_pending");
      }
      if (authentication.kind === "synchronizing") {
        return setAuthentication("idle");
      }
      return Promise.resolve(settingsContracts.getAsanaAuthenticationState.response.parse({ kind: "ok", value: authentication }));
    },
    beginAsanaReauthentication: () => authentication.kind === "idle"
      ? setAuthentication("opening")
      : Promise.resolve(settingsContracts.beginAsanaReauthentication.response.parse(authenticationConflict())),
    completeAsanaReauthentication: (input) => {
      settingsContracts.completeAsanaReauthentication.request.parse(input);
      if (authentication.kind !== "authorization_pending" || input.authorization_id !== authorizationId) {
        return Promise.resolve(settingsContracts.completeAsanaReauthentication.response.parse(authenticationConflict()));
      }
      authentication = authenticationFixture("idle");
      return Promise.resolve(settingsContracts.completeAsanaReauthentication.response.parse({
        kind: "ok", value: {
          synced_at: "2026-09-28T00:00:00.000Z", performed_mode: "full",
          normalization_notifications: [{
            kind: "status_reconciled", task_gid: "mock-task", status: "in_progress",
            message: "画面確認用タスクの状態を整合しました。",
          }],
          conflict_count: 2, remaining_write_count: 1, critical_error_count: 1, cleanup_count: 3,
        },
      }));
    },
    cancelAsanaReauthentication: (input) => {
      settingsContracts.cancelAsanaReauthentication.request.parse(input);
      return authentication.kind === "authorization_pending" && input.authorization_id === authorizationId
        ? setAuthentication("idle")
        : Promise.resolve(settingsContracts.cancelAsanaReauthentication.response.parse(authenticationConflict()));
    },
  };
}
