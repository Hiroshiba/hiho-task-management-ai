import type {
  SetupAsanaAuthorizationBeginInput,
  SetupAsanaAuthorizationCancelInput,
  SetupAsanaAuthorizationCompleteInput,
  SetupExternalToolChoiceInput,
  SetupProjectSelectionInput,
  SetupVaultChoiceInput,
} from "../../../shared/ipc-contracts/setup-schemas";

export type SetupAction =
  | { readonly kind: "start" }
  | { readonly kind: "complete_codex_authentication" }
  | { readonly kind: "begin_asana_authorization"; readonly input: SetupAsanaAuthorizationBeginInput }
  | { readonly kind: "complete_asana_authorization"; readonly input: SetupAsanaAuthorizationCompleteInput }
  | { readonly kind: "cancel_asana_authorization"; readonly input: SetupAsanaAuthorizationCancelInput }
  | { readonly kind: "list_workspaces" }
  | { readonly kind: "select_workspace"; readonly workspaceGid: string }
  | { readonly kind: "select_project"; readonly input: SetupProjectSelectionInput }
  | { readonly kind: "retry_resources" }
  | { readonly kind: "run_capability" }
  | { readonly kind: "choose_vault"; readonly input: SetupVaultChoiceInput }
  | { readonly kind: "choose_external_tool"; readonly input: SetupExternalToolChoiceInput }
  | { readonly kind: "run_full_sync" }
  | { readonly kind: "run_codex_capability" };
