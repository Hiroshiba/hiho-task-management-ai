import {
  normalizeExternalAgentDiagnosticMessage,
  normalizeExternalAgentWorkspaceIssue,
  paginateExternalAgentWorkspaceEntries,
} from "./external-agent-response";

type ValidationOperation =
  | { readonly operation_id: string; readonly kind: "valid" }
  | {
      readonly operation_id: string;
      readonly kind: "invalid";
      readonly errors: readonly { readonly code: string; readonly message: string }[];
    };

type ValidatedProposal = {
  readonly groups: readonly {
    readonly group_id: string;
    readonly operations: readonly { readonly operation_id: string }[];
  }[];
};

type ValidationResult<TProposal, TGraph> =
  | {
      readonly kind: "invalid";
      readonly revision: number;
      readonly issues: readonly { readonly message: string }[];
    }
  | {
      readonly kind: "valid";
      readonly revision: number;
      readonly proposal: TProposal;
      readonly value: {
        readonly basic: { readonly operations: readonly ValidationOperation[] };
        readonly graph: TGraph & { readonly operations: readonly ValidationOperation[] };
      };
    };

/** 外部提案の検証結果を容量制限付きのCLI応答へ変換します。 */
export function externalAgentValidationResponse<
  TProposal extends ValidatedProposal,
  TGraph extends { readonly operations: readonly ValidationOperation[] },
>(
  workspaceId: string,
  offset: number,
  result: ValidationResult<TProposal, TGraph>,
  eligibleOperationIds: (proposal: TProposal, graph: TGraph) => readonly string[],
  maximumMessageBytes: number,
  maximumResponseBytes: number,
  createInvalidOffsetError: () => Error,
): object {
  if (result.kind === "invalid") {
    const issues = result.issues.map((issue) =>
      normalizeExternalAgentWorkspaceIssue(issue, maximumMessageBytes));
    const createResponse = (page: readonly (typeof issues)[number][], nextOffset: number | undefined): object => ({
      operation: "proposals.validate",
      workspace_id: workspaceId,
      revision: result.revision,
      can_submit: false,
      review: {
        kind: "issues",
        offset,
        issue_count: issues.length,
        issues: page,
        ...(nextOffset == null ? {} : { next_offset: nextOffset }),
      },
    });
    const page = paginateExternalAgentWorkspaceEntries(
      issues, offset, createResponse, maximumResponseBytes, createInvalidOffsetError,
    );
    return createResponse(page.page, page.next_offset);
  }
  const basicById = new Map(result.value.basic.operations.map((operation) => [operation.operation_id, operation]));
  const graphById = new Map(result.value.graph.operations.map((operation) => [operation.operation_id, operation]));
  const eligible = new Set(eligibleOperationIds(result.proposal, result.value.graph));
  const operationCount = result.proposal.groups.reduce((count, group) => count + group.operations.length, 0);
  const entries = result.proposal.groups.flatMap((group) => group.operations.flatMap((operation) => {
    const basic = basicById.get(operation.operation_id);
    const graph = graphById.get(operation.operation_id);
    if (basic == null || graph == null) {
      throw new Error("操作の検証結果が不足しています。");
    }
    const summary = {
      kind: "operation",
      group_id: group.group_id,
      operation_id: operation.operation_id,
      basic: { kind: basic.kind },
      graph: { kind: graph.kind },
      eligible: eligible.has(operation.operation_id),
    };
    const basicDiagnostics = basic.kind === "invalid"
      ? basic.errors.map((error) => ({
          kind: "diagnostic",
          group_id: group.group_id,
          operation_id: operation.operation_id,
          phase: "basic",
          code: error.code,
          ...normalizeExternalAgentDiagnosticMessage(error.message, maximumMessageBytes),
        }))
      : [];
    const graphDiagnostics = graph.kind === "invalid"
      ? graph.errors.map((error) => ({
          kind: "diagnostic",
          group_id: group.group_id,
          operation_id: operation.operation_id,
          phase: "graph",
          code: error.code,
          ...normalizeExternalAgentDiagnosticMessage(error.message, maximumMessageBytes),
        }))
      : [];
    return [summary, ...basicDiagnostics, ...graphDiagnostics];
  }));
  const createResponse = (page: readonly (typeof entries)[number][], nextOffset: number | undefined): object => ({
    operation: "proposals.validate",
    workspace_id: workspaceId,
    revision: result.revision,
    can_submit: true,
    review: {
      kind: "operations",
      offset,
      operation_count: operationCount,
      entry_count: entries.length,
      entries: page,
      ...(nextOffset == null ? {} : { next_offset: nextOffset }),
    },
  });
  const page = paginateExternalAgentWorkspaceEntries(
    entries, offset, createResponse, maximumResponseBytes, createInvalidOffsetError,
  );
  return createResponse(page.page, page.next_offset);
}
