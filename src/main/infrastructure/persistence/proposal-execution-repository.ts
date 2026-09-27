import { z } from "zod";
import type { ErrorReporter } from "../../application/common/errors/error-reporter";
import type {
  CompleteProposalExecution,
  ProposalExecution,
  ProposalExecutionRepository,
  SaveProposalExecution,
  SaveRetryProposalExecution,
  SavedRetryProposalExecution,
  SettleProposalExecutionStep,
  StartProposalExecutionStep,
} from "../../application/common/ports/proposal-execution-repository";
import { canonicalizeTaskWriteJson, isTaskWriteJsonValue } from "../../domain/task-write-values";
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
  private readonly listeners = new Set<(execution: ProposalExecution<Result>) => void>();

  public constructor(
    private readonly runtime: PersistenceRuntime,
    private readonly parsePlan: PlanParser,
    private readonly parseReceipt: ReceiptParser,
    private readonly resultSchema: z.ZodType<Result>,
    private readonly reporter: ErrorReporter,
  ) {}

  /** 保存済みexecutionの変更を購読します。 */
  public onChanged(listener: (execution: ProposalExecution<Result>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publishChanged(execution: ProposalExecution<Result>): void {
    for (const listener of this.listeners) {
      try {
        listener(execution);
      } catch (error: unknown) {
        this.reporter.reportErrorOnce(error, {
          source: "service",
          diagnosticCode: "ipc.error",
          context: "service_diagnostic",
          level: "error",
        });
      }
    }
  }

  /** 全stepを未開始としてplanと同じtransactionに保存します。 */
  public save(input: SaveProposalExecution): void {
    const plan = this.parsePlan(input.plan);
    const context = parseExecutionContext(input.proposal_context, plan);
    const proposalId = input.proposal_id == null
      ? null
      : identifierSchema.parse(input.proposal_id);
    const createdAt = timestampSchema.parse(input.created_at);
    if ((plan.origin === "proposal") !== (proposalId != null)) {
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
        null,
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
      const execution = this.get(plan.execution_id);
      if (execution == null) {
        throw new Error("保存したexecutionを読み出せません。");
      }
      return execution;
    });
    this.publishChanged(save());
  }

  /** 元の確定済みstepを継承して明示再試行を原子的に保存します。 */
  public saveRetry(input: SaveRetryProposalExecution): SavedRetryProposalExecution<Result> {
    const plan = this.parsePlan(input.plan);
    const context = parseExecutionContext(input.proposal_context, plan);
    const proposalId = input.proposal_id == null
      ? null
      : identifierSchema.parse(input.proposal_id);
    const sourceId = identifierSchema.parse(input.retry_of_execution_id);
    const createdAt = timestampSchema.parse(input.created_at);
    if ((plan.origin === "proposal") !== (proposalId != null) || sourceId === plan.execution_id) {
      throw new Error("再試行executionの実行元と参照元が一致しません。");
    }
    const save = this.runtime.transaction((): SavedRetryProposalExecution<Result> => {
      const source = this.get(sourceId);
      if (source == null) {
        throw new Error("再試行元のexecutionがありません。");
      }
      if (source.state !== "failed" && source.state !== "confirmation_required") {
        throw new Error("未停止のexecutionを再試行できません。");
      }
      if (source.proposal_id !== (proposalId ?? undefined)
        || canonicalizeTaskWriteJson({
          ...source.plan,
          execution_id: plan.execution_id,
          plan_fingerprint: plan.plan_fingerprint,
        }) !== canonicalizeTaskWriteJson(plan)
        || (source.proposal_context == null) !== (context == null)
        || (source.proposal_context != null && context != null
          && canonicalizeTaskWriteJson(source.proposal_context) !== canonicalizeTaskWriteJson(context))) {
        throw new Error("再試行planと元executionの保存内容が一致しません。");
      }
      const successors = this.runtime.connection.prepare<[string], ExecutionIdRow>(
        "SELECT execution_id FROM proposal_executions WHERE retry_of_execution_id = ?",
      ).all(sourceId);
      if (successors.length > 1) {
        throw new Error("再試行元のexecutionに複数の後継があります。");
      }
      const successor = successors[0];
      if (successor != null) {
        const execution = this.get(successor.execution_id);
        if (execution == null) {
          throw new Error("再試行済みexecutionを読み出せません。");
        }
        return { execution, created: false };
      }
      const stopped = source.steps.find((step) => step.state === source.state);
      if (stopped == null) {
        throw new Error("再試行元の停止stepがありません。");
      }
      const resumeAsana = stopped.descriptor.kind !== "proposal_operation_check"
        && stopped.descriptor.kind !== "local_synchronize";
      const state = resumeAsana || source.steps.some((step) => step.state === "succeeded")
        ? "running"
        : "planned";
      this.runtime.connection.prepare<
        [
          string, string | null, string, number, string, string, string,
          string | null, string | null, string, string, string,
        ],
        unknown
      >(`INSERT INTO proposal_executions (
        execution_id, proposal_id, retry_of_execution_id, format_version,
        origin, plan_json, plan_fingerprint, context_json, context_fingerprint,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        plan.execution_id,
        proposalId,
        sourceId,
        plan.format_version,
        plan.origin,
        JSON.stringify(plan),
        plan.plan_fingerprint,
        context == null ? null : JSON.stringify(context),
        context == null ? null : fingerprintProposalExecutionContext(context),
        state,
        createdAt,
        createdAt,
      );
      const resumeStepId = resumeAsana ? stopped.descriptor.step_id : null;
      const copied = this.runtime.connection.prepare<
        [string, string | null, string | null, string, string],
        ChangeResult
      >(`INSERT INTO proposal_execution_steps (
        execution_id, step_id, step_order, kind, executor_version,
        payload_fingerprint, state, attempt, receipt_json, updated_at
      ) SELECT ?, step_id, step_order, kind, executor_version,
        payload_fingerprint,
        CASE WHEN state = 'succeeded' THEN 'succeeded'
          WHEN step_id = ? THEN 'running' ELSE 'planned' END,
        CASE WHEN state = 'succeeded' THEN attempt
          WHEN step_id = ? THEN 1 ELSE 0 END,
        CASE WHEN state = 'succeeded' THEN receipt_json ELSE NULL END,
        ? FROM proposal_execution_steps WHERE execution_id = ? ORDER BY step_order`).run(
        plan.execution_id,
        resumeStepId,
        resumeStepId,
        createdAt,
        sourceId,
      );
      if (copied.changes !== plan.steps.length) {
        throw new Error("再試行stepの保存件数がplanと一致しません。");
      }
      const execution = this.get(plan.execution_id);
      if (execution == null) {
        throw new Error("再試行executionを読み出せません。");
      }
      return { execution, created: true };
    });
    const saved = save();
    if (saved.created) this.publishChanged(saved.execution);
    return saved;
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
        return undefined;
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
        return undefined;
      }
      assertSingleChange(changed, "step開始");
      const executionChanged = this.runtime.connection.prepare<[string, string], ChangeResult>(
        `UPDATE proposal_executions SET state = 'running', updated_at = ?
          WHERE execution_id = ? AND state IN ('planned', 'running')`,
      ).run(startedAt, executionId);
      assertSingleChange(executionChanged, "execution開始");
      const changedExecution = this.get(executionId);
      if (changedExecution == null) {
        throw new Error("開始したexecutionを読み出せません。");
      }
      return changedExecution;
    });
    const changedExecution = start();
    if (changedExecution == null) {
      return false;
    }
    this.publishChanged(changedExecution);
    return true;
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
        return undefined;
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
        return undefined;
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
      const changedExecution = this.get(executionId);
      if (changedExecution == null) {
        throw new Error("確定したexecutionを読み出せません。");
      }
      return changedExecution;
    });
    const changedExecution = settle();
    if (changedExecution == null) {
      return false;
    }
    this.publishChanged(changedExecution);
    return true;
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
        return undefined;
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
        return undefined;
      }
      assertSingleChange(changed, "execution完了");
      const changedExecution = this.get(executionId);
      if (changedExecution == null) {
        throw new Error("完了したexecutionを読み出せません。");
      }
      return changedExecution;
    });
    const changedExecution = completeExecution();
    if (changedExecution == null) {
      return false;
    }
    this.publishChanged(changedExecution);
    return true;
  }
}
