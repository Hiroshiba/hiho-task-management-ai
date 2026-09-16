import { z } from "zod";
import { gidSchema, identifierSchema } from "../../shared/domain";
import {
  applicationJournalOperationSchema,
  applicationJournalPlanSchema,
  applicationJournalRecoveryReasonSchema,
  applicationJournalResultSchema,
  applicationJournalLegacyCompletedSchema,
  applicationJournalBaselineSourceSchema,
  applicationJournalSchema,
  applicationJournalStageSchema,
  applicationJournalWithPlanSchema,
  type ApplicationJournal,
  type ApplicationJournalPlan,
  type ApplicationJournalResult,
  type ApplicationJournalStage,
} from "../../shared/storage";
import { assertChanged, parseStorageJson, serializeStorageJson } from "./json";
import type { SqliteDatabase } from "./types";

interface ApplicationJournalRow {
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly new_task_uuid: string | null;
  readonly target_gid: string | null;
  readonly target_temporary_ref: string | null;
  readonly started_at: string;
  readonly stage: string;
  readonly final_result: string | null;
  readonly recovery_reason: string | null;
  readonly group_id: string | null;
  readonly group_order: number | null;
  readonly operation_order: number | null;
  readonly atomic: number | null;
  readonly project_gid: string | null;
  readonly workspace_gid: string | null;
  readonly section_gids_json: string | null;
  readonly device_id: string | null;
  readonly created_via: string | null;
  readonly activity_date: string | null;
  readonly temporary_ref_to_gid_json: string | null;
  readonly baseline_source_json: string | null;
  readonly operation_kind: string | null;
  readonly operation_json: string | null;
  readonly expected_before_json: string | null;
  readonly expected_after_json: string | null;
  readonly create_uuid: string | null;
  readonly temporary_ref: string | null;
}

const applicationJournalStageOrder: Record<ApplicationJournalStage, number> = {
  prepared: 0,
  started: 1,
  write_started: 2,
  task_created: 3,
  attributes_applied: 4,
  relations_applied: 5,
  read_back: 6,
  metadata_verified: 7,
  ranking_recalculated: 8,
  legacy_unresolved: -1,
};
type ApplicationJournalWithPlan = z.infer<typeof applicationJournalWithPlanSchema>;
type ApplicationJournalRecoveryReason = z.infer<
  typeof applicationJournalRecoveryReasonSchema
>;

class CorruptApplicationJournalPlanError extends Error {
  public constructor(cause: unknown) {
    super("適用ジャーナルの復旧計画が破損しています。", { cause });
    this.name = "CorruptApplicationJournalPlanError";
  }
}

class MissingApplicationJournalPlanError extends Error {
  public constructor() {
    super("適用ジャーナルの復旧計画がありません。");
    this.name = "MissingApplicationJournalPlanError";
  }
}

class ApplicationJournalTargetMismatchError extends Error {
  public constructor() {
    super("適用ジャーナルと復旧計画の対象が一致しません。");
    this.name = "ApplicationJournalTargetMismatchError";
  }
}

function isUnresolvedCandidate(row: ApplicationJournalRow): boolean {
  return row.final_result == null
    || (
      row.final_result === "unknown"
      && (
        row.stage === "prepared"
        || row.stage === "write_started"
        || row.stage === "legacy_unresolved"
      )
    );
}

