import type { ErrorReporter } from "../common/errors/error-reporter";
import type { TaskWriteExecutionContext, TaskWriteExecutorRegistry } from "../common/ports/task-write-executor";
import type {
  ProposalExecution,
  ProposalExecutionRepository,
  ProposalExecutionStep,
} from "../common/ports/proposal-execution-repository";
import type {
  TaskWriteAsanaObservation,
  TaskWriteReadBackHint,
  TaskWriteReadBackPort,
} from "../common/ports/task-write-read-back";
import type { TaskWriteReceipt } from "../common/task-write-plan";
import type { TaskWriteStep } from "../common/task-write-step";
import { TaskWriteSynchronizationError } from "../common/task-write-synchronization-error";
import { executionContext, firstIncompleteStep, priorCheckReceipt } from "./proposal-execution-state";

type AsanaStep = Exclude<TaskWriteStep,
  { readonly kind: "proposal_operation_check" | "local_synchronize" }>;
type Clock = { readonly now: () => string };
type ResultBuilder<Result extends object> = (execution: ProposalExecution<Result>) => Result;
const maximumWriteAttempts = 3;

/** 保存済みplanのstepを順に実行し、読戻し済みreceiptを保存します。 */
export class ProposalExecutionEngine<Result extends object> {
  private readonly locks = new Set<string>();

  public constructor(
    private readonly repository: ProposalExecutionRepository<Result>,
    private readonly executors: TaskWriteExecutorRegistry,
    private readonly readBack: TaskWriteReadBackPort,
    private readonly resultBuilder: ResultBuilder<Result>,
    private readonly clock: Clock,
    private readonly errorReporter: ErrorReporter,
  ) {}

  /** 保存済みexecutionを再開し、terminal stateまたは競合中の保存状態を返します。 */
  public async run(executionId: string, signal: AbortSignal): Promise<ProposalExecution<Result>> {
    const initial = this.requireExecution(executionId);
    const lockKey = initial.proposal_id == null
      ? `execution:${initial.execution_id}`
      : `proposal:${initial.proposal_id}`;
    if (this.locks.has(lockKey)) return this.requireExecution(executionId);
    this.locks.add(lockKey);
    try {
      while (true) {
        signal.throwIfAborted();
        const execution = this.requireExecution(executionId);
        if (execution.state === "succeeded"
          || execution.state === "failed"
          || execution.state === "confirmation_required") return execution;
        const step = firstIncompleteStep(execution);
        if (step == null) {
          if (!this.repository.complete({
            execution_id: executionId,
            completed_at: this.clock.now(),
            result: this.resultBuilder(execution),
          })) return this.requireExecution(executionId);
          continue;
        }
        const progressed = await this.advance(execution, step, signal);
        if (!progressed) return this.requireExecution(executionId);
      }
    } finally {
      this.locks.delete(lockKey);
    }
  }

  private requireExecution(executionId: string): ProposalExecution<Result> {
    const execution = this.repository.get(executionId);
    if (execution == null) throw new Error("保存済みexecutionが見つかりません。");
    return execution;
  }

  private start(execution: ProposalExecution<Result>, step: ProposalExecutionStep): number | undefined {
    if (!this.repository.startStep({
      execution_id: execution.execution_id,
      step_id: step.descriptor.step_id,
      expected_state: step.state === "planned" ? "planned" : "running",
      expected_attempt: step.attempt,
      started_at: this.clock.now(),
    })) return undefined;
    return step.attempt + 1;
  }

  private settle(
    execution: ProposalExecution<Result>,
    step: ProposalExecutionStep,
    attempt: number,
    receipt: TaskWriteReceipt,
  ): boolean {
    return this.repository.settleStep({
      execution_id: execution.execution_id,
      step_id: step.descriptor.step_id,
      expected_attempt: attempt,
      settled_at: this.clock.now(),
      outcome: { state: "succeeded", receipt },
    });
  }

