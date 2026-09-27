import { mappingArray } from "./application-plan";
import { type RecoverySettings } from "./recovery-plan";

type OperationContext<TOperation extends { readonly operation: string; readonly operation_id: string }> = {
  readonly group: { readonly group_id: string; readonly atomic: boolean };
  readonly operation: TOperation;
};
type PlanEntryPorts<TOperation extends { readonly operation: string; readonly operation_id: string }, TJournalOperation, TPlan, TJournal> = {
  readonly journalOperation: (operation: TOperation, uuids: ReadonlyMap<string, string>) => TJournalOperation;
  readonly parsePlan: (value: unknown) => TPlan;
  readonly parseTimestamp: (value: string) => string;
  readonly parseJournal: (value: unknown) => TJournal;
};

/** 適用前に保存する操作計画とジャーナルを組み立てます。 */
export function buildApplicationPlanEntry<TOperation extends { readonly operation: string; readonly operation_id: string }, TJournalOperation, TPlan, TJournal>(
  proposalId: string,
  context: OperationContext<TOperation>,
  target: unknown,
  groupOrder: number,
  operationOrder: number,
  settings: RecoverySettings,
  mappings: ReadonlyMap<string, string>,
  baselineSource: unknown,
  uuids: ReadonlyMap<string, string>,
  startedAt: string,
  ports: PlanEntryPorts<TOperation, TJournalOperation, TPlan, TJournal>,
): TJournal {
  const operation = context.operation;
  const journalOperation = ports.journalOperation(operation, uuids);
  const plan = ports.parsePlan({
    group_id: context.group.group_id,
    group_order: groupOrder,
    operation_order: operationOrder,
    atomic: context.group.atomic,
    project_gid: settings.project_gid,
    workspace_gid: settings.workspace_gid,
    section_gids: settings.section_gids,
    device_id: settings.device_id,
    created_via: settings.created_via,
    activity_date: settings.activity_date,
    temporary_ref_to_gid: mappingArray(mappings),
    baseline_source: baselineSource,
    operation: journalOperation,
    ...(operation.operation === "create_task"
      ? { create_uuid: uuids.get(operation.operation_id) }
      : {}),
  });
  return ports.parseJournal({
    proposal_id: proposalId,
    operation_id: operation.operation_id,
    target,
    started_at: ports.parseTimestamp(startedAt),
    stage: "prepared",
    plan,
  });
}
