import { createSafeErrorProjection } from "./retry-error-projection";
import type { SafeErrorProjectionDependencies } from "./retry-error-projection";
import { z } from "zod";

type CandidateDigest =
  | { readonly kind: "available"; readonly sha256: string }
  | { readonly kind: "unavailable"; readonly reason: string };

type PreviousDigest =
  | { readonly kind: "available"; readonly sha256: string }
  | { readonly kind: "unavailable"; readonly reason: string };

type Failure = Error & {
  readonly issues: readonly { readonly phase: string; readonly code: string; readonly json_pointer: string }[];
  readonly candidateDigest: CandidateDigest;
};

type RetryDependencies<TValidationErrors, TEvent> = {
  readonly hashIssues: (issues: readonly unknown[]) => string;
  readonly parseValidationErrors: (value: unknown) => TValidationErrors;
  readonly parseRetryLogEvent: (value: unknown) => TEvent;
  readonly maximumRetryAttempts: number;
  readonly errorProjection: SafeErrorProjectionDependencies;
};

type ValidationOperation =
  | { readonly kind: "valid"; readonly group_id: string; readonly operation_id: string }
  | { readonly kind: "invalid"; readonly group_id: string; readonly operation_id: string; readonly errors: readonly { readonly code: string }[] };

type ValidationResult = {
  readonly operations: readonly ValidationOperation[];
  readonly groups: readonly { readonly applicable: boolean; readonly group_id: string }[];
};

type ProposalValidationInput = {
  readonly proposal: { readonly groups: readonly { readonly operations: readonly { readonly operation_id: string }[] }[] };
  readonly basic_validation: ValidationResult;
  readonly graph_validation: ValidationResult;
};

type ValidationIssueDependencies<TIssue> = {
  readonly parseIssue: (value: unknown) => TIssue;
  readonly parseDetailCode: (value: string) => string;
};

function isCandidateUnchanged(
  digest: CandidateDigest,
  previousDigest: PreviousDigest,
): boolean {
  return digest.kind === "available"
    && previousDigest.kind === "available"
    && digest.sha256 === previousDigest.sha256;
}

/** 再試行へ渡す構造化検証エラーを組み立てます。 */
export function createValidationErrorsDocument<TValidationErrors, TEvent>(
  attempt: number,
  failure: Failure,
  previousDigest: PreviousDigest,
  dependencies: RetryDependencies<TValidationErrors, TEvent>,
): TValidationErrors {
  const fingerprint = dependencies.hashIssues(failure.issues);
  return dependencies.parseValidationErrors({
    attempt,
    max_attempts: dependencies.maximumRetryAttempts,
    candidate_sha256: failure.candidateDigest,
    previous_sha256: previousDigest,
    candidate_unchanged: isCandidateUnchanged(
      failure.candidateDigest,
      previousDigest,
    ),
    error_fingerprint: fingerprint,
    errors: failure.issues,
  });
}

/** 訂正再試行の診断イベントを組み立てます。 */
export function createRetryLogEvent<TValidationErrors, TEvent>(
  severity: "warning" | "error",
  sessionId: string,
  logicalTurnId: string,
  attempt: number,
  failure: Failure,
  previousDigest: PreviousDigest,
  retryDecision: "retry" | "stop",
  dependencies: RetryDependencies<TValidationErrors, TEvent>,
): TEvent {
  const primaryIssue = failure.issues[0];
  if (primaryIssue == null) {
    throw new Error("再試行ログに検証エラーがありません。");
  }
  return dependencies.parseRetryLogEvent({
    severity,
    session_id: sessionId,
    logical_turn_id: logicalTurnId,
    attempt,
    max_attempts: dependencies.maximumRetryAttempts,
    phase: primaryIssue.phase,
    code: primaryIssue.code,
    candidate_sha256: failure.candidateDigest,
    previous_sha256: previousDigest,
    candidate_unchanged: isCandidateUnchanged(
      failure.candidateDigest,
      previousDigest,
    ),
    error_fingerprint: dependencies.hashIssues(failure.issues),
    json_pointers: failure.issues.map((issue) => issue.json_pointer),
    retry_decision: retryDecision,
    cause: createSafeErrorProjection(failure, dependencies.errorProjection),
  });
}