  private stop(
    execution: ProposalExecution<Result>,
    step: ProposalExecutionStep,
    attempt: number,
    state: "failed" | "confirmation_required",
    error: unknown,
  ): boolean {
    const errorId = this.errorReporter.reportErrorOnce(error, {
      source: "service",
      diagnosticCode: "proposal.execution.step",
      context: "service_diagnostic",
      level: "error",
      operationId: step.descriptor.scope.kind === "operation"
        ? step.descriptor.scope.operation_id
        : execution.execution_id,
    });
    return this.repository.settleStep({
      execution_id: execution.execution_id,
      step_id: step.descriptor.step_id,
      expected_attempt: attempt,
      settled_at: this.clock.now(),
      outcome: { state, error_id: errorId,
        ...(execution.plan.origin === "gui-edit" && step.descriptor.kind === "local_synchronize"
          ? { sync_error_code: error instanceof TaskWriteSynchronizationError ? error.code : "unexpected_error" }
          : {}) },
    });
  }

  private async advance(
    execution: ProposalExecution<Result>,
    step: ProposalExecutionStep,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (step.state !== "planned" && step.state !== "running") {
      throw new Error("terminal stepを再実行できません。");
    }
    const context = executionContext(execution, step.descriptor.kind === "local_synchronize");
    if (step.descriptor.kind === "proposal_operation_check") {
      return this.advanceCheck(execution, step, context, signal);
    }
    if (step.descriptor.kind === "local_synchronize") {
      return this.advanceSynchronization(execution, step, context, signal);
    }
    const check = priorCheckReceipt(execution, step);
    if (check?.outcome === "already_applied") {
      const attempt = this.start(execution, step);
      if (attempt == null) return false;
      return this.settle(execution, step, attempt, {
        kind: "asana_write",
        step_id: step.descriptor.step_id,
        recorded_at: this.clock.now(),
        planned_payload_fingerprint: step.descriptor.payload_fingerprint,
        applied_payload_fingerprint: step.descriptor.payload_fingerprint,
        observed_state_fingerprint: check.observed_state_fingerprint,
        task_gid: check.task_gid,
        write_performed: false,
        verification_step_id: check.step_id,
      });
    }
    return this.advanceAsana(execution, step, context, signal);
  }

  private async advanceCheck(
    execution: ProposalExecution<Result>,
    step: ProposalExecutionStep,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (step.descriptor.kind !== "proposal_operation_check"
      || step.descriptor.scope.kind !== "operation") {
      throw new Error("照合stepの種類または操作IDが一致しません。");
    }
    const attempt = step.state === "planned" ? this.start(execution, step) : step.attempt;
    if (attempt == null) return false;
    let observation;
    try {
      observation = await this.readBack.inspectOperation(step.descriptor, context, signal);
    } catch (error) {
      return this.stop(execution, step, attempt, "confirmation_required", error);
    }
    if (observation.state === "needs_write") {
      const operationId = step.descriptor.scope.operation_id;
      const hasWriteStep = context.plan.steps.some((candidate) =>
        candidate.scope.kind === "operation"
        && candidate.scope.operation_id === operationId
        && candidate.kind !== "proposal_operation_check");
      if (!hasWriteStep) {
        return this.stop(execution, step, attempt, "failed",
          new Error("未適用の操作に保存済み書き込みstepがありません。"));
      }
    }
    if (observation.state === "needs_write" || observation.state === "already_applied") {
      return this.settle(execution, step, attempt, {
        kind: "proposal_operation_check",
        step_id: step.descriptor.step_id,
        recorded_at: this.clock.now(),
        planned_payload_fingerprint: step.descriptor.payload_fingerprint,
        observed_state_fingerprint: observation.observed_state_fingerprint,
        task_gid: observation.task_gid,
        outcome: observation.state,
      });
    }
    return this.stop(execution, step, attempt,
      observation.state === "conflict" ? "failed" : "confirmation_required",
      new Error("変更案の承認時基準と現在のAsana状態を照合できません。"));
  }

