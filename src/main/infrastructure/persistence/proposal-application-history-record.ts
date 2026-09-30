import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProposalApplicationHistoryStep } from "../../application/common/ports/proposal-application-history";
import { gidSchema, identifierSchema, isoDateTimeSchema } from "../../domain/primitives";
import { customExternalDataSchema } from "../../domain/schemas";
import { canonicalizeJson } from "../../domain/canonical-json";

const legacyTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new_task"), uuid: z.uuid() }).strict(),
  z.object({ kind: z.literal("existing"), gid: gidSchema }).strict(),
  z.object({ kind: z.literal("temporary"), ref: identifierSchema }).strict(),
]);

const legacyOperationKindSchema = z.enum([
  "create_task", "update_title", "update_notes", "set_status",
  "set_importance", "set_due", "clear_due", "set_duration",
  "clear_duration", "set_area", "set_dependencies", "set_parent",
  "set_parent_work_mode", "link_obsidian", "unlink_obsidian",
  "complete", "withdraw",
]);

const legacyOperationSchema = z.object({
  operation_id: identifierSchema,
  operation: legacyOperationKindSchema,
  target: legacyTargetSchema,
  expected_before: z.unknown(),
  expected_after: z.unknown(),
  temporary_ref: identifierSchema.optional(),
}).strict();

export const legacyRowSchema = z.object({
  proposal_id: identifierSchema,
  operation_id: identifierSchema,
  new_task_uuid: z.uuid().nullable(),
  target_gid: gidSchema.nullable(),
  target_temporary_ref: identifierSchema.nullable(),
  started_at: isoDateTimeSchema,
  stage: z.enum([
    "prepared", "started", "write_started", "task_created",
    "attributes_applied", "relations_applied", "read_back",
    "metadata_verified", "ranking_recalculated", "legacy_unresolved",
  ]),
  final_result: z.enum(["applied", "not_applied", "unknown", "failed"]).nullable(),
  recovery_reason: z.enum(["recovery_context_missing", "journal_target_mismatch"]).nullable(),
  group_id: identifierSchema.nullable(),
  group_order: z.number().int().nonnegative().nullable(),
  operation_order: z.number().int().nonnegative().nullable(),
  atomic: z.union([z.literal(0), z.literal(1)]).nullable(),
  project_gid: gidSchema.nullable(),
  workspace_gid: gidSchema.nullable(),
  section_gids_json: z.string().nullable(),
  device_id: identifierSchema.nullable(),
  created_via: identifierSchema.nullable(),
  activity_date: z.iso.date().nullable(),
  temporary_ref_to_gid_json: z.string().nullable(),
  baseline_source_json: z.string().nullable(),
  operation_kind: legacyOperationKindSchema.nullable(),
  operation_json: z.string().nullable(),
  expected_before_json: z.string().nullable(),
  expected_after_json: z.string().nullable(),
  create_uuid: z.uuid().nullable(),
  temporary_ref: identifierSchema.nullable(),
}).strict();

export type LegacyRow = z.infer<typeof legacyRowSchema>;

const legacyV3RowSchema = legacyRowSchema.pick({
  proposal_id: true,
  operation_id: true,
  new_task_uuid: true,
  target_gid: true,
  started_at: true,
  stage: true,
  final_result: true,
});
const legacyV4WithoutReasonSchema = legacyRowSchema.omit({ recovery_reason: true });

export type OriginalLegacyRow = {
  readonly normalized: LegacyRow;
  readonly source_stage: string;
  readonly source_final_result: LegacyRow["final_result"];
  readonly source_recovery_reason: LegacyRow["recovery_reason"];
};

/** 移行前schemaの旧行を元の値を保ったまま現行の検証形式へ投影します。 */
export function parseOriginalLegacyRow(value: unknown, version: number): OriginalLegacyRow {
  if (version === 3) {
    const original = legacyV3RowSchema.parse(value);
    const normalized = legacyRowSchema.parse({
      ...original,
      target_temporary_ref: null,
      stage: original.final_result == null ? "legacy_unresolved" : original.stage,
      recovery_reason: original.final_result == null ? "recovery_context_missing" : null,
      group_id: null,
      group_order: null,
      operation_order: null,
      atomic: null,
      project_gid: null,
      workspace_gid: null,
      section_gids_json: null,
      device_id: null,
      created_via: null,
      activity_date: null,
      temporary_ref_to_gid_json: null,
      baseline_source_json: null,
      operation_kind: null,
      operation_json: null,
      expected_before_json: null,
      expected_after_json: null,
      create_uuid: null,
      temporary_ref: null,
    });
    return {
      normalized,
      source_stage: original.stage,
      source_final_result: original.final_result,
      source_recovery_reason: null,
    };
  }
  if (version === 4) {
    const withReason = legacyRowSchema.safeParse(value);
    if (withReason.success) {
      return {
        normalized: withReason.data,
        source_stage: withReason.data.stage,
        source_final_result: withReason.data.final_result,
        source_recovery_reason: withReason.data.recovery_reason,
      };
    }
    const original = legacyV4WithoutReasonSchema.parse(value);
    const normalized = legacyRowSchema.parse({
      ...original,
      recovery_reason: original.stage === "legacy_unresolved" ? "recovery_context_missing" : null,
    });
    return {
      normalized,
      source_stage: original.stage,
      source_final_result: original.final_result,
      source_recovery_reason: null,
    };
  }
  if (version !== 5 && version !== 6 && version !== 7 && version !== 8) {
    throw new Error("旧適用履歴の出所schema versionが未対応です。");
  }
  const original = legacyRowSchema.parse(value);
  return {
    normalized: original,
    source_stage: original.stage,
    source_final_result: original.final_result,
    source_recovery_reason: original.recovery_reason,
  };
}