function rowToApplicationJournalPlan(row: ApplicationJournalRow): ApplicationJournalPlan {
  if (
    row.group_id == null
    || row.group_order == null
    || row.operation_order == null
    || row.atomic == null
    || row.project_gid == null
    || row.workspace_gid == null
    || row.section_gids_json == null
    || row.device_id == null
    || row.created_via == null
    || row.activity_date == null
    || row.temporary_ref_to_gid_json == null
    || row.baseline_source_json == null
    || row.operation_kind == null
    || row.operation_json == null
    || row.expected_before_json == null
    || row.expected_after_json == null
  ) {
    throw new Error("適用ジャーナルの復旧計画が不足しています。");
  }

  const operation = parseStorageJson(
    row.operation_json,
    applicationJournalOperationSchema,
  );
  if (operation.operation !== row.operation_kind) {
    throw new Error("適用ジャーナルの操作種別が一致しません。");
  }
  if (operation.operation_id !== row.operation_id) {
    throw new Error("適用ジャーナルの操作IDが一致しません。");
  }
  if (row.atomic !== 0 && row.atomic !== 1) {
    throw new Error("適用ジャーナルのatomic属性が不正です。");
  }
  if (operation.operation === "create_task") {
    if (
      row.create_uuid == null
      || row.temporary_ref == null
      || row.new_task_uuid !== row.create_uuid
      || operation.target.kind !== "new_task"
      || operation.target.uuid !== row.create_uuid
      || operation.temporary_ref !== row.temporary_ref
    ) {
      throw new Error("create_taskの復旧計画と保存対象が一致しません。");
    }
  } else if (row.create_uuid != null || row.temporary_ref != null) {
    throw new Error("既存タスク操作へ作成情報を保存できません。");
  }
  const expectedBefore = parseStorageJson(row.expected_before_json, z.unknown());
  const expectedAfter = parseStorageJson(row.expected_after_json, z.unknown());
  if (
    serializeStorageJson(operation.expected_before) !== serializeStorageJson(expectedBefore)
    || serializeStorageJson(operation.expected_after) !== serializeStorageJson(expectedAfter)
  ) {
    throw new Error("適用ジャーナルの期待値が一致しません。");
  }
  const plan = {
    group_id: row.group_id,
    group_order: row.group_order,
    operation_order: row.operation_order,
    atomic: row.atomic === 1,
    project_gid: row.project_gid,
    workspace_gid: row.workspace_gid,
    section_gids: parseStorageJson(row.section_gids_json, z.object({
      not_started: z.string(),
      in_progress: z.string(),
      completed: z.string(),
      withdrawn: z.string(),
    }).strict()),
    device_id: row.device_id,
    created_via: row.created_via,
    activity_date: row.activity_date,
    temporary_ref_to_gid: parseStorageJson(
      row.temporary_ref_to_gid_json,
      z.array(z.object({ temporary_ref: z.string(), task_gid: z.string() }).strict()),
    ),
    baseline_source: parseStorageJson(
      row.baseline_source_json,
      applicationJournalBaselineSourceSchema,
    ),
    operation,
    ...(row.create_uuid == null ? {} : { create_uuid: row.create_uuid }),
  };
  return applicationJournalPlanSchema.parse(plan);
}

function rowToApplicationJournal(row: ApplicationJournalRow): ApplicationJournal {
  if (
    row.new_task_uuid == null
    && row.target_gid == null
    && row.target_temporary_ref == null
  ) {
    throw new Error("適用ジャーナルの対象がありません。");
  }
  if (
    Number(row.new_task_uuid != null)
    + Number(row.target_gid != null)
    + Number(row.target_temporary_ref != null)
    !== 1
  ) {
    throw new Error("適用ジャーナルの対象が複数あります。");
  }

  let target: ApplicationJournal["target"];
  if (row.new_task_uuid == null) {
    if (row.target_gid != null) {
      target = { kind: "task", gid: row.target_gid };
    } else if (row.target_temporary_ref != null) {
      target = { kind: "temporary", ref: row.target_temporary_ref };
    } else {
      throw new Error("適用ジャーナルの対象GIDがありません。");
    }
  } else {
    target = { kind: "new_task", uuid: row.new_task_uuid };
  }
  if (
    row.operation_kind == null
    && row.final_result != null
    && row.stage !== "legacy_unresolved"
  ) {
    return applicationJournalLegacyCompletedSchema.parse({
      proposal_id: row.proposal_id,
      operation_id: row.operation_id,
      target,
      started_at: row.started_at,
      stage: row.stage,
      final_result: row.final_result,
    });
  }

  let plan: ApplicationJournalPlan | undefined;
  if (
    row.operation_kind == null
    && isUnresolvedCandidate(row)
    && row.stage !== "legacy_unresolved"
  ) {
    const planError = new MissingApplicationJournalPlanError();
    return applicationJournalSchema.parse({
      proposal_id: row.proposal_id,
      operation_id: row.operation_id,
      target,
      started_at: row.started_at,
      stage: "legacy_unresolved",
      recovery_reason: "recovery_context_missing",
      recovery_cause: planError,
    });
  }
  if (row.operation_kind != null) {
    try {
      plan = rowToApplicationJournalPlan(row);
      const planTarget = plan.operation.target;
      let targetsMatch = false;
      if (planTarget.kind === "new_task") {
        targetsMatch = target.kind === "new_task" && planTarget.uuid === target.uuid;
      } else if (planTarget.kind === "existing") {
        targetsMatch = target.kind === "task" && planTarget.gid === target.gid;
      } else {
        targetsMatch = target.kind === "temporary" && planTarget.ref === target.ref;
      }
      if (!targetsMatch) {
        throw new ApplicationJournalTargetMismatchError();
      }
    } catch (error: unknown) {
      const planError = new CorruptApplicationJournalPlanError(error);
      if (row.final_result == null) {
        const recoveryReason = error instanceof ApplicationJournalTargetMismatchError
          ? "journal_target_mismatch"
          : "recovery_context_missing";
        const unresolvedEntry = {
          proposal_id: row.proposal_id,
          operation_id: row.operation_id,
          target,
          started_at: row.started_at,
          stage: "legacy_unresolved",
          recovery_reason: recoveryReason,
          recovery_cause: planError,
        };
        const validatedUnresolved = applicationJournalSchema.safeParse(unresolvedEntry);
        if (!validatedUnresolved.success) {
          throw new AggregateError(
            [planError, validatedUnresolved.error],
            "破損した適用ジャーナルを安全な未確定状態に変換できませんでした。",
            { cause: planError },
          );
        }
        return validatedUnresolved.data;
      }
      throw planError;
    }
  }
  const entry = {
    proposal_id: row.proposal_id,
    operation_id: row.operation_id,
    target,
    started_at: row.started_at,
    stage: row.stage,
    ...(row.final_result == null ? {} : { final_result: row.final_result }),
    ...(row.recovery_reason == null ? {} : { recovery_reason: row.recovery_reason }),
    ...(plan == null ? {} : { plan }),
  };
  return applicationJournalSchema.parse(entry);
}