  private async advanceSynchronization(
    execution: ProposalExecution<Result>,
    step: ProposalExecutionStep,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (step.descriptor.kind !== "local_synchronize") {
      throw new Error("後続同期stepの種類が一致しません。");
    }
    const attempt = this.start(execution, step);
    if (attempt == null) return false;
    let submitted;
    try {
      submitted = await this.executors.local_synchronize[step.descriptor.executor_version]
        .execute(step.descriptor, context, signal);
      if (submitted.kind !== "synchronized"
        || submitted.task_gids.length !== context.synchronization_task_gids.length
        || submitted.task_gids.some((gid, index) => gid !== context.synchronization_task_gids[index])) {
        throw new Error("後続同期の対象GIDが保存済みplanと一致しません。");
      }
    } catch (error) {
      return this.stop(execution, step, attempt, "confirmation_required", error);
    }
    return this.settle(execution, step, attempt, {
      kind: "local_synchronize",
      step_id: step.descriptor.step_id,
      recorded_at: this.clock.now(),
      planned_payload_fingerprint: step.descriptor.payload_fingerprint,
      task_gids: [...submitted.task_gids],
    });
  }

  private async advanceAsana(
    execution: ProposalExecution<Result>,
    step: ProposalExecutionStep,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<boolean> {
    const descriptor = step.descriptor;
    if (descriptor.kind === "proposal_operation_check" || descriptor.kind === "local_synchronize") {
      throw new Error("Asana stepの種類が一致しません。");
    }
    const attempt = step.state === "planned" ? this.start(execution, step) : step.attempt;
    if (attempt == null) return false;
    const hint: TaskWriteReadBackHint = step.state === "planned"
      ? { kind: "before_write" }
      : { kind: "resume" };
    let observation: TaskWriteAsanaObservation;
    try {
      observation = await this.readBack.inspectAsanaStep(descriptor, context, hint, signal);
    } catch (error) {
      return this.stop(execution, step, attempt, "confirmation_required", error);
    }
    if (observation.state === "applied") {
      return this.settle(execution, step, attempt, this.asanaReceipt(descriptor, observation, false));
    }
    if (observation.state === "unknown" || (step.state === "running" && descriptor.retry_class === "non_retryable")) {
      return this.stop(execution, step, attempt, "confirmation_required",
        new Error("Asana書き込みの適用有無を安全に判定できません。"));
    }
    if (step.state === "running" && attempt >= maximumWriteAttempts) {
      return this.stop(execution, step, attempt, "failed",
        new Error("Asana書き込みの再試行回数が上限に達しました。"));
    }
    const writeAttempt = step.state === "running" ? this.start(execution, step) : attempt;
    if (writeAttempt == null) return false;
    let submittedTaskGid: string | undefined;
    try {
      const submitted = await this.executeAsana(descriptor, context, signal);
      if (submitted.kind === "created_task") submittedTaskGid = submitted.task_gid;
    } catch (error) {
      return this.inspectAfterWriteError(execution, step, writeAttempt, descriptor, context, error, signal);
    }
    let observed: TaskWriteAsanaObservation;
    try {
      observed = await this.readBack.inspectAsanaStep(descriptor, context,
        { kind: "after_write", ...(submittedTaskGid == null ? {} : { submitted_task_gid: submittedTaskGid }) }, signal);
    } catch (error) {
      return this.stop(execution, step, writeAttempt, "confirmation_required", error);
    }
    if (observed.state === "applied") {
      return this.settle(execution, step, writeAttempt, this.asanaReceipt(descriptor, observed, true));
    }
    return this.stop(execution, step, writeAttempt, "confirmation_required",
      new Error("Asana書き込み後の読戻しで適用を確認できません。"));
  }

  private async inspectAfterWriteError(
    execution: ProposalExecution<Result>,
    step: ProposalExecutionStep,
    attempt: number,
    descriptor: AsanaStep,
    context: TaskWriteExecutionContext,
    error: unknown,
    signal: AbortSignal,
  ): Promise<boolean> {
    let observation: TaskWriteAsanaObservation;
    try {
      observation = await this.readBack.inspectAsanaStep(descriptor, context, { kind: "resume" }, signal);
    } catch (readError) {
      const combined = new AggregateError([error, readError], "Asana書き込みと読戻しに失敗しました。");
      return this.stop(execution, step, attempt, "confirmation_required", combined);
    }
    if (observation.state === "applied") {
      this.errorReporter.reportErrorOnce(error, {
        source: "service",
        diagnosticCode: "proposal.execution.write",
        context: "service_diagnostic",
        level: "warning",
        operationId: descriptor.scope.kind === "operation" ? descriptor.scope.operation_id : execution.execution_id,
      });
      return this.settle(execution, step, attempt, this.asanaReceipt(descriptor, observation, true));
    }
    if (observation.state === "not_applied"
      && descriptor.retry_class !== "non_retryable"
      && attempt < maximumWriteAttempts) {
      this.errorReporter.reportErrorOnce(error, {
        source: "service",
        diagnosticCode: "proposal.execution.write",
        context: "service_diagnostic",
        level: "warning",
        operationId: descriptor.scope.kind === "operation" ? descriptor.scope.operation_id : execution.execution_id,
      });
      const refreshed = this.requireExecution(execution.execution_id);
      const currentStep = refreshed.steps.find((item) => item.descriptor.step_id === step.descriptor.step_id);
      if (currentStep?.state !== "running" || currentStep.attempt !== attempt) {
        throw new Error("再試行するAsana stepの保存状態が変わりました。");
      }
      return this.advanceAsana(refreshed, currentStep, executionContext(refreshed, false), signal);
    }
    return this.stop(execution, step, attempt,
      observation.state === "not_applied" ? "failed" : "confirmation_required", error);
  }

  private asanaReceipt(step: AsanaStep, observation: Extract<TaskWriteAsanaObservation, { readonly state: "applied" }>, writePerformed: boolean): TaskWriteReceipt {
    const common = {
      step_id: step.step_id,
      recorded_at: this.clock.now(),
      planned_payload_fingerprint: step.payload_fingerprint,
      applied_payload_fingerprint: step.payload_fingerprint,
      observed_state_fingerprint: observation.observed_state_fingerprint,
      task_gid: observation.task_gid,
    };
    if (step.kind === "asana_create_task") {
      return { ...common, kind: "created_task", temporary_ref: step.payload.target.ref };
    }
    return { ...common, kind: "asana_write", write_performed: writePerformed };
  }

  private executeAsana(
    step: AsanaStep,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "created_task"; readonly task_gid: string } | { readonly kind: "written" }> {
    switch (step.kind) {
      case "asana_create_task": return this.executors.asana_create_task[step.executor_version].execute(step, context, signal);
      case "asana_update_task": return this.executors.asana_update_task[step.executor_version].execute(step, context, signal);
      case "asana_add_to_project": return this.executors.asana_add_to_project[step.executor_version].execute(step, context, signal);
      case "asana_add_to_section": return this.executors.asana_add_to_section[step.executor_version].execute(step, context, signal);
      case "asana_add_tag": return this.executors.asana_add_tag[step.executor_version].execute(step, context, signal);
      case "asana_remove_tag": return this.executors.asana_remove_tag[step.executor_version].execute(step, context, signal);
      case "asana_set_parent": return this.executors.asana_set_parent[step.executor_version].execute(step, context, signal);
      case "asana_clear_parent": return this.executors.asana_clear_parent[step.executor_version].execute(step, context, signal);
      case "asana_merge_external_data": return this.executors.asana_merge_external_data[step.executor_version].execute(step, context, signal);
    }
  }
}
