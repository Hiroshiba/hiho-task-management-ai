/** Asanaの適用結果を外部提案の承認概要へ変換します。 */
export function externalAgentApplicationSummary(result: {
  readonly outcome: string;
  readonly operations: readonly {
    readonly group_id: string;
    readonly operation_id: string;
    readonly task_gid?: string | undefined;
    readonly outcome: string;
    readonly reason_code: string;
  }[];
  readonly groups: readonly {
    readonly group_id: string;
    readonly atomic: boolean;
    readonly outcome: string;
    readonly operation_ids: readonly string[];
  }[];
}): object {
  return {
    outcome: result.outcome,
    operations: result.operations.map((operation) => ({
      group_id: operation.group_id,
      operation_id: operation.operation_id,
      ...(operation.task_gid == null ? {} : { task_gid: operation.task_gid }),
      outcome: operation.outcome,
      reason_code: operation.reason_code,
    })),
    groups: result.groups.map((group) => ({
      group_id: group.group_id,
      atomic: group.atomic,
      outcome: group.outcome,
      operation_ids: [...group.operation_ids],
    })),
  };
}

type ExternalProposalSummary = {
  readonly proposal_id: string;
  readonly request_id: string;
  readonly instance_id: string;
  readonly context_id: string;
  readonly proposal_context_id: string;
  readonly operation_ids: readonly string[];
  readonly revision: number;
  readonly state: unknown;
};

/** 外部提案をGUI向けの概要へ変換します。 */
export function externalAgentProposalSummary(record: ExternalProposalSummary & { readonly view: unknown }): object {
  return {
    proposal_id: record.proposal_id,
    request_id: record.request_id,
    instance_id: record.instance_id,
    context_id: record.context_id,
    proposal_context_id: record.proposal_context_id,
    operation_ids: [...record.operation_ids],
    revision: record.revision,
    source: "external_tool",
    state: record.state,
    view: record.view,
  };
}

/** 外部提案をCLI向けの状態概要へ変換します。 */
export function externalAgentProposalStatusSummary(record: ExternalProposalSummary): object {
  return {
    proposal_id: record.proposal_id,
    request_id: record.request_id,
    instance_id: record.instance_id,
    context_id: record.context_id,
    proposal_context_id: record.proposal_context_id,
    operation_ids: [...record.operation_ids],
    revision: record.revision,
    source: "external_tool",
    state: record.state,
  };
}