function validatePlanEntry(entry: ApplicationJournal): ApplicationJournalWithPlan {
  const validatedEntry = applicationJournalWithPlanSchema.parse(entry);
  if (validatedEntry.stage !== "prepared") {
    throw new Error("復旧計画の新規保存段階はpreparedでなければなりません。");
  }
  if (validatedEntry.final_result != null) {
    throw new Error("preparedの適用ジャーナルに最終結果を指定できません。");
  }
  if (validatedEntry.operation_id !== validatedEntry.plan.operation.operation_id) {
    throw new Error("適用ジャーナルと復旧計画の操作IDが一致しません。");
  }
  const planTarget = validatedEntry.plan.operation.target;
  let targetsMatch = false;
  if (planTarget.kind === "new_task") {
    targetsMatch = validatedEntry.target.kind === "new_task"
      && planTarget.uuid === validatedEntry.target.uuid;
  } else if (planTarget.kind === "existing") {
    targetsMatch = validatedEntry.target.kind === "task"
      && planTarget.gid === validatedEntry.target.gid;
  } else {
    targetsMatch = validatedEntry.target.kind === "temporary"
      && planTarget.ref === validatedEntry.target.ref;
  }
  if (!targetsMatch) {
    throw new Error("適用ジャーナルと復旧計画の対象が一致しません。");
  }
  return validatedEntry;
}

/** 適用ジャーナルのSQLite操作を提供します。 */
export class ApplicationJournalStore {
  private readonly corruptPlanRecoveryCauses = new Map<
    string,
    Map<string, CorruptApplicationJournalPlanError>
  >();
  private readonly completeStatement;
  private readonly insertPreparedStatement;
  private readonly markProposalUnresolvedStatement;
  private readonly recordCreatedTaskStatement;
  private readonly selectByProposalStatement;
  private readonly selectIncompleteStatement;
  private readonly selectOneStatement;
  private readonly updateStageStatement;

