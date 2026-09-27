import { baselineExternalMap, mappingArray } from "./application-plan";
import { type RecoverySettings } from "./recovery-plan";

type WriterOperation = {
  readonly operation: string;
  readonly operation_id: string;
  readonly temporary_ref?: string;
};
type WriterContext<TOperation extends WriterOperation> = {
  readonly group: { readonly group_id: string; readonly atomic: boolean };
  readonly operation: TOperation;
};
type BaselineExternal = { readonly gid: string; readonly data: string };
type BaselineSource<TData> =
  | { readonly kind: "not_used" }
  | { readonly kind: "stored"; readonly external_gid: string; readonly data: TData }
  | { readonly kind: "created_task"; readonly create_operation_id: string; readonly temporary_ref: string };
type PlannedEntry<TOperation extends WriterOperation, TData> = {
  readonly journal: {
    readonly proposal_id: string;
    readonly operation_id: string;
    readonly plan: {
      readonly baseline_source: BaselineSource<TData>;
      readonly create_uuid?: string | undefined;
    };
  };
  readonly context: WriterContext<TOperation>;
};
type WriterInput<TOperation extends WriterOperation, TTask> = RecoverySettings & {
  readonly operation: TOperation;
  readonly temporary_ref_to_gid: { readonly temporary_ref: string; readonly task_gid: string }[];
  readonly baseline_external_data?: BaselineExternal;
  readonly create_external_id?: string;
  readonly existing_task?: TTask;
};

/** 復旧時のwriter入力を保存済み設定と一時参照から組み立てます。 */
export function buildRecoveryWriterInput<TOperation extends WriterOperation, TTask>(
  context: WriterContext<TOperation>,
  settings: RecoverySettings,
  mappings: ReadonlyMap<string, string>,
  baseline: BaselineExternal | undefined,
  createUuid: string | undefined,
  existingTask: TTask | undefined,
): WriterInput<TOperation, TTask> {
  const common = {
    project_gid: settings.project_gid,
    workspace_gid: settings.workspace_gid,
    section_gids: settings.section_gids,
    device_id: settings.device_id,
    created_via: settings.created_via,
    activity_date: settings.activity_date,
    temporary_ref_to_gid: mappingArray(mappings),
  };
  if (context.operation.operation === "create_task") {
    if (createUuid == null) {
      throw new Error("create_taskの作成UUIDがありません。");
    }
    return {
      ...common,
      operation: context.operation,
      create_external_id: createUuid,
      ...(existingTask == null ? {} : { existing_task: existingTask }),
    };
  }
  if (baseline == null) {
    if (
      context.operation.operation !== "complete"
      && context.operation.operation !== "withdraw"
    ) {
      throw new Error("この操作には適用基準外部データが必要です。");
    }
    return { ...common, operation: context.operation };
  }
  return { ...common, operation: context.operation, baseline_external_data: baseline };
}

type BaselinePorts<TOperation extends WriterOperation, TData, TWriterInput> = {
  readonly serializeStored: (data: TData) => string;
  readonly createWriterInput: (context: WriterContext<TOperation>, settings: RecoverySettings, mappings: ReadonlyMap<string, string>, baseline: BaselineExternal | undefined, createUuid: string | undefined, existingTask: undefined) => TWriterInput;
  readonly createInitialExternalBaseline: (input: TWriterInput) => BaselineExternal;
};

/** 保存済み復旧計画に固定されたCustom external data基準を取得します。 */
export function resolveBaselineFromJournalPlan<TOperation extends WriterOperation, TData, TEntry extends PlannedEntry<TOperation, TData>, TWriterInput>(
  entry: TEntry,
  plannedEntries: readonly TEntry[],
  settings: RecoverySettings,
  mappings: ReadonlyMap<string, string>,
  ports: BaselinePorts<TOperation, TData, TWriterInput>,
): BaselineExternal | undefined {
  const source = entry.journal.plan.baseline_source;
  if (source.kind === "not_used") {
    return undefined;
  }
  if (source.kind === "stored") {
    return { gid: source.external_gid, data: ports.serializeStored(source.data) };
  }
  const createEntry = plannedEntries.find(
    (candidate) => candidate.journal.operation_id === source.create_operation_id,
  );
  if (
    createEntry == null
    || createEntry.journal.proposal_id !== entry.journal.proposal_id
    || createEntry.context.operation.operation !== "create_task"
    || createEntry.context.operation.temporary_ref !== source.temporary_ref
  ) {
    throw new Error("Custom external dataの作成元復旧計画が一致しません。");
  }
  const createUuid = createEntry.journal.plan.create_uuid;
  if (createUuid == null) {
    throw new Error("Custom external dataの作成元UUIDがありません。");
  }
  const createInput = ports.createWriterInput(
    createEntry.context,
    settings,
    mappings,
    undefined,
    createUuid,
    undefined,
  );
  return ports.createInitialExternalBaseline(createInput);
}

type MemoryBaselinePorts<TOperation extends WriterOperation, TEntry extends PlannedEntry<TOperation, TData>, TData> = {
  readonly targetGid: (operation: TOperation, mappings: ReadonlyMap<string, string>) => string | undefined;
  readonly baselineFromJournalPlan: (entry: TEntry, plannedEntries: readonly TEntry[], settings: RecoverySettings, mappings: ReadonlyMap<string, string>) => BaselineExternal | undefined;
};

/** 再開コンテキストのCustom external data基準と保存済み計画を照合します。 */
export function compareMemoryBaselineSource<TOperation extends WriterOperation, TData, TEntry extends PlannedEntry<TOperation, TData>>(
  application: { readonly baseline_external_data: readonly { readonly task_gid: string; readonly external: BaselineExternal }[] } | undefined,
  entry: TEntry,
  plannedEntries: readonly TEntry[],
  settings: RecoverySettings,
  mappings: ReadonlyMap<string, string>,
  ports: MemoryBaselinePorts<TOperation, TEntry, TData>,
): void {
  if (application == null) {
    return;
  }
  let taskGid: string | undefined;
  if (entry.journal.plan.baseline_source.kind === "stored") {
    taskGid = ports.targetGid(entry.context.operation, mappings);
  } else if (entry.journal.plan.baseline_source.kind === "created_task") {
    taskGid = mappings.get(entry.journal.plan.baseline_source.temporary_ref);
  }
  if (taskGid == null) {
    return;
  }
  const memoryBaseline = baselineExternalMap(application.baseline_external_data).get(taskGid);
  if (memoryBaseline == null) {
    return;
  }
  const plannedBaseline = ports.baselineFromJournalPlan(entry, plannedEntries, settings, mappings);
  if (
    plannedBaseline == null
    || memoryBaseline.gid !== plannedBaseline.gid
    || memoryBaseline.data !== plannedBaseline.data
  ) {
    throw new Error("復旧計画と再開コンテキストのCustom external data baselineが一致しません。");
  }
}
