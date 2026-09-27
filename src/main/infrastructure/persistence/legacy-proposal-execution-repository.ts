import { z } from "zod";
import type { ErrorReporter } from "../../application/common/errors/error-reporter";
import type {
  LegacyProposalExecution,
  LegacyProposalExecutionRead,
  LegacyProposalExecutionRepository,
  LegacyProposalExecutionStep,
} from "../../application/common/ports/proposal-execution-repository";
import {
  canonicalizeTaskWriteJson,
  customExternalDataSchema,
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
} from "../../domain/task-write-values";
import type { PersistenceRuntime } from "./persistence-runtime";

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

const legacyRowSchema = z.object({
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

type LegacyRow = z.infer<typeof legacyRowSchema>;
type ProposalIdRow = { readonly proposal_id: string };

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
    || canonicalizeTaskWriteJson(operation.expected_before)
      !== canonicalizeTaskWriteJson(parseLegacyJson(requirePlanField(row.expected_before_json)))
    || canonicalizeTaskWriteJson(operation.expected_after)
      !== canonicalizeTaskWriteJson(parseLegacyJson(requirePlanField(row.expected_after_json)))
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

function parseLegacyStep(value: unknown): LegacyProposalExecutionStep {
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
  let target: LegacyProposalExecutionStep["target"];
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
    stage: row.stage,
    state,
    started_at: row.started_at,
    target,
    final_result: row.final_result,
    ...(row.operation_kind == null ? {} : { operation_kind: row.operation_kind }),
  };
}

/** 旧application_journalをSELECTだけで復旧表示へ変換します。 */
export class SqliteLegacyProposalExecutionRepository implements LegacyProposalExecutionRepository {
  public constructor(
    private readonly runtime: PersistenceRuntime,
    private readonly reporter: ErrorReporter,
  ) {}

  /** 指定proposalの旧行を一つの読取専用executionへ変換します。 */
  public getByProposal(proposalId: string): LegacyProposalExecutionRead | undefined {
    const validatedId = identifierSchema.parse(proposalId);
    const rows = this.runtime.connection.prepare<[string], unknown>(
      `SELECT * FROM application_journal
        WHERE proposal_id = ?
        ORDER BY operation_order IS NULL, operation_order, started_at, operation_id`,
    ).all(validatedId);
    if (rows.length === 0) {
      return undefined;
    }
    const steps: LegacyProposalExecutionStep[] = [];
    for (const value of rows) {
      try {
        const row = legacyRowSchema.parse(value);
        if (row.proposal_id !== validatedId) {
          throw new Error("旧適用ジャーナルのproposal IDが一致しません。");
        }
        steps.push(parseLegacyStep(row));
      } catch (error) {
        const operationId = z.object({ operation_id: identifierSchema })
          .safeParse(value);
        const errorId = this.reporter.reportErrorOnce(error, {
          source: "service",
          diagnosticCode: "proposal.application",
          context: "diagnostic_storage",
          level: "error",
          ...(operationId.success ? { operationId: operationId.data.operation_id } : {}),
        });
        return {
          kind: "rejected",
          proposal_id: validatedId,
          ...(operationId.success ? { operation_id: operationId.data.operation_id } : {}),
          error_id: errorId,
        };
      }
    }
    const state: LegacyProposalExecution["state"] = steps.some(
      (step) => step.state === "confirmation_required",
    ) ? "confirmation_required" : steps.some(
      (step) => step.state === "failed",
    ) ? "failed" : "succeeded";
    return {
      kind: "execution",
      execution: {
        format: "application_journal",
        execution_id: `legacy:${validatedId}`,
        proposal_id: validatedId,
        state,
        steps,
      },
    };
  }

  /** 未確定の旧proposalを行の書換えなしで読み出します。 */
  public getIncomplete(): readonly LegacyProposalExecutionRead[] {
    const proposals = this.runtime.connection.prepare<[], ProposalIdRow>(
      `SELECT DISTINCT proposal_id FROM application_journal
        ORDER BY proposal_id`,
    ).all();
    const results = proposals.map((row) => {
      const result = this.getByProposal(row.proposal_id);
      if (result == null) {
        throw new Error("未確定の旧proposalを読み出せません。");
      }
      return result;
    });
    return results.filter((result) => result.kind === "rejected"
      || result.execution.state === "confirmation_required");
  }
}
