import type { ProposalViewDto } from "../../../shared/ipc-contracts/proposal-values";
import { jstDateTimeLabel } from "../../shared/format/date-time";
import type { ProposalOperation } from "./proposal-presentation";
import { durationLabel, importanceLabel, parentWorkModeLabel, statusLabel } from "./proposal-presentation";

type TaskTitleReference = { readonly gid: string; readonly title: string };
type TaskLabelCandidate = { readonly title: string };
type CreateTaskOperation = Extract<ProposalOperation, { operation: "create_task" }>;
type ProposalTarget = Extract<ProposalOperation, { operation: "update_title" }>["target"];
type ProposalDueValue = Extract<ProposalOperation, { operation: "set_due" }>["before"];
type ProposalDurationValue = Extract<ProposalOperation, { operation: "set_duration" }>["before"];
type ProposalParentValue = Extract<ProposalOperation, { operation: "set_parent" }>["before"];
type ProposalDependency = Extract<ProposalOperation, { operation: "set_dependencies" }>["after"][number];
type CreateTaskFields = CreateTaskOperation["after"];
type ObsidianLink = Extract<ProposalOperation, { operation: "link_obsidian" }>["after"];
type RankChange = ProposalViewDto["impact"]["rank_changes"][number];

/** 変更案の操作、根拠、対象タスクを表示する値を作ります。 */
export function useProposalReviewPresentation(
  tasks: () => readonly TaskTitleReference[],
  selectTask: (gid: string) => void,
) {
function taskReferenceLabel(
  kind: "タスク" | "新規タスク",
  title: string,
  reference: string,
  candidates: readonly TaskLabelCandidate[],
  referenceKind: "ID" | "一時参照",
  includeReference: boolean,
): string {
  const hasDuplicateTitle = candidates.filter((candidate) => candidate.title === title).length > 1;
  let suffix = "";
  if (includeReference || hasDuplicateTitle) {
    suffix = `・${referenceKind} ${reference}`;
  }
  return `${kind}「${title}」${suffix}`;
}

function taskLabel(gid: string, includeReference: boolean): string {
  const task = tasks().find((candidate) => candidate.gid === gid);
  if (task == null) {
    return `タスク名未取得・ID ${gid}`;
  }
  return taskReferenceLabel("タスク", task.title, task.gid, tasks(), "ID", includeReference);
}

function createTaskOperations(proposal: ProposalViewDto): readonly CreateTaskOperation[] {
  return proposal.groups
    .flatMap((group) => group.operations)
    .filter((operation): operation is CreateTaskOperation => operation.operation === "create_task");
}

function createTaskOperationForRef(
  proposal: ProposalViewDto,
  temporaryRef: string,
): CreateTaskOperation {
  const operation = createTaskOperations(proposal)
    .find((candidate) => candidate.temporary_ref === temporaryRef);
  if (operation == null) {
    throw new Error("一時参照に対応するタスク作成操作がありません。");
  }
  return operation;
}

function createTaskLabel(
  proposal: ProposalViewDto,
  operation: CreateTaskOperation,
  includeReference: boolean,
): string {
  return taskReferenceLabel(
    "新規タスク",
    operation.after.title,
    operation.temporary_ref,
    createTaskOperations(proposal).map((candidate) => candidate.after),
    "一時参照",
    includeReference,
  );
}

function targetReferenceLabel(
  proposal: ProposalViewDto,
  target: ProposalTarget,
): string {
  if (target.kind === "existing") {
    return taskLabel(target.gid, false);
  }
  const createOperation = createTaskOperationForRef(proposal, target.ref);
  return createTaskLabel(proposal, createOperation, false);
}

function targetLabel(
  proposal: ProposalViewDto,
  operation: ProposalOperation,
): string {
  if (operation.operation === "create_task") {
    return createTaskLabel(proposal, operation, false);
  }
  return targetReferenceLabel(proposal, operation.target);
}

function targetDetailLabel(
  proposal: ProposalViewDto,
  operation: ProposalOperation,
): string {
  if (operation.operation === "create_task") {
    return createTaskLabel(proposal, operation, true);
  }
  if (operation.target.kind === "existing") {
    return taskLabel(operation.target.gid, true);
  }
  return createTaskLabel(proposal, createTaskOperationForRef(proposal, operation.target.ref), true);
}

function rankTaskLabel(proposal: ProposalViewDto, gid: string): string {
  const temporaryPrefix = "temporary:";
  if (!gid.startsWith(temporaryPrefix)) {
    return taskLabel(gid, false);
  }
  const temporaryRef = gid.slice(temporaryPrefix.length);
  if (temporaryRef.length === 0) {
    throw new Error("順位影響の一時参照が空です。");
  }
  const createOperation = createTaskOperationForRef(proposal, temporaryRef);
  return createTaskLabel(proposal, createOperation, false);
}

function notesValueLabel(value: string): string {
  return value.trim().length === 0 ? "なし" : value;
}

function dueAtLabel(value: string): string {
  return `日時 ${jstDateTimeLabel(value)} JST`;
}

function dueValueLabel(value: ProposalDueValue): string {
  switch (value.kind) {
    case "absent":
      return "期限なし";
    case "due_on":
      return `日付 ${value.due_on}`;
    case "due_at":
      return dueAtLabel(value.due_at);
  }
}

function durationValueLabel(value: ProposalDurationValue): string {
  if ("kind" in value) {
    return "未設定";
  }
  return durationLabel(value);
}

function dependencyScopeLabel(scope: ProposalDependency["scope"]): string {
  return scope === "full" ? "完全依存" : "一部依存";
}

function dependencyLines(
  proposal: ProposalViewDto,
  dependencies: readonly ProposalDependency[],
): readonly string[] {
  if (dependencies.length === 0) {
    return ["依存先: なし"];
  }
  return dependencies.map((dependency, index) =>
    `依存先${index + 1}: ${targetReferenceLabel(proposal, dependency.target)}・${dependencyScopeLabel(dependency.scope)}・根拠 ${dependency.source}`);
}

function parentValueLabel(
  proposal: ProposalViewDto,
  value: ProposalParentValue,
): string {
  if (value.kind === "absent") {
    return "親タスクなし";
  }
  return `親 ${targetReferenceLabel(proposal, value)}`;
}

function obsidianLinkLabel(link: ObsidianLink): string {
  return `${link.title}・Vault ${link.vault_id}・パス ${link.path}・信頼度 ${Math.round(link.confidence * 100)}%`;
}

function createTaskFieldsLines(
  proposal: ProposalViewDto,
  fields: CreateTaskFields,
): readonly string[] {
  const lines = [`タイトル: ${fields.title}`];
  if (fields.notes != null) {
    lines.push(`説明: ${notesValueLabel(fields.notes)}`);
  }
  if (fields.status != null) {
    lines.push(`状態: ${statusLabel(fields.status)}`);
  }
  if (fields.importance != null) {
    lines.push(`重要度: ${importanceLabel(fields.importance)}`);
  }
  if (fields.area != null) {
    lines.push(`領域: ${fields.area}`);
  }
  if (fields.due != null) {
    lines.push(`期限: ${dueValueLabel(fields.due)}`);
  }
  if (fields.duration != null) {
    lines.push(`所要時間: ${durationLabel(fields.duration)}`);
  }
  if (fields.parent != null) {
    lines.push(`親タスク: ${targetReferenceLabel(proposal, fields.parent)}`);
  }
  if (fields.parent_work_mode != null) {
    lines.push(`親作業モード: ${parentWorkModeLabel(fields.parent_work_mode)}`);
  }
  if (fields.dependencies != null) {
    lines.push(...dependencyLines(proposal, fields.dependencies));
  }
  if (fields.obsidian_links != null) {
    if (fields.obsidian_links.length === 0) {
      lines.push("Obsidianリンク: なし");
    } else {
      fields.obsidian_links.forEach((link, index) => {
        lines.push(`Obsidianリンク${index + 1}: ${obsidianLinkLabel(link)}`);
      });
    }
  }
  return lines;
}

function operationValueLines(
  proposal: ProposalViewDto,
  operation: ProposalOperation,
  side: "before" | "after",
): readonly string[] {
  switch (operation.operation) {
    case "create_task":
      return side === "before" ? ["未作成"] : createTaskFieldsLines(proposal, operation.after);
    case "update_title":
      return [side === "before" ? operation.before : operation.after];
    case "update_notes":
      return [notesValueLabel(side === "before" ? operation.before : operation.after)];
    case "set_status":
      return [statusLabel(side === "before" ? operation.before : operation.after)];
    case "set_importance":
      return [importanceLabel(side === "before" ? operation.before : operation.after)];
    case "set_due":
      return [dueValueLabel(side === "before" ? operation.before : operation.after)];
    case "clear_due":
      return [dueValueLabel(side === "before" ? operation.before : operation.after)];
    case "set_duration":
      return [durationValueLabel(side === "before" ? operation.before : operation.after)];
    case "clear_duration":
      return [durationValueLabel(side === "before" ? operation.before : operation.after)];
    case "set_area":
      return [side === "before" ? operation.before : operation.after];
    case "set_dependencies":
      return dependencyLines(
        proposal,
        side === "before" ? operation.before : operation.after,
      );
    case "set_parent":
      return [parentValueLabel(proposal, side === "before" ? operation.before : operation.after)];
    case "set_parent_work_mode":
      return [parentWorkModeLabel(side === "before" ? operation.before : operation.after)];
    case "link_obsidian":
      return side === "before"
        ? ["Obsidianリンクなし"]
        : [obsidianLinkLabel(operation.after)];
    case "unlink_obsidian":
      return side === "before"
        ? [obsidianLinkLabel(operation.before)]
        : ["Obsidianリンクなし"];
    case "complete":
      return [statusLabel(side === "before" ? operation.before : operation.after)];
    case "withdraw":
      return [statusLabel(side === "before" ? operation.before : operation.after)];
  }
}

function rankPositionLabel(state: RankChange["before_state"], rank: number | undefined): string {
  if (state === "ranked") {
    if (rank == null) {
      throw new Error("順位付き変更に順位がありません。");
    }
    return `順位${rank}`;
  }
  if (rank != null) {
    throw new Error("順位なしの変更に順位が指定されています。");
  }
  switch (state) {
    case "excluded":
      return "順位対象外";
    case "not_present":
      return "一覧対象外";
  }
}

function targetGid(operation: ProposalOperation): string | undefined {
  if (operation.operation === "create_task" || operation.target.kind !== "existing") {
    return undefined;
  }
  return operation.target.gid;
}

function selectExistingTask(operation: ProposalOperation): void {
  const gid = targetGid(operation);
  if (gid == null) {
    throw new Error("既存タスクの対象が見つかりません。");
  }
  selectTask(gid);
}

type ProposalTaskTarget =
  | { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };

function addExistingTaskGid(target: ProposalTaskTarget, gids: Set<string>): void {
  if (target.kind === "existing") {
    gids.add(target.gid);
  }
}

function relatedTaskGids(operation: ProposalOperation): string[] {
  const gids = new Set<string>();
  if (operation.operation !== "create_task") {
    addExistingTaskGid(operation.target, gids);
  }
  switch (operation.operation) {
    case "create_task":
      if (operation.creation.kind === "split_child") {
        addExistingTaskGid(operation.creation.parent, gids);
      }
      if (operation.after.parent != null) {
        addExistingTaskGid(operation.after.parent, gids);
      }
      operation.after.dependencies?.forEach((dependency) => {
        addExistingTaskGid(dependency.target, gids);
      });
      break;
    case "set_dependencies":
      operation.before.forEach((dependency) => {
        addExistingTaskGid(dependency.target, gids);
      });
      operation.after.forEach((dependency) => {
        addExistingTaskGid(dependency.target, gids);
      });
      break;
    case "set_parent":
      if (operation.before.kind !== "absent") {
        addExistingTaskGid(operation.before, gids);
      }
      if (operation.after.kind !== "absent") {
        addExistingTaskGid(operation.after, gids);
      }
      break;
    default:
      break;
  }
  const operationGid = targetGid(operation);
  return [...gids].filter((gid) => gid !== operationGid);
}

  return {
    createTaskOperations,
    taskLabel,
    targetLabel,
    targetDetailLabel,
    rankTaskLabel,
    operationValueLines,
    rankPositionLabel,
    targetGid,
    selectExistingTask,
    relatedTaskGids,
  };
}
