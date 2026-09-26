type FieldClassification = "before" | "partial" | "after" | "conflict";

type ConflictReason =
  | "baseline_changed"
  | "read_back_mismatch"
  | "external_unreadable"
  | "external_identity_mismatch"
  | "merge_conflict"
  | "external_capacity_exceeded";

type ExternalConflictReason = Extract<
  ConflictReason,
  "external_unreadable" | "external_identity_mismatch" | "merge_conflict" | "external_capacity_exceeded"
>;

type NonCreateOperation = {
  readonly operation: string;
  readonly operation_id: string;
};

type NonCreateInput = {
  readonly project_gid: string;
  readonly workspace_gid: string;
  readonly activity_date: string;
  readonly device_id: string;
  readonly baseline_external_data?: { readonly gid: string; readonly data: string } | undefined;
};

type ExternalData<TData> = {
  readonly response: { readonly gid: string; readonly data: string };
  readonly data: TData;
};

type ExternalReadResult<TData> =
  | { readonly kind: "valid"; readonly value: ExternalData<TData> }
  | { readonly kind: "conflict"; readonly reason_code: "external_unreadable" | "external_identity_mismatch" };

type ExternalMergePlan =
  | { readonly kind: "none"; readonly expected: undefined; readonly write: false }
  | { readonly kind: "ready"; readonly serialized: string; readonly write: boolean }
  | { readonly kind: "conflict"; readonly reason_code: "merge_conflict" | "external_capacity_exceeded" };

type CoreWriteResult =
  | { readonly kind: "completed"; readonly changed: boolean }
  | { readonly kind: "conflict"; readonly side_effect: "none" | "possible"; readonly reason_code?: ConflictReason };

type WriteAction =
  | "create_task"
  | "update_task"
  | "add_task_to_project"
  | "add_task_to_section"
  | "add_task_tag"
  | "remove_task_tag"
  | "set_task_parent"
  | "clear_task_parent";

export type NonCreateWriteDependencies<
  TOperation extends NonCreateOperation,
  TInput extends NonCreateInput,
  TTask,
  TTags,
  TData,
  TExternalOperation,
  TResult,
> = {
  readonly readTask: (taskGid: string, signal: AbortSignal) => Promise<TTask>;
  readonly fetchWorkspaceTags: (workspaceGid: string, signal: AbortSignal) => Promise<TTags>;
  readonly targetGid: (operation: TOperation, mappings: ReadonlyMap<string, string>) => string;
  readonly taskHasProject: (task: TTask, projectGid: string) => boolean;
  readonly createConflictResult: (operationId: string, taskGid: string, reason: ConflictReason, sideEffect: "none" | "possible") => TResult;
  readonly externalConflictResult: (operationId: string, taskGid: string, reason: ExternalConflictReason, sideEffect: "none" | "possible") => TResult;
  readonly createResult: (operationId: string, taskGid: string, outcome: "applied" | "already_applied", reason: "applied" | "already_applied") => TResult;
  readonly parseBaselineExternal: (external: { readonly gid: string; readonly data: string }) => ExternalData<TData>;
  readonly operationUsesExternalData: (operation: TOperation) => boolean;
  readonly classifyOperation: (operation: TOperation, task: TTask, input: TInput, mappings: ReadonlyMap<string, string>, tags: TTags | undefined) => FieldClassification;
  readonly externalOperationsForOperation: (operation: TOperation, baseline: TData, mappings: ReadonlyMap<string, string>, activityDate: string) => readonly TExternalOperation[];
  readonly readCurrentExternal: (task: TTask) => ExternalReadResult<TData>;
  readonly validateCurrentExternal: (result: ExternalReadResult<TData>, baseline: ExternalData<TData>) => ExternalReadResult<TData>;
  readonly classifyExternalMetadata: (operation: TOperation, baseline: TData, current: TData, mappings: ReadonlyMap<string, string>, activityDate: string) => FieldClassification;
  readonly applyAsanaOperation: (operation: TOperation, task: TTask, input: TInput, mappings: ReadonlyMap<string, string>, tags: TTags | undefined, beforeWrite: (task: TTask) => ConflictReason | undefined, onWriteAttempt: (action: WriteAction) => void, signal: AbortSignal) => Promise<CoreWriteResult>;
  readonly mergeExternalPlan: (baseline: ExternalData<TData>, current: ExternalData<TData>, operations: readonly TExternalOperation[], lastWriter: string) => ExternalMergePlan;
  readonly writeExternalData: (taskGid: string, gid: string, data: string, signal: AbortSignal) => Promise<unknown>;
};