  public constructor(private readonly database: SqliteDatabase) {
    this.insertPreparedStatement = database.prepare<
      [
        string,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string | null,
        string | null,
        number | null,
        number | null,
        number | null,
        string | null,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
      ],
      unknown
    >(
      `INSERT INTO application_journal (
        proposal_id,
        operation_id,
        new_task_uuid,
        target_gid,
        target_temporary_ref,
        started_at,
        stage,
        final_result,
        group_id,
        group_order,
        operation_order,
        atomic,
        project_gid,
        workspace_gid,
        section_gids_json,
        device_id,
        created_via,
        activity_date,
        temporary_ref_to_gid_json,
        baseline_source_json,
        operation_kind,
        operation_json,
        expected_before_json,
        expected_after_json,
        create_uuid,
        temporary_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.markProposalUnresolvedStatement = database.prepare<
      [string, string, string],
      unknown
    >(
      `UPDATE application_journal SET
        stage = 'legacy_unresolved',
        recovery_reason = ?,
        group_id = NULL,
        group_order = NULL,
        operation_order = NULL,
        atomic = NULL,
        project_gid = NULL,
        workspace_gid = NULL,
        section_gids_json = NULL,
        device_id = NULL,
        created_via = NULL,
        activity_date = NULL,
        temporary_ref_to_gid_json = NULL,
        baseline_source_json = NULL,
        operation_kind = NULL,
        operation_json = NULL,
        expected_before_json = NULL,
        expected_after_json = NULL,
        create_uuid = NULL,
        temporary_ref = NULL
        WHERE proposal_id = ? AND operation_id = ?
          AND final_result IS NULL
          AND stage <> 'legacy_unresolved'`,
    );
    this.updateStageStatement = database.prepare<[string, string, string], unknown>(
      "UPDATE application_journal SET stage = ? WHERE proposal_id = ? AND operation_id = ? AND final_result IS NULL AND stage <> 'legacy_unresolved'",
    );
    this.completeStatement = database.prepare<[string, string, string], unknown>(
      "UPDATE application_journal SET final_result = ? WHERE proposal_id = ? AND operation_id = ? AND final_result IS NULL",
    );
    this.recordCreatedTaskStatement = database.prepare<
      [string, string, string],
      unknown
    >(
      "UPDATE application_journal SET temporary_ref_to_gid_json = ?, stage = CASE WHEN stage = 'write_started' THEN 'task_created' ELSE stage END WHERE proposal_id = ? AND operation_id = ? AND final_result IS NULL",
    );
    this.selectOneStatement = database.prepare<[string, string], ApplicationJournalRow>(
      `SELECT
        proposal_id,
        operation_id,
        new_task_uuid,
        target_gid,
        target_temporary_ref,
        started_at,
        stage,
        final_result,
        recovery_reason,
        group_id,
        group_order,
        operation_order,
        atomic,
        project_gid,
        workspace_gid,
        section_gids_json,
        device_id,
        created_via,
        activity_date,
        temporary_ref_to_gid_json,
        baseline_source_json,
        operation_kind,
        operation_json,
        expected_before_json,
        expected_after_json,
        create_uuid,
        temporary_ref
      FROM application_journal
      WHERE proposal_id = ? AND operation_id = ?`,
    );
    this.selectByProposalStatement = database.prepare<[string], ApplicationJournalRow>(
      `SELECT
        proposal_id,
        operation_id,
        new_task_uuid,
        target_gid,
        target_temporary_ref,
        started_at,
        stage,
        final_result,
        recovery_reason,
        group_id,
        group_order,
        operation_order,
        atomic,
        project_gid,
        workspace_gid,
        section_gids_json,
        device_id,
        created_via,
        activity_date,
        temporary_ref_to_gid_json,
        baseline_source_json,
        operation_kind,
        operation_json,
        expected_before_json,
        expected_after_json,
        create_uuid,
        temporary_ref
      FROM application_journal
      WHERE proposal_id = ?
      ORDER BY operation_order IS NULL, operation_order, started_at, operation_id`,
    );
    this.selectIncompleteStatement = database.prepare<[], ApplicationJournalRow>(
      `SELECT
        proposal_id,
        operation_id,
        new_task_uuid,
        target_gid,
        target_temporary_ref,
        started_at,
        stage,
        final_result,
        recovery_reason,
        group_id,
        group_order,
        operation_order,
        atomic,
        project_gid,
        workspace_gid,
        section_gids_json,
        device_id,
        created_via,
        activity_date,
        temporary_ref_to_gid_json,
        baseline_source_json,
        operation_kind,
        operation_json,
        expected_before_json,
        expected_after_json,
        create_uuid,
        temporary_ref
      FROM application_journal
      WHERE final_result IS NULL
        OR final_result = 'unknown'
      ORDER BY proposal_id, operation_order IS NULL, operation_order, started_at, operation_id`,
    );
  }

  private persistUnresolvedProposal(
    proposalId: string,
    reasons: ReadonlyMap<string, ApplicationJournalRecoveryReason>,
  ): void {
    const persist = this.database.transaction(() => {
      const incompleteRows = this.selectByProposalStatement
        .all(proposalId)
        .filter((row) => row.final_result == null && row.stage !== "legacy_unresolved");
      for (const row of incompleteRows) {
        const reason = reasons.get(row.operation_id) ?? "recovery_context_missing";
        const result = this.markProposalUnresolvedStatement.run(
          reason,
          proposalId,
          row.operation_id,
        );
        assertChanged(result.changes, "適用ジャーナルの安全な未確定化");
      }
    });
    persist();
  }

  private readRows(rows: readonly ApplicationJournalRow[]): readonly ApplicationJournal[] {
    const rowsByProposal = new Map<string, ApplicationJournalRow[]>();
    for (const row of rows) {
      const proposalRows = rowsByProposal.get(row.proposal_id) ?? [];
      proposalRows.push(row);
      rowsByProposal.set(row.proposal_id, proposalRows);
    }

    const journals: ApplicationJournal[] = [];
    for (const [proposalId, proposalRows] of rowsByProposal) {
      const incompleteRows = proposalRows.filter(isUnresolvedCandidate);
      const parsedIncomplete = incompleteRows.map(rowToApplicationJournal);
      const unresolvedReasons = new Map<string, ApplicationJournalRecoveryReason>();
      for (const journal of parsedIncomplete) {
        if (journal.stage !== "legacy_unresolved") {
          continue;
        }
        unresolvedReasons.set(
          journal.operation_id,
          journal.recovery_reason === "journal_target_mismatch"
            ? journal.recovery_reason
            : "recovery_context_missing",
        );
        if (journal.recovery_cause instanceof CorruptApplicationJournalPlanError) {
          const causes = this.corruptPlanRecoveryCauses.get(journal.proposal_id)
            ?? new Map<string, CorruptApplicationJournalPlanError>();
          causes.set(journal.operation_id, journal.recovery_cause);
          this.corruptPlanRecoveryCauses.set(journal.proposal_id, causes);
        }
      }
      if (unresolvedReasons.size > 0) {
        for (const journal of parsedIncomplete) {
          if (
            journal.final_result == null
            && !unresolvedReasons.has(journal.operation_id)
          ) {
            unresolvedReasons.set(journal.operation_id, "recovery_context_missing");
          }
        }
        this.persistUnresolvedProposal(proposalId, unresolvedReasons);
      }

      const refreshedRows = unresolvedReasons.size === 0
        ? new Map<string, ApplicationJournalRow>()
        : new Map(
            this.selectByProposalStatement
              .all(proposalId)
              .map((row) => [row.operation_id, row]),
          );
      for (const row of proposalRows) {
        const readableRow = unresolvedReasons.has(row.operation_id)
          ? refreshedRows.get(row.operation_id) ?? row
          : row;
        const journal = rowToApplicationJournal(readableRow);
        const recoveryCause = this.corruptPlanRecoveryCauses
          .get(row.proposal_id)
          ?.get(row.operation_id);
        if (journal.stage === "legacy_unresolved" && recoveryCause != null) {
          journals.push(applicationJournalSchema.parse({
            ...journal,
            recovery_cause: recoveryCause,
          }));
        } else {
          journals.push(journal);
        }
      }
    }
    return journals;
  }

  /** 選択済み操作の復旧計画を一つのトランザクションで保存します。 */
  public prepare(entries: readonly ApplicationJournal[]): void {
    if (entries.length === 0) {
      throw new Error("復旧計画の操作がありません。");
    }
    const validatedEntries = entries.map(validatePlanEntry);
    const proposalIds = new Set<string>();
    const operationIds = new Set<string>();
    const prepare = this.database.transaction(() => {
      for (const entry of validatedEntries) {
        if (proposalIds.size > 0 && !proposalIds.has(entry.proposal_id)) {
          throw new Error("一つの復旧計画へ複数のproposal_idを指定できません。");
        }
        if (operationIds.has(entry.operation_id)) {
          throw new Error("復旧計画の操作IDが重複しています。");
        }
        proposalIds.add(entry.proposal_id);
        operationIds.add(entry.operation_id);
        const plan = entry.plan;
        let targetValues: {
          readonly newTaskUuid: string | null;
          readonly targetGid: string | null;
          readonly targetTemporaryRef: string | null;
        };
        if (entry.target.kind === "new_task") {
          targetValues = {
            newTaskUuid: entry.target.uuid,
            targetGid: null,
            targetTemporaryRef: null,
          };
        } else if (entry.target.kind === "task") {
          targetValues = {
            newTaskUuid: null,
            targetGid: entry.target.gid,
            targetTemporaryRef: null,
          };
        } else {
          targetValues = {
            newTaskUuid: null,
            targetGid: null,
            targetTemporaryRef: entry.target.ref,
          };
        }
        this.insertPreparedStatement.run(
          entry.proposal_id,
          entry.operation_id,
          targetValues.newTaskUuid,
          targetValues.targetGid,
          targetValues.targetTemporaryRef,
          entry.started_at,
          entry.stage,
          null,
          plan.group_id,
          plan.group_order,
          plan.operation_order,
          plan.atomic ? 1 : 0,
          plan.project_gid,
          plan.workspace_gid,
          serializeStorageJson(plan.section_gids),
          plan.device_id,
          plan.created_via,
          plan.activity_date,
          serializeStorageJson(plan.temporary_ref_to_gid),
          serializeStorageJson(plan.baseline_source),
          plan.operation.operation,
          serializeStorageJson(plan.operation),
          serializeStorageJson(plan.operation.expected_before),
          serializeStorageJson(plan.operation.expected_after),
          plan.create_uuid ?? null,
          plan.operation.operation === "create_task" ? plan.operation.temporary_ref : null,
        );
      }
    });
    prepare();
  }

  /** 作成済みタスクのGIDを復旧計画へ保存します。 */
  public recordCreatedTask(
    proposalId: string,
    operationId: string,
    temporaryRef: string,
    taskGid: string,
  ): void {
    const validatedProposalId = identifierSchema.parse(proposalId);
    const validatedOperationId = identifierSchema.parse(operationId);
    const validatedTemporaryRef = identifierSchema.parse(temporaryRef);
    const validatedTaskGid = gidSchema.parse(taskGid);
    const record = this.database.transaction(() => {
      const currentRow = this.selectOneStatement.get(
        validatedProposalId,
        validatedOperationId,
      );
      if (currentRow == null) {
        throw new Error("作成済みタスクを記録する適用ジャーナルが見つかりません。");
      }
      if (currentRow.final_result != null) {
        throw new Error("完了済みの適用ジャーナルへ作成済みタスクを記録できません。");
      }
      const currentStage = applicationJournalStageSchema.parse(currentRow.stage);
      if (
        currentStage !== "write_started"
        && currentStage !== "task_created"
        && currentStage !== "attributes_applied"
        && currentStage !== "relations_applied"
        && currentStage !== "read_back"
        && currentStage !== "metadata_verified"
        && currentStage !== "ranking_recalculated"
      ) {
        throw new Error("作成済みタスクを記録できる適用段階ではありません。");
      }
      if (currentRow.operation_kind !== "create_task") {
        throw new Error("create_task以外へ作成済みタスクを記録できません。");
      }
      if (currentRow.temporary_ref !== validatedTemporaryRef) {
        throw new Error("作成済みタスクのtemporary_refが一致しません。");
      }
      const plan = rowToApplicationJournalPlan(currentRow);
      if (
        plan.operation.operation !== "create_task"
        || plan.operation.temporary_ref !== validatedTemporaryRef
      ) {
        throw new Error("create_taskの復旧計画が一致しません。");
      }
      const existingMapping = plan.temporary_ref_to_gid.find(
        (mapping) => mapping.temporary_ref === validatedTemporaryRef,
      );
      if (existingMapping != null && existingMapping.task_gid !== validatedTaskGid) {
        throw new Error("temporary_refの対応先GIDが変化しました。");
      }
      const mappings = existingMapping == null
        ? [
            ...plan.temporary_ref_to_gid,
            { temporary_ref: validatedTemporaryRef, task_gid: validatedTaskGid },
          ]
        : plan.temporary_ref_to_gid;
      const validatedMappings = applicationJournalPlanSchema.shape.temporary_ref_to_gid.parse(
        mappings,
      );
      const result = this.recordCreatedTaskStatement.run(
        serializeStorageJson(validatedMappings),
        validatedProposalId,
        validatedOperationId,
      );
      assertChanged(result.changes, "作成済みタスクのGID記録");
    });
    record();
  }

  /** 適用ジャーナルの段階をトランザクションで更新します。 */
  public updateStage(
    proposalId: string,
    operationId: string,
    stage: ApplicationJournalStage,
  ): void {
    const validatedProposalId = identifierSchema.parse(proposalId);
    const validatedOperationId = identifierSchema.parse(operationId);
    const validatedStage = applicationJournalStageSchema.parse(stage);
    if (validatedStage === "legacy_unresolved" || validatedStage === "started") {
      throw new Error("適用ジャーナルを旧段階へ更新できません。");
    }
    const update = this.database.transaction(() => {
      const currentRow = this.selectOneStatement.get(
        validatedProposalId,
        validatedOperationId,
      );
      if (currentRow == null) {
        throw new Error("適用ジャーナル段階更新の対象が見つかりません。");
      }
      if (currentRow.final_result != null) {
        throw new Error("完了済みの適用ジャーナルは更新できません。");
      }
      const currentStage = applicationJournalStageSchema.parse(currentRow.stage);
      if (currentStage === "legacy_unresolved") {
        throw new Error("legacy未確定の適用ジャーナルは更新できません。");
      }
      if (applicationJournalStageOrder[validatedStage] < applicationJournalStageOrder[currentStage]) {
        throw new Error("適用ジャーナルの段階を後退させることはできません。");
      }
      const result = this.updateStageStatement.run(
        validatedStage,
        validatedProposalId,
        validatedOperationId,
      );
      assertChanged(result.changes, "適用ジャーナル段階更新");
    });
    update();
  }

  /** 適用ジャーナルの最終結果をトランザクションで更新します。 */
  public complete(
    proposalId: string,
    operationId: string,
    finalResult: ApplicationJournalResult,
  ): void {
    const validatedProposalId = identifierSchema.parse(proposalId);
    const validatedOperationId = identifierSchema.parse(operationId);
    const validatedFinalResult = applicationJournalResultSchema.parse(finalResult);
    const complete = this.database.transaction(() => {
      const result = this.completeStatement.run(
        validatedFinalResult,
        validatedProposalId,
        validatedOperationId,
      );
      assertChanged(result.changes, "適用ジャーナル結果更新");
    });
    complete();
  }

  /** 指定された適用ジャーナルを読み出します。 */
  public get(proposalId: string, operationId: string): ApplicationJournal | undefined {
    const validatedProposalId = identifierSchema.parse(proposalId);
    const validatedOperationId = identifierSchema.parse(operationId);
    return this.getByProposal(validatedProposalId).find(
      (journal) => journal.operation_id === validatedOperationId,
    );
  }

  /** 指定されたproposalの適用ジャーナルを全件読み出します。 */
  public getByProposal(proposalId: string): readonly ApplicationJournal[] {
    const validatedProposalId = identifierSchema.parse(proposalId);
    return this.readRows(this.selectByProposalStatement.all(validatedProposalId));
  }

  /** 未完了の適用ジャーナルを全件読み出します。 */
  public getIncomplete(): readonly ApplicationJournal[] {
    return this.readRows(this.selectIncompleteStatement.all());
  }

  /** 処理済みジャーナルの破損causeをメモリ上から削除します。 */
  public clearRecoveryCause(proposalId: string, operationId: string): void {
    const validatedProposalId = identifierSchema.parse(proposalId);
    const validatedOperationId = identifierSchema.parse(operationId);
    const causes = this.corruptPlanRecoveryCauses.get(validatedProposalId);
    if (causes == null) {
      return;
    }
    causes.delete(validatedOperationId);
    if (causes.size === 0) {
      this.corruptPlanRecoveryCauses.delete(validatedProposalId);
    }
  }
}