export const historyRowSchema = z.object({
  proposal_id: identifierSchema,
  operation_id: identifierSchema,
  format_version: z.literal(1),
  source_schema_version: z.number().int().min(3).max(8),
  source_stage: z.string(),
  source_final_result: z.enum(["applied", "not_applied", "unknown", "failed"]).nullable(),
  source_recovery_reason: z.string().nullable(),
  confirmation_state: z.enum(["not_required", "required", "confirmed", "synchronized"]),
  confirmed_result: z.enum(["applied", "not_applied", "manually_adjusted"]).nullable(),
  snapshot_json: z.string(),
  snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

function parseLegacyJson(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new Error("旧適用ジャーナルのJSONを解析できません。", { cause: error });
  }
}

function requirePlanField<T>(value: T | null): T {
  if (value == null) {
    throw new Error("旧適用ジャーナルの復旧計画が不足しています。");
  }
  return value;
}

function assertLegacyPlan(row: LegacyRow): void {
  if (row.operation_kind == null) {
    const planFields = [
      row.group_id, row.group_order, row.operation_order, row.atomic,
      row.project_gid, row.workspace_gid, row.section_gids_json,
      row.device_id, row.created_via, row.activity_date,
      row.temporary_ref_to_gid_json, row.baseline_source_json,
      row.operation_json, row.expected_before_json, row.expected_after_json,
      row.create_uuid, row.temporary_ref,
    ];
    if (planFields.some((field) => field != null)) {
      throw new Error("旧適用ジャーナルの復旧計画が不完全です。");
    }
    return;
  }
  requirePlanField(row.group_id);
  requirePlanField(row.group_order);
  requirePlanField(row.operation_order);
  requirePlanField(row.atomic);
  requirePlanField(row.project_gid);
  requirePlanField(row.workspace_gid);
  requirePlanField(row.device_id);
  requirePlanField(row.created_via);
  requirePlanField(row.activity_date);
  const sections = z.object({
    not_started: gidSchema,
    in_progress: gidSchema,
    completed: gidSchema,
    withdrawn: gidSchema,
  }).strict().parse(parseLegacyJson(requirePlanField(row.section_gids_json)));
  if (new Set(Object.values(sections)).size !== 4) {
    throw new Error("旧適用ジャーナルの状態セクションが重複しています。");
  }
  const references = z.array(z.object({
    temporary_ref: identifierSchema,
    task_gid: gidSchema,
  }).strict()).max(256).parse(parseLegacyJson(requirePlanField(row.temporary_ref_to_gid_json)));
  if (
    new Set(references.map((item) => item.temporary_ref)).size !== references.length
    || new Set(references.map((item) => item.task_gid)).size !== references.length
  ) {
    throw new Error("旧適用ジャーナルの一時参照が重複しています。");
  }
  const baseline = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("not_used") }).strict(),
    z.object({
      kind: z.literal("stored"),
      external_gid: z.string(),
      data: customExternalDataSchema,
    }).strict(),
    z.object({
      kind: z.literal("created_task"),
      create_operation_id: identifierSchema,
      temporary_ref: identifierSchema,
    }).strict(),
  ]).parse(parseLegacyJson(requirePlanField(row.baseline_source_json)));
  if (
    (baseline.kind === "stored"
      && baseline.external_gid !== `TaskHub:v1:task:${baseline.data.id}`)
    || (baseline.kind === "created_task"
      && baseline.temporary_ref !== row.target_temporary_ref)
  ) {
    throw new Error("旧適用ジャーナルの外部データ基準が対象と一致しません。");
  }
  const operation = legacyOperationSchema.parse(parseLegacyJson(requirePlanField(row.operation_json)));
  if (
    operation.operation !== row.operation_kind
    || operation.operation_id !== row.operation_id
    || canonicalizeJson(operation.expected_before)
      !== canonicalizeJson(parseLegacyJson(requirePlanField(row.expected_before_json)))
    || canonicalizeJson(operation.expected_after)
      !== canonicalizeJson(parseLegacyJson(requirePlanField(row.expected_after_json)))
  ) {
    throw new Error("旧適用ジャーナルの操作と復旧計画が一致しません。");
  }
  const usesExternalData = operation.operation !== "create_task"
    && operation.operation !== "complete"
    && operation.operation !== "withdraw";
  if (
    (operation.operation === "create_task") !== (operation.target.kind === "new_task")
    || usesExternalData === (baseline.kind === "not_used")
    || (operation.operation !== "create_task" && operation.temporary_ref != null)
  ) {
    throw new Error("旧適用ジャーナルの操作種別と復旧計画が一致しません。");
  }
  if (operation.target.kind === "new_task") {
    if (
      row.new_task_uuid !== operation.target.uuid
      || row.create_uuid !== operation.target.uuid
      || row.temporary_ref !== operation.temporary_ref
      || row.target_gid != null
      || row.target_temporary_ref != null
    ) {
      throw new Error("旧作成操作の対象が復旧計画と一致しません。");
    }
  } else if (
    row.new_task_uuid != null
    || row.create_uuid != null
    || row.temporary_ref != null
    || (operation.target.kind === "existing"
      ? row.target_gid !== operation.target.gid || row.target_temporary_ref != null
      : row.target_temporary_ref !== operation.target.ref || row.target_gid != null)
  ) {
    throw new Error("旧変更操作の対象が復旧計画と一致しません。");
  }
}

