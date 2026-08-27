import { identifierSchema } from "../../shared/domain";
import {
  applicationJournalResultSchema,
  applicationJournalSchema,
  applicationJournalStageSchema,
  type ApplicationJournal,
  type ApplicationJournalResult,
  type ApplicationJournalStage,
} from "../../shared/storage";
import { assertChanged } from "./json";
import type { SqliteDatabase } from "./types";

interface ApplicationJournalRow {
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly new_task_uuid: string | null;
  readonly target_gid: string | null;
  readonly started_at: string;
  readonly stage: string;
  readonly final_result: string | null;
}

const applicationJournalStageOrder: Record<ApplicationJournalStage, number> = {
  started: 0,
  task_created: 1,
  attributes_applied: 2,
  relations_applied: 3,
  read_back: 4,
  metadata_verified: 5,
  ranking_recalculated: 6,
};

function rowToApplicationJournal(row: ApplicationJournalRow): ApplicationJournal {
  if (row.new_task_uuid == null && row.target_gid == null) {
    throw new Error("適用ジャーナルの対象がありません。");
  }
  if (row.new_task_uuid != null && row.target_gid != null) {
    throw new Error("適用ジャーナルの対象が複数あります。");
  }

  let target: ApplicationJournal["target"];
  if (row.new_task_uuid == null) {
    if (row.target_gid == null) {
      throw new Error("適用ジャーナルの対象GIDがありません。");
    }
    target = { kind: "task", gid: row.target_gid };
  } else {
    target = { kind: "new_task", uuid: row.new_task_uuid };
  }
  const entry = {
    proposal_id: row.proposal_id,
    operation_id: row.operation_id,
    target,
    started_at: row.started_at,
    stage: row.stage,
  };
  if (row.final_result == null) {
    return applicationJournalSchema.parse(entry);
  }
  return applicationJournalSchema.parse({
    ...entry,
    final_result: row.final_result,
  });
}

/** 適用ジャーナルのSQLite操作を提供します。 */
export class ApplicationJournalStore {
  private readonly completeStatement;
  private readonly createStatement;
  private readonly selectIncompleteStatement;
  private readonly selectOneStatement;
  private readonly updateStageStatement;

  public constructor(private readonly database: SqliteDatabase) {
    this.createStatement = database.prepare<
      [string, string, string | null, string | null, string, string, string | null],
      unknown
    >(
      "INSERT INTO application_journal (proposal_id, operation_id, new_task_uuid, target_gid, started_at, stage, final_result) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.updateStageStatement = database.prepare<[string, string, string], unknown>(
      "UPDATE application_journal SET stage = ? WHERE proposal_id = ? AND operation_id = ? AND final_result IS NULL",
    );
    this.completeStatement = database.prepare<[string, string, string], unknown>(
      "UPDATE application_journal SET final_result = ? WHERE proposal_id = ? AND operation_id = ? AND final_result IS NULL",
    );
    this.selectOneStatement = database.prepare<[string, string], ApplicationJournalRow>(
      "SELECT proposal_id, operation_id, new_task_uuid, target_gid, started_at, stage, final_result FROM application_journal WHERE proposal_id = ? AND operation_id = ?",
    );
    this.selectIncompleteStatement = database.prepare<[], ApplicationJournalRow>(
      "SELECT proposal_id, operation_id, new_task_uuid, target_gid, started_at, stage, final_result FROM application_journal WHERE final_result IS NULL ORDER BY started_at, proposal_id, operation_id",
    );
  }

  /** 適用ジャーナルを新規作成します。 */
  public create(entry: ApplicationJournal): void {
    const validatedEntry = applicationJournalSchema.parse(entry);
    if (validatedEntry.stage !== "started") {
      throw new Error("新規適用ジャーナルの段階はstartedでなければなりません。");
    }
    if (validatedEntry.final_result != null) {
      throw new Error("新規適用ジャーナルに最終結果を指定できません。");
    }
    const targetValues = validatedEntry.target.kind === "new_task"
      ? { newTaskUuid: validatedEntry.target.uuid, targetGid: null }
      : { newTaskUuid: null, targetGid: validatedEntry.target.gid };
    this.createStatement.run(
      validatedEntry.proposal_id,
      validatedEntry.operation_id,
      targetValues.newTaskUuid,
      targetValues.targetGid,
      validatedEntry.started_at,
      validatedEntry.stage,
      validatedEntry.final_result == null ? null : validatedEntry.final_result,
    );
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
    const row = this.selectOneStatement.get(validatedProposalId, validatedOperationId);
    if (row == null) {
      return undefined;
    }
    return rowToApplicationJournal(row);
  }

  /** 未完了の適用ジャーナルを全件読み出します。 */
  public getIncomplete(): readonly ApplicationJournal[] {
    return this.selectIncompleteStatement.all().map(rowToApplicationJournal);
  }
}
