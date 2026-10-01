import { z } from "zod";
import { gidSchema } from "./primitives";

/** 端末が使用する四つの状態セクションGIDを検証するスキーマです。 */
export const setupSectionGidsSchema = z
  .object({
    not_started: gidSchema,
    in_progress: gidSchema,
    completed: gidSchema,
    withdrawn: gidSchema,
  })
  .strict()
  .superRefine((sectionGids, context) => {
    const seen = new Set<string>();
    Object.entries(sectionGids).forEach(([name, gid]) => {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "4つの状態セクションGIDはすべて異なる値で指定してください。",
        });
        return;
      }
      seen.add(gid);
    });
  });

/** 端末の状態セクションです。 */
export type SetupSectionGids = z.infer<typeof setupSectionGidsSchema>;

/** 初回設定で照合するタグです。 */
export type SetupTagGids = {
  readonly importance_1: string;
  readonly importance_2: string;
  readonly importance_3: string;
  readonly importance_4: string;
  readonly importance_5: string;
  readonly area_unclassified: string;
  readonly block_none: string;
  readonly block_partial: string;
  readonly block_full: string;
};

export type SetupCodexUnavailableReason =
  | "not_installed" | "incompatible" | "permission_denied" | "startup_failed" | "disabled";

export type SetupCodexAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason_code: SetupCodexUnavailableReason };

export type SetupCodexAuthenticationState =
  | { readonly kind: "authenticated" }
  | { readonly kind: "required" }
  | Extract<SetupCodexAvailability, { kind: "unavailable" }>;

export type SetupWorkspace = { readonly gid: string; readonly name: string };
export type SetupProject = { readonly gid: string; readonly name: string };
export type SetupVaultMapping = { readonly vault_id: string; readonly absolute_path: string };

export type SetupResourceIssue = {
  readonly resource: "section" | "tag";
  readonly name: string;
  readonly reason: "duplicate" | "renamed" | "configured_missing";
  readonly configured_gid?: string | undefined;
};

export type SetupContext = {
  readonly device_id: string;
  readonly client_id: string;
  readonly workspace_gid: string;
  readonly workspace_name: string;
  readonly project_gid: string;
  readonly project_name: string;
  readonly section_gids: SetupSectionGids;
  readonly tag_gids: SetupTagGids;
  readonly codex: SetupCodexAvailability;
};

export type SetupContextWithTestTask = SetupContext & { readonly test_task_gid: string };

/** 初回設定の進行段階と再開に必要な値です。 */
export type SetupState =
  | { readonly kind: "created"; readonly step: "codex_cli" }
  | { readonly kind: "codex_cli_ready"; readonly step: "codex_authentication"; readonly codex: { readonly kind: "available" } }
  | { readonly kind: "codex_authentication_required"; readonly step: "codex_authentication"; readonly codex: { readonly kind: "available" } }
  | { readonly kind: "credentials_required"; readonly step: "credentials"; readonly codex: SetupCodexAvailability }
  | { readonly kind: "asana_authorization_pending"; readonly step: "credentials"; readonly client_id: string; readonly authorization_id: string; readonly expires_at: string; readonly codex: SetupCodexAvailability }
  | { readonly kind: "workspace_listing_required"; readonly step: "workspace"; readonly client_id: string; readonly codex: SetupCodexAvailability }
  | { readonly kind: "workspace_selection_required"; readonly step: "workspace"; readonly client_id: string; readonly codex: SetupCodexAvailability; readonly workspaces: SetupWorkspace[] }
  | { readonly kind: "project_selection_required"; readonly step: "project"; readonly client_id: string; readonly codex: SetupCodexAvailability; readonly workspace: SetupWorkspace; readonly projects: SetupProject[] }
  | { readonly kind: "project_requires_action"; readonly step: "project"; readonly client_id: string; readonly codex: SetupCodexAvailability; readonly workspace: SetupWorkspace; readonly projects: SetupProject[]; readonly reason_code: "duplicate_project_name" }
  | { readonly kind: "resources_requires_action"; readonly step: "resources"; readonly client_id: string; readonly codex: SetupCodexAvailability; readonly workspace: SetupWorkspace; readonly project: SetupProject; readonly issues: SetupResourceIssue[] }
  | { readonly kind: "resources_ready"; readonly step: "asana_capability"; readonly context: SetupContext }
  | { readonly kind: "asana_capability_failed"; readonly step: "asana_capability"; readonly context: SetupContext; readonly reason_code: "task_create_failed" | "task_update_failed" | "section_move_failed" | "tag_update_failed" | "external_data_failed" | "read_back_failed" | "cleanup_failed" | "unknown"; readonly test_task_gid?: string | undefined }
  | { readonly kind: "vault_choice_required"; readonly step: "vault"; readonly context: SetupContextWithTestTask }
  | { readonly kind: "full_sync_required"; readonly step: "full_sync"; readonly context: SetupContextWithTestTask }
  | { readonly kind: "codex_capability_required"; readonly step: "codex_capability"; readonly context: SetupContextWithTestTask }
  | { readonly kind: "ready"; readonly step: "ready"; readonly context: SetupContextWithTestTask };

export type SetupAsanaAuthorizationBeginInput = { readonly client_id: string; readonly client_secret: string };
export type SetupAsanaAuthorizationCompleteInput = { readonly authorization_id: string; readonly authorization_code: string };
export type SetupAsanaAuthorizationCancelInput = { readonly authorization_id: string };
export type SetupWorkspaceSelectionInput = { readonly workspace_gid: string };
export type SetupProjectSelectionInput =
  | { readonly kind: "existing"; readonly project_gid: string }
  | { readonly kind: "create"; readonly name: string };
export type SetupVaultChoiceInput =
  | { readonly kind: "skip" }
  | { readonly kind: "configure"; readonly mapping: SetupVaultMapping };
export type SetupFullSyncInput = {
  readonly device_id: string;
  readonly client_id: string;
  readonly workspace_gid: string;
  readonly project_gid: string;
  readonly section_gids: SetupSectionGids;
};
