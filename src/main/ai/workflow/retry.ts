import { z } from "zod";
import { identifierSchema } from "../../../shared/domain";

const maximumRetryAttempts = 3;

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const aiWorkflowZodIssueCodeSchema = z.enum([
  "invalid_type",
  "too_big",
  "too_small",
  "invalid_format",
  "not_multiple_of",
  "unrecognized_keys",
  "invalid_union",
  "invalid_key",
  "invalid_element",
  "invalid_value",
  "custom",
  "other",
]);

const proposalValidationCodeSchema = z.enum([
  "baseline_snapshot_mismatch",
  "target_not_managed",
  "dependency_not_managed",
  "parent_not_managed",
  "area_not_found",
  "before_value_mismatch",
  "split_request_not_explicit",
  "status_evidence_invalid",
  "conflicting_field_update",
  "dependency_cycle",
  "parent_cycle",
]);

export const aiWorkflowValidationDetailCodeSchema = z.union([
  aiWorkflowZodIssueCodeSchema,
  proposalValidationCodeSchema,
]);

export const aiWorkflowRetryPhaseSchema = z.enum([
  "structured_output",
  "proposal_workspace",
  "evidence_binding",
  "basic_validation",
  "graph_validation",
  "applyability",
]);

export const aiWorkflowRetryCodeSchema = z.enum([
  "structured_output_invalid",
  "proposal_workspace_not_submitted",
  "proposal_workspace_reference_mismatch",
  "evidence_binding_invalid",
  "proposal_basic_validation_failed",
  "proposal_graph_validation_failed",
  "proposal_group_not_applicable",
]);

export const aiWorkflowCandidateDigestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    sha256: digestSchema,
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["missing", "unsafe", "too_large", "read_failed", "not_staged"]),
  }).strict(),
]);

export const aiWorkflowPreviousDigestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    sha256: digestSchema,
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["not_available", "candidate_unavailable"]),
  }).strict(),
]);

export const aiWorkflowValidationIssueSchema = z
  .object({
    phase: aiWorkflowRetryPhaseSchema,
    code: aiWorkflowRetryCodeSchema,
    json_pointer: z.string().max(4_096),
    group_id: identifierSchema.optional(),
    operation_id: identifierSchema.optional(),
    validator_code: aiWorkflowValidationDetailCodeSchema.optional(),
  })
  .strict();

export const aiWorkflowValidationErrorsSchema = z
  .object({
    attempt: z.number().int().min(1).max(maximumRetryAttempts),
    max_attempts: z.literal(maximumRetryAttempts),
    candidate_sha256: aiWorkflowCandidateDigestSchema,
    previous_sha256: aiWorkflowPreviousDigestSchema,
    candidate_unchanged: z.boolean(),
    error_fingerprint: digestSchema,
    errors: z.array(aiWorkflowValidationIssueSchema).min(1).max(4_096),
  })
  .strict();

export type AiWorkflowSafeErrorCause =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly value: AiWorkflowSafeErrorProjection };

export const aiWorkflowSafeErrorDescriptionSchema = z.enum([
  "AI変更案の検証に失敗しました。",
  "Codexの構造化出力を検証できませんでした。",
  "複数の処理に失敗しました。",
  "構造化データの検証に失敗しました。",
  "処理に失敗しました。",
  "Error以外の値が例外として送出されました。",
]);

export type AiWorkflowSafeErrorDescription = z.infer<
  typeof aiWorkflowSafeErrorDescriptionSchema
>;

export type AiWorkflowSafeErrorProjection =
  | {
      readonly kind: "error";
      readonly node_id: string;
      readonly error_name: string;
      readonly description: string;
      readonly stack_frames: readonly string[];
      readonly cause: AiWorkflowSafeErrorCause;
      readonly aggregate_errors: readonly AiWorkflowSafeErrorProjection[];
    }
  | { readonly kind: "reference"; readonly node_id: string };

export const aiWorkflowSafeErrorProjectionSchema: z.ZodType<AiWorkflowSafeErrorProjection> =
  z.lazy(() =>
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("error"),
        node_id: z.string().min(1),
        error_name: z.string(),
        description: aiWorkflowSafeErrorDescriptionSchema,
        stack_frames: z.array(z.string()),
        cause: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("absent") }).strict(),
          z.object({
            kind: z.literal("present"),
            value: aiWorkflowSafeErrorProjectionSchema,
          }).strict(),
        ]),
        aggregate_errors: z.array(aiWorkflowSafeErrorProjectionSchema),
      }).strict(),
      z.object({
        kind: z.literal("reference"),
        node_id: z.string().min(1),
      }).strict(),
    ]),
  );

export const aiWorkflowRetryLogEventSchema = z
  .object({
    severity: z.enum(["warning", "error"]),
    session_id: identifierSchema,
    logical_turn_id: identifierSchema,
    attempt: z.number().int().min(1).max(maximumRetryAttempts),
    max_attempts: z.literal(maximumRetryAttempts),
    phase: aiWorkflowRetryPhaseSchema,
    code: aiWorkflowRetryCodeSchema,
    candidate_sha256: aiWorkflowCandidateDigestSchema,
    previous_sha256: aiWorkflowPreviousDigestSchema,
    candidate_unchanged: z.boolean(),
    error_fingerprint: digestSchema,
    json_pointers: z.array(z.string().max(4_096)).max(4_096),
    retry_decision: z.enum(["retry", "stop"]),
    cause: aiWorkflowSafeErrorProjectionSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (
      (event.severity === "warning" && event.retry_decision !== "retry")
      || (event.severity === "error" && event.retry_decision !== "stop")
      || (event.severity === "warning" && event.attempt < 2)
    ) {
      context.addIssue({
        code: "custom",
        path: ["retry_decision"],
        message: "再試行判断とログ重要度が一致しません。",
      });
    }
  });

export type AiWorkflowRetryPhase = z.infer<typeof aiWorkflowRetryPhaseSchema>;
export type AiWorkflowRetryCode = z.infer<typeof aiWorkflowRetryCodeSchema>;
export type AiWorkflowCandidateDigest = z.infer<
  typeof aiWorkflowCandidateDigestSchema
>;
export type AiWorkflowPreviousDigest = z.infer<
  typeof aiWorkflowPreviousDigestSchema
>;
export type AiWorkflowValidationIssue = z.infer<
  typeof aiWorkflowValidationIssueSchema
>;
export type AiWorkflowValidationErrors = z.infer<
  typeof aiWorkflowValidationErrorsSchema
>;

/** Codex変更案の再試行警告と最終エラーを記録する安全なイベントです。 */
export type AiWorkflowRetryLogEvent = Readonly<
  z.infer<typeof aiWorkflowRetryLogEventSchema>
>;

/** AI変更案の再試行イベントを診断ログへ渡すエラーです。 */
export class AiWorkflowRetryLogEventError extends Error {
  public readonly event: AiWorkflowRetryLogEvent;

  public constructor(event: AiWorkflowRetryLogEvent) {
    super("AI変更案の訂正再試行イベントです。");
    this.name = "AiWorkflowRetryLogEventError";
    this.event = aiWorkflowRetryLogEventSchema.parse(event);
  }
}

export const aiWorkflowMaximumRetryAttempts = maximumRetryAttempts;