/** schema移行後の旧行を読取専用の表示stepへ変換します。 */
export function parseLegacyStep(value: unknown): Omit<ProposalApplicationHistoryStep, "confirmation_state"> {
  const row = legacyRowSchema.parse(value);
  if (
    Number(row.new_task_uuid != null)
      + Number(row.target_gid != null)
      + Number(row.target_temporary_ref != null) !== 1
  ) {
    throw new Error("旧適用ジャーナルの対象が不正です。");
  }
  assertLegacyPlan(row);
  const state = row.final_result === "applied"
    ? "succeeded"
    : row.final_result === "failed" || row.final_result === "not_applied"
      ? "failed"
      : "confirmation_required";
  let target: ProposalApplicationHistoryStep["target"];
  if (row.new_task_uuid != null) {
    target = { kind: "new_task", uuid: row.new_task_uuid };
  } else if (row.target_gid != null) {
    target = { kind: "task", gid: row.target_gid };
  } else {
    target = { kind: "temporary", ref: requirePlanField(row.target_temporary_ref) };
  }
  return {
    step_id: `legacy:${row.operation_id}`,
    operation_id: row.operation_id,
    ...(row.operation_order == null ? {} : { operation_order: row.operation_order }),
    stage: row.stage,
    state,
    started_at: row.started_at,
    target,
    final_result: row.final_result,
    ...(row.operation_kind == null ? {} : { operation_kind: row.operation_kind }),
  };
}

/** 履歴の保存済みsnapshotと出所情報を照合して表示用stepを返します。 */
export function parseLegacyHistoryStep(value: unknown): ProposalApplicationHistoryStep {
  const history = historyRowSchema.parse(value);
  const hash = createHash("sha256").update(history.snapshot_json, "utf8").digest("hex");
  if (hash !== history.snapshot_sha256) {
    throw new Error("旧適用履歴のhashが保存済みsnapshotと一致しません。");
  }
  const snapshot: unknown = JSON.parse(history.snapshot_json);
  const original = parseOriginalLegacyRow(snapshot, history.source_schema_version);
  if (
    original.normalized.proposal_id !== history.proposal_id
    || original.normalized.operation_id !== history.operation_id
    || original.source_stage !== history.source_stage
    || original.source_final_result !== history.source_final_result
    || original.source_recovery_reason !== history.source_recovery_reason
  ) {
    throw new Error("旧適用履歴の出所情報がsnapshotと一致しません。");
  }
  const needsConfirmation = original.source_final_result == null
    || original.source_final_result === "unknown";
  if (
    (history.confirmation_state === "not_required" && needsConfirmation)
    || (history.confirmation_state !== "not_required" && !needsConfirmation)
    || (history.confirmation_state === "confirmed" || history.confirmation_state === "synchronized")
      !== (history.confirmed_result != null)
  ) {
    throw new Error("旧適用履歴の確認状態が元の結果と一致しません。");
  }
  const step = parseLegacyStep(original.normalized);
  if (history.confirmation_state === "confirmed") {
    const confirmedResult = history.confirmed_result;
    if (confirmedResult == null) {
      throw new Error("旧適用履歴の確認結果がありません。");
    }
    return {
      ...step,
      state: "synchronization_required",
      confirmation_state: history.confirmation_state,
      confirmed_result: confirmedResult,
    };
  }
  if (history.confirmation_state === "synchronized") {
    const confirmedResult = history.confirmed_result;
    if (confirmedResult == null) {
      throw new Error("旧適用履歴の確認結果がありません。");
    }
    return {
      ...step,
      state: confirmedResult === "applied" ? "succeeded" : "failed",
      confirmation_state: history.confirmation_state,
      confirmed_result: confirmedResult,
    };
  }
  return { ...step, confirmation_state: history.confirmation_state };
}
