import { z } from "zod";
import type {
  CompleteProposalExecution,
  ProposalExecution,
  ProposalExecutionRepository,
  SaveProposalExecution,
  SettleProposalExecutionStep,
  StartProposalExecutionStep,
} from "../../application/common/ports/proposal-execution-repository";
import { isTaskWriteJsonValue } from "../../domain/task-write-values";
import { taskWriteSynchronizationFailureCodeSchema } from "../../application/common/ports/asana-task-write";
import type { PersistenceRuntime } from "./persistence-runtime";
import {
  fingerprintProposalExecutionContext,
  parseExecutionContext,
  parseExecutionRecord,
  type ExecutionRow,
  type ExecutionStepRow,
  type PlanParser,
  type ReceiptParser,
} from "./proposal-execution-record";

const identifierSchema = z.string().min(1).regex(/^\S+$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const attemptSchema = z.number().int().nonnegative().safe();
const errorIdSchema = z.uuid();

type ExecutionIdRow = { readonly execution_id: string };
type ChangeResult = { readonly changes: number };

function assertSingleChange(result: ChangeResult, operation: string): void {
  if (result.changes !== 1) {
    throw new Error(`${operation}の保存対象が一致しません。`);
  }
}

/** 保存済みplanとstepの状態をSQLite transactionで管理します。 */
export class SqliteProposalExecutionRepository<Result extends object>
implements ProposalExecutionRepository<Result> {
  public constructor(
    private readonly runtime: PersistenceRuntime,
    private readonly parsePlan: PlanParser,
    private readonly parseReceipt: ReceiptParser,
    private readonly resultSchema: z.ZodType<Result>,
  ) {}

  /** 全stepを未開始としてplanと同じtransactionに保存します。 */
  public save(input: SaveProposalExecution): void {
    const plan = this.parsePlan(input.plan);
    const context = parseExecutionContext(input.proposal_context, plan);
    const proposalId = input.proposal_id == null
      ? null
      : identifierSchema.parse(input.proposal_id);
    const retryOfExecutionId = input.retry_of_execution_id == null
      ? null
      : identifierSchema.parse(input.retry_of_execution_id);
    const createdAt = timestampSchema.parse(input.created_at);
    if (
      (plan.origin === "proposal") !== (proposalId != null)
      || retryOfExecutionId === plan.execution_id
    ) {
      throw new Error("executionの実行元とproposal IDが一致しません。");
    }
    const save = this.runtime.transaction(() => {
      this.runtime.connection.prepare<
        [
          string, string | null, string | null, number, string, string, string,
          string | null, string | null, string, string,
        ],
        unknown
      >(`INSERT INTO proposal_executions (
        execution_id, proposal_id, retry_of_execution_id, format_version,
        origin, plan_json, plan_fingerprint, context_json, context_fingerprint,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`).run(
        plan.execution_id,
        proposalId,
        retryOfExecutionId,
        plan.format_version,
        plan.origin,
        JSON.stringify(plan),
        plan.plan_fingerprint,
        context == null ? null : JSON.stringify(context),
        context == null ? null : fingerprintProposalExecutionContext(context),
        createdAt,
        createdAt,
      );
      const insertStep = this.runtime.connection.prepare<
        [string, string, number, string, number, string, string],
        unknown
      >(`INSERT INTO proposal_execution_steps (
        execution_id, step_id, step_order, kind, executor_version,
        payload_fingerprint, state, attempt, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'planned', 0, ?)`);
      for (const [index, step] of plan.steps.entries()) {
        insertStep.run(
          plan.execution_id,
          step.step_id,
          index,
          step.kind,
          step.executor_version,
          step.payload_fingerprint,
          createdAt,
        );
      }
      if (this.get(plan.execution_id) == null) {
        throw new Error("保存したexecutionを読み出せません。");
      }
    });
    save();
  }

  /** IDに一致するexecutionと全stepを検証して読み出します。 */
  public get(executionId: string): ProposalExecution<Result> | undefined {
    const validatedId = identifierSchema.parse(executionId);
    const execution = this.runtime.connection.prepare<[string], ExecutionRow>(
      `SELECT execution_id, proposal_id, retry_of_execution_id, format_version,
        origin, plan_json, plan_fingerprint, context_json, context_fingerprint,
        state, error_id, result_json, created_at, updated_at
       FROM proposal_executions WHERE execution_id = ?`,
    ).get(validatedId);
    if (execution == null) {
      return undefined;
    }
    const steps = this.runtime.connection.prepare<[string], ExecutionStepRow>(
      `SELECT execution_id, step_id, step_order, kind, executor_version,
        payload_fingerprint, state, attempt, receipt_json, error_id, updated_at, sync_error_code
       FROM proposal_execution_steps WHERE execution_id = ? ORDER BY step_order`,
    ).all(validatedId);
    return parseExecutionRecord(
      execution,
      steps,
      this.parsePlan,
      this.parseReceipt,
      (value) => this.resultSchema.parse(value),
    );
  }

  /** 同じproposalに属する保存済みexecutionを読み出します。 */
  public getByProposal(proposalId: string): readonly ProposalExecution<Result>[] {
    const validatedId = identifierSchema.parse(proposalId);
    const rows = this.runtime.connection.prepare<[string], ExecutionIdRow>(
      "SELECT execution_id FROM proposal_executions WHERE proposal_id = ? ORDER BY created_at, execution_id",
    ).all(validatedId);
    return rows.map((row) => {
      const execution = this.get(row.execution_id);
      if (execution == null) {
        throw new Error("一覧のexecutionを読み出せません。");
      }
      return execution;
    });
  }

  /** 未完了executionを保存済みplanから読み出します。 */
  public getIncomplete(): readonly ProposalExecution<Result>[] {
    const rows = this.runtime.connection.prepare<[], ExecutionIdRow>(
      "SELECT execution_id FROM proposal_executions WHERE state IN ('planned', 'running') ORDER BY created_at, execution_id",
    ).all();
    return rows.map((row) => {
      const execution = this.get(row.execution_id);
      if (execution == null) {
        throw new Error("未完了executionを読み出せません。");
      }
      return execution;
    });
  }

  /** 未開始または読み戻しで未適用と確認したstepの試行回数を増やします。 */
  public startStep(input: StartProposalExecutionStep): boolean {
    const executionId = identifierSchema.parse(input.execution_id);
    const stepId = identifierSchema.parse(input.step_id);
    const expectedState = z.enum(["planned", "running"]).parse(input.expected_state);
    const expectedAttempt = attemptSchema.parse(input.expected_attempt);
    const startedAt = timestampSchema.parse(input.started_at);
    const start = this.runtime.transaction(() => {
      const execution = this.get(executionId);
      if (execution == null) {
        throw new Error("開始するexecutionがありません。");
      }
      const index = execution.steps.findIndex((step) => step.descriptor.step_id === stepId);
      if (index < 0) {
        throw new Error("開始するstepがplanにありません。");
      }
      const step = execution.steps[index];
      if (step == null) {
        throw new Error("開始するstepが見つかりません。");
      }
      if (
        execution.state !== "planned" && execution.state !== "running"
        || step.state !== expectedState
        || step.attempt !== expectedAttempt
      ) {
        return false;
      }
      if (execution.steps.slice(0, index).some((previous) => previous.state !== "succeeded")) {
        throw new Error("前のstepが完了する前に開始できません。");
      }
      const changed = this.runtime.connection.prepare<
        [string, string, string, string, number],
        ChangeResult
      >(`UPDATE proposal_execution_steps
          SET state = 'running', attempt = attempt + 1, updated_at = ?
          WHERE execution_id = ? AND step_id = ?
            AND state = ? AND attempt = ?`).run(
        startedAt,
        executionId,
        stepId,
        expectedState,
        expectedAttempt,
      );
      if (changed.changes === 0) {
        return false;
      }
      assertSingleChange(changed, "step開始");
      const executionChanged = this.runtime.connection.prepare<[string, string], ChangeResult>(
        `UPDATE proposal_executions SET state = 'running', updated_at = ?
          WHERE execution_id = ? AND state IN ('planned', 'running')`,
      ).run(startedAt, executionId);
      assertSingleChange(executionChanged, "execution開始");
      this.get(executionId);
      return true;
    });
    return start();
  }

  /** 実行中stepのreceiptまたはerror IDをCASで確定します。 */
  public settleStep(input: SettleProposalExecutionStep): boolean {
    const executionId = identifierSchema.parse(input.execution_id);
    const stepId = identifierSchema.parse(input.step_id);
    const expectedAttempt = attemptSchema.positive().parse(input.expected_attempt);
    const settledAt = timestampSchema.parse(input.settled_at);
    const outcome = input.outcome;
    const receipt = outcome.state === "succeeded"
      ? this.parseReceipt(outcome.receipt)
      : undefined;
    const errorId = outcome.state === "succeeded"
      ? null
      : errorIdSchema.parse(outcome.error_id);
    const syncErrorCode = outcome.state === "succeeded" || outcome.sync_error_code == null
      ? null
      : taskWriteSynchronizationFailureCodeSchema.parse(outcome.sync_error_code);
    const settle = this.runtime.transaction(() => {
      const execution = this.get(executionId);
      if (execution == null) {
        throw new Error("確定するexecutionがありません。");
      }
      const step = execution.steps.find((item) => item.descriptor.step_id === stepId);
      if (step == null) {
        throw new Error("確定するstepがplanにありません。");
      }
      if (
        execution.state !== "running"
        || step.state !== "running"
        || step.attempt !== expectedAttempt
      ) {
        return false;
      }
      if (syncErrorCode != null && (execution.plan.origin !== "gui-edit" || step.descriptor.kind !== "local_synchronize")) {
        throw new Error("同期失敗コードをGUI編集の後続同期以外へ保存できません。");
      }
      const changed = this.runtime.connection.prepare<
        [string, string | null, string | null, string | null, string, string, string, number],
        ChangeResult
      >(`UPDATE proposal_execution_steps
          SET state = ?, receipt_json = ?, error_id = ?, sync_error_code = ?, updated_at = ?
          WHERE execution_id = ? AND step_id = ?
            AND state = 'running' AND attempt = ?`).run(
        outcome.state,
        receipt == null ? null : JSON.stringify(receipt),
        errorId,
        syncErrorCode,
        settledAt,
        executionId,
        stepId,
        expectedAttempt,
      );
      if (changed.changes === 0) {
        return false;
      }
      assertSingleChange(changed, "step確定");
      const nextState = outcome.state === "succeeded" ? "running" : outcome.state;
      const executionChanged = this.runtime.connection.prepare<
        [string, string | null, string, string],
        ChangeResult
      >(`UPDATE proposal_executions
          SET state = ?, error_id = ?, updated_at = ?
          WHERE execution_id = ? AND state = 'running'`).run(
        nextState,
        errorId,
        settledAt,
        executionId,
      );
      assertSingleChange(executionChanged, "execution確定");
      this.get(executionId);
      return true;
    });
    return settle();
  }

  /** 全step完了後に最終resultとsucceededへの遷移を同時に保存します。 */
  public complete(input: CompleteProposalExecution<Result>): boolean {
    const executionId = identifierSchema.parse(input.execution_id);
    const completedAt = timestampSchema.parse(input.completed_at);
    const result = this.resultSchema.parse(input.result);
    if (!isTaskWriteJsonValue(result)) {
      throw new Error("execution resultはJSON値で指定してください。");
    }
    const serializedResult = JSON.stringify(result);
    if (serializedResult === undefined) {
      throw new Error("execution resultを直列化できません。");
    }
    const completeExecution = this.runtime.transaction(() => {
      const execution = this.get(executionId);
      if (execution == null) {
        throw new Error("完了するexecutionがありません。");
      }
      if (execution.state !== "running") {
        return false;
      }
      if (execution.steps.some((step) => step.state !== "succeeded")) {
        throw new Error("未完了のstepがあるexecutionを完了できません。");
      }
      const changed = this.runtime.connection.prepare<
        [string, string, string],
        ChangeResult
      >(`UPDATE proposal_executions SET
          state = 'succeeded', result_json = ?, updated_at = ?
          WHERE execution_id = ? AND state = 'running' AND result_json IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM proposal_execution_steps
              WHERE execution_id = proposal_executions.execution_id AND state <> 'succeeded'
            )`).run(serializedResult, completedAt, executionId);
      if (changed.changes === 0) {
        return false;
      }
      assertSingleChange(changed, "execution完了");
      this.get(executionId);
      return true;
    });
    return completeExecution();
  }
}
