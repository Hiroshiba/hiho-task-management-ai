import type { Proposal } from "../../domain";
import type { ExternalAgentApplyPort, ExternalAgentBaseline, ExternalProposalValidation } from "../common/ports/external-agent-proposal";
import type { externalAgentTaskctlQuery } from "./external-agent-task-query";
import type { ExternalAgentCliInput, ExternalAgentWorkspace } from "./external-agent-contract";
import type { SnapshotHasher } from "../common/ports/snapshot-hasher";

export type TaskctlSnapshotShape = {
  readonly sync: { readonly kind: string; readonly synced_at?: string | undefined };
  readonly tasks: unknown;
};

type RuntimeState = {
  readonly kind: string;
  readonly last_successful_sync_at?: string | undefined;
  readonly last_error_code?: string | undefined;
};

type ExternalAgentProtocolPort = {
  readonly protocol_version: number;
  readonly maximum_message_bytes: number;
  readonly maximum_workspace_response_bytes: number;
  readonly input_schema: () => unknown;
  readonly parse_cli_input: (value: unknown) => ExternalAgentCliInput;
  readonly is_input_error: (error: unknown) => boolean;
  readonly parse_error_response: (value: unknown) => unknown;
  readonly parse_prepare_response: (value: unknown) => unknown;
  readonly parse_read_response: (value: unknown) => unknown;
  readonly parse_apply_edits_response: (value: unknown) => unknown;
  readonly parse_diff_response: (value: unknown) => unknown;
  readonly parse_validate_response: (value: unknown) => unknown;
  readonly parse_submit_response: (value: unknown) => unknown;
  readonly parse_task_query_response: (value: unknown) => unknown;
  readonly workspace_conflict: (error: unknown) => { readonly code: string; readonly message: string } | undefined;
  readonly is_workspace_input_error: (error: unknown) => error is Error;
};

export type ExternalAgentGenerationOptions<TState, TTaskctl extends TaskctlSnapshotShape> = {
  readonly app_version: string;
  readonly instance_id: string;
  readonly lifecycle_signal: AbortSignal;
  readonly now_provider: () => Date;
  readonly online_provider: () => boolean;
  readonly get_taskctl_snapshot: () => TTaskctl;
  readonly parse_taskctl_snapshot: (value: unknown) => TTaskctl;
  readonly execute_taskctl_query: (query: ReturnType<typeof externalAgentTaskctlQuery>, snapshot: TTaskctl) => unknown;
  readonly get_runtime_state: () => RuntimeState | undefined;
  readonly create_baseline: (signal: AbortSignal) => ExternalAgentBaseline<TTaskctl> | PromiseLike<ExternalAgentBaseline<TTaskctl>>;
  readonly assert_apply_ready: () => void;
  readonly create_id: () => string;
  readonly hash_baseline_snapshot: SnapshotHasher["hashBaselineSnapshot"];
  readonly create_workspace: (workspaceId: string, baselineSnapshotHash: string) => ExternalAgentWorkspace;
  readonly bridge: {
    readonly getState: () => { readonly kind: string; readonly enabled: boolean };
    readonly setEnabled: (enabled: boolean) => PromiseLike<void> | void;
  };
  readonly apply: ExternalAgentApplyPort<TState>;
  readonly eligible_operation_ids: (proposal: Proposal, graph: ExternalProposalValidation["graph"]) => readonly string[];
  readonly protocol: ExternalAgentProtocolPort;
};