/** 基本検証とグラフ検証の失敗位置を列挙します。 */
export function proposalValidationIssues<TIssue>(stored: ProposalValidationInput, dependencies: ValidationIssueDependencies<TIssue>): TIssue[] {
  const operationLocations = new Map<
    string,
    { readonly groupIndex: number; readonly operationIndex: number }
  >();
  for (const [groupIndex, group] of stored.proposal.groups.entries()) {
    for (const [operationIndex, operation] of group.operations.entries()) {
      operationLocations.set(operation.operation_id, { groupIndex, operationIndex });
    }
  }
  const issues: TIssue[] = [];
  for (const operation of stored.basic_validation.operations) {
    if (operation.kind !== "invalid") {
      continue;
    }
    const location = operationLocations.get(operation.operation_id);
    if (location == null) {
      throw new Error("基本検証結果のoperation_idが変更案にありません。");
    }
    for (const error of operation.errors) {
      issues.push(dependencies.parseIssue({
        phase: "basic_validation",
        code: "proposal_basic_validation_failed",
        json_pointer: `/groups/${location.groupIndex}/operations/${location.operationIndex}`,
        group_id: operation.group_id,
        operation_id: operation.operation_id,
        validator_code: dependencies.parseDetailCode(error.code),
      }));
    }
  }
  for (const operation of stored.graph_validation.operations) {
    if (operation.kind !== "invalid") {
      continue;
    }
    const location = operationLocations.get(operation.operation_id);
    if (location == null) {
      throw new Error("グラフ検証結果のoperation_idが変更案にありません。");
    }
    for (const error of operation.errors) {
      issues.push(dependencies.parseIssue({
        phase: "graph_validation",
        code: "proposal_graph_validation_failed",
        json_pointer: `/groups/${location.groupIndex}/operations/${location.operationIndex}`,
        group_id: operation.group_id,
        operation_id: operation.operation_id,
        validator_code: dependencies.parseDetailCode(error.code),
      }));
    }
  }
  for (const [groupIndex, group] of stored.basic_validation.groups.entries()) {
    if (!group.applicable) {
      issues.push(dependencies.parseIssue({
        phase: "applyability",
        code: "proposal_group_not_applicable",
        json_pointer: `/groups/${groupIndex}`,
        group_id: group.group_id,
      }));
    }
  }
  for (const [groupIndex, group] of stored.graph_validation.groups.entries()) {
    if (!group.applicable) {
      issues.push(dependencies.parseIssue({
        phase: "applyability",
        code: "proposal_group_not_applicable",
        json_pointer: `/groups/${groupIndex}`,
        group_id: group.group_id,
      }));
    }
  }
  return issues;
}

/** 構造化出力の検証位置を秘匿済みJSONポインタへ変換します。 */
export function jsonPointer(path: readonly PropertyKey[]): string {
  const secretLikeFieldName = /(?:password|token|secret|credential|authorization|api[_-]?key)/iu;
  const segments = path.map((segment) => {
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      return String(segment);
    }
    if (
      typeof segment !== "string"
      || !/^[A-Za-z0-9_-]{1,64}$/u.test(segment)
      || secretLikeFieldName.test(segment)
    ) {
      return "unknown_field";
    }
    return segment.replaceAll("~", "~0").replaceAll("/", "~1");
  });
  return segments.length === 0 ? "" : `/${segments.join("/")}`;
}

/** 構造化出力の検証失敗を訂正再試行に使う失敗へ変換します。 */
export function createStructuredOutputFailure<TIssue, TDigest, TFailure extends Error>(
  error: Error & { readonly cause?: unknown },
  candidateDigest: TDigest,
  dependencies: {
    readonly parseIssue: (value: unknown) => TIssue;
    readonly parseZodIssueCode: (code: string) => string;
    readonly createFailure: (issues: readonly TIssue[], digest: TDigest, cause: Error) => TFailure;
  },
): TFailure {
  const cause = error.cause;
  const issues = cause instanceof z.ZodError
    ? cause.issues.map((issue) => dependencies.parseIssue({
        phase: "structured_output",
        code: "structured_output_invalid",
        json_pointer: jsonPointer(issue.path),
        validator_code: dependencies.parseZodIssueCode(issue.code),
      }))
    : [];
  return dependencies.createFailure(
    issues.length === 0
      ? [dependencies.parseIssue({
          phase: "structured_output",
          code: "structured_output_invalid",
          json_pointer: "",
        })]
      : issues,
    candidateDigest,
    error,
  );
}

/** 候補のダイジェストを次の再試行の前回値へ写します。 */
export function previousDigestFromCandidate<TDigest extends CandidateDigest>(
  digest: TDigest,
): { readonly kind: "available"; readonly sha256: string }
  | { readonly kind: "unavailable"; readonly reason: "candidate_unavailable" } {
  return digest.kind === "available"
    ? { kind: "available", sha256: digest.sha256 }
    : { kind: "unavailable", reason: "candidate_unavailable" };
}