/** 非作成操作のAsana値と外部メタデータを順に適用して読み戻します。 */
export async function applyNonCreateOperation<
  TOperation extends NonCreateOperation,
  TInput extends NonCreateInput,
  TTask,
  TTags,
  TData,
  TExternalOperation,
  TResult,
>(
  input: TInput,
  operation: TOperation,
  mappings: ReadonlyMap<string, string>,
  signal: AbortSignal,
  onWriteAttempt: (action: WriteAction) => void,
  dependencies: NonCreateWriteDependencies<TOperation, TInput, TTask, TTags, TData, TExternalOperation, TResult>,
): Promise<TResult> {
  const taskGid = dependencies.targetGid(operation, mappings);
  let task = await dependencies.readTask(taskGid, signal);
  if (!dependencies.taskHasProject(task, input.project_gid)) {
    return dependencies.createConflictResult(
      operation.operation_id,
      taskGid,
      "baseline_changed",
      "none",
    );
  }
  const baselineExternalInput = input.baseline_external_data;
  const baselineExternal = baselineExternalInput == null
    ? undefined
    : dependencies.parseBaselineExternal(baselineExternalInput);
  if (dependencies.operationUsesExternalData(operation) && baselineExternal == null) {
    throw new Error("この操作にはbaseline外部データが必要です。");
  }
  const tags = operation.operation === "set_importance" || operation.operation === "set_area"
    ? await dependencies.fetchWorkspaceTags(input.workspace_gid, signal)
    : undefined;
  let coreState = dependencies.classifyOperation(
    operation,
    task,
    input,
    mappings,
    tags,
  );
  if (coreState === "conflict") {
    return dependencies.createConflictResult(
      operation.operation_id,
      taskGid,
      "baseline_changed",
      "none",
    );
  }
  const externalOperations = baselineExternal == null
    ? []
    : dependencies.externalOperationsForOperation(
        operation,
        baselineExternal.data,
        mappings,
        input.activity_date,
      );
  let initialMetadataState: FieldClassification = "after";
  if (dependencies.operationUsesExternalData(operation)) {
    if (baselineExternal == null) {
      throw new Error("この操作にはbaseline外部データが必要です。");
    }
    const initialExternalResult = dependencies.validateCurrentExternal(
      dependencies.readCurrentExternal(task),
      baselineExternal,
    );
    if (initialExternalResult.kind === "conflict") {
      return dependencies.externalConflictResult(
        operation.operation_id,
        taskGid,
        initialExternalResult.reason_code,
        "none",
      );
    }
    initialMetadataState = dependencies.classifyExternalMetadata(
      operation,
      baselineExternal.data,
      initialExternalResult.value.data,
      mappings,
      input.activity_date,
    );
    if (initialMetadataState === "conflict") {
      return dependencies.externalConflictResult(
        operation.operation_id,
        taskGid,
        "merge_conflict",
        "none",
      );
    }
  }
  if (coreState === "after" && initialMetadataState === "after") {
    return dependencies.createResult(operation.operation_id, taskGid, "already_applied", "already_applied");
  }
  const beforeCoreWrite = (currentTask: TTask): ConflictReason | undefined => {
    if (!dependencies.taskHasProject(currentTask, input.project_gid)) {
      return "baseline_changed";
    }
    if (!dependencies.operationUsesExternalData(operation)) {
      return undefined;
    }
    if (baselineExternal == null) {
      throw new Error("この操作にはbaseline外部データが必要です。");
    }
    const currentExternalResult = dependencies.validateCurrentExternal(
      dependencies.readCurrentExternal(currentTask),
      baselineExternal,
    );
    if (currentExternalResult.kind === "conflict") {
      return currentExternalResult.reason_code;
    }
    return dependencies.classifyExternalMetadata(
      operation,
      baselineExternal.data,
      currentExternalResult.value.data,
      mappings,
      input.activity_date,
    ) === "conflict"
      ? "merge_conflict"
      : undefined;
  };
  let asanaChanged = false;
  let externalChanged = false;
  if (coreState !== "after") {
    task = await dependencies.readTask(taskGid, signal);
    if (!dependencies.taskHasProject(task, input.project_gid)) {
      return dependencies.createConflictResult(
        operation.operation_id,
        taskGid,
        "baseline_changed",
        "none",
      );
    }
    coreState = dependencies.classifyOperation(
      operation,
      task,
      input,
      mappings,
      tags,
    );
    if (coreState === "conflict") {
      return dependencies.createConflictResult(
        operation.operation_id,
        taskGid,
        "baseline_changed",
        "none",
      );
    }
    if (coreState !== "after") {
      const guardReason = beforeCoreWrite(task);
      if (guardReason != null) {
        if (
          guardReason === "external_unreadable"
          || guardReason === "external_identity_mismatch"
          || guardReason === "merge_conflict"
        ) {
          return dependencies.externalConflictResult(
            operation.operation_id,
            taskGid,
            guardReason,
            "none",
          );
        }
        return dependencies.createConflictResult(
          operation.operation_id,
          taskGid,
          guardReason,
          "none",
        );
      }
      const coreResult = await dependencies.applyAsanaOperation(
        operation,
        task,
        input,
        mappings,
        tags,
        beforeCoreWrite,
        onWriteAttempt,
        signal,
      );
      if (coreResult.kind === "conflict") {
        if (
          coreResult.reason_code === "external_unreadable"
          || coreResult.reason_code === "external_identity_mismatch"
          || coreResult.reason_code === "merge_conflict"
        ) {
          return dependencies.externalConflictResult(
            operation.operation_id,
            taskGid,
            coreResult.reason_code,
            coreResult.side_effect,
          );
        }
        return dependencies.createConflictResult(
          operation.operation_id,
          taskGid,
          coreResult.reason_code ?? "baseline_changed",
          coreResult.side_effect,
        );
      }
      asanaChanged = coreResult.changed;
      coreState = "after";
    }
  }

  if (externalOperations.length > 0) {
    if (baselineExternal == null) {
      throw new Error("Custom external dataのbaselineがありません。");
    }
    task = await dependencies.readTask(taskGid, signal);
    const latestExternalResult = dependencies.validateCurrentExternal(
      dependencies.readCurrentExternal(task),
      baselineExternal,
    );
    if (latestExternalResult.kind === "conflict") {
      return dependencies.externalConflictResult(
        operation.operation_id,
        taskGid,
        latestExternalResult.reason_code,
        asanaChanged ? "possible" : "none",
      );
    }
    let metadataState = dependencies.classifyExternalMetadata(
      operation,
      baselineExternal.data,
      latestExternalResult.value.data,
      mappings,
      input.activity_date,
    );
    if (metadataState === "conflict") {
      return dependencies.externalConflictResult(
        operation.operation_id,
        taskGid,
        "merge_conflict",
        asanaChanged ? "possible" : "none",
      );
    }
    if (metadataState === "after" && coreState === "after" && !asanaChanged) {
      return dependencies.createResult(
        operation.operation_id,
        taskGid,
        "already_applied",
        "already_applied",
      );
    }
    if (metadataState !== "after") {
      task = await dependencies.readTask(taskGid, signal);
      const beforeWriteExternalResult = dependencies.validateCurrentExternal(
        dependencies.readCurrentExternal(task),
        baselineExternal,
      );
      if (beforeWriteExternalResult.kind === "conflict") {
        return dependencies.externalConflictResult(
          operation.operation_id,
          taskGid,
          beforeWriteExternalResult.reason_code,
          asanaChanged ? "possible" : "none",
        );
      }
      metadataState = dependencies.classifyExternalMetadata(
        operation,
        baselineExternal.data,
        beforeWriteExternalResult.value.data,
        mappings,
        input.activity_date,
      );
      if (metadataState === "conflict") {
        return dependencies.externalConflictResult(
          operation.operation_id,
          taskGid,
          "merge_conflict",
          asanaChanged ? "possible" : "none",
        );
      }
      if (metadataState !== "after") {
        if (!dependencies.taskHasProject(task, input.project_gid)) {
          return dependencies.createConflictResult(
            operation.operation_id,
            taskGid,
            "baseline_changed",
            asanaChanged ? "possible" : "none",
          );
        }
        const coreStateBeforeExternal = dependencies.classifyOperation(
          operation,
          task,
          input,
          mappings,
          tags,
        );
        if (coreStateBeforeExternal !== "after") {
          return dependencies.createConflictResult(
            operation.operation_id,
            taskGid,
            "read_back_mismatch",
            asanaChanged ? "possible" : "none",
          );
        }
        const externalPlan = dependencies.mergeExternalPlan(
          baselineExternal,
          beforeWriteExternalResult.value,
          externalOperations,
          input.device_id,
        );
        if (externalPlan.kind === "conflict") {
          return dependencies.externalConflictResult(
            operation.operation_id,
            taskGid,
            externalPlan.reason_code,
            asanaChanged ? "possible" : "none",
          );
        }
        if (externalPlan.kind !== "ready") {
          throw new Error("Custom external dataのマージ結果がありません。");
        }
        if (externalPlan.write) {
          onWriteAttempt("update_task");
          await dependencies.writeExternalData(
            taskGid,
            beforeWriteExternalResult.value.response.gid,
            externalPlan.serialized,
            signal,
          );
          externalChanged = true;
        }
      }
    }
  }
  if (!asanaChanged && !externalChanged && coreState === "after") {
    return dependencies.createResult(operation.operation_id, taskGid, "already_applied", "already_applied");
  }

  task = await dependencies.readTask(taskGid, signal);
  const readBackCoreState = dependencies.classifyOperation(
    operation,
    task,
    input,
    mappings,
    tags,
  );
  if (readBackCoreState !== "after") {
    return dependencies.createConflictResult(
      operation.operation_id,
      taskGid,
      "read_back_mismatch",
      "possible",
    );
  }
  if (dependencies.operationUsesExternalData(operation)) {
    if (baselineExternal == null) {
      throw new Error("この操作にはbaseline外部データが必要です。");
    }
    const readBackExternal = dependencies.validateCurrentExternal(
      dependencies.readCurrentExternal(task),
      baselineExternal,
    );
    if (readBackExternal.kind === "conflict") {
      return dependencies.externalConflictResult(
        operation.operation_id,
        taskGid,
        readBackExternal.reason_code,
        "possible",
      );
    }
    const readBackMetadataState = dependencies.classifyExternalMetadata(
      operation,
      baselineExternal.data,
      readBackExternal.value.data,
      mappings,
      input.activity_date,
    );
    if (readBackMetadataState !== "after") {
      return dependencies.createConflictResult(
        operation.operation_id,
        taskGid,
        "read_back_mismatch",
        "possible",
      );
    }
  }
  if (!asanaChanged && !externalChanged && coreState === "after") {
    return dependencies.createResult(operation.operation_id, taskGid, "already_applied", "already_applied");
  }
  return dependencies.createResult(operation.operation_id, taskGid, "applied", "applied");
}
