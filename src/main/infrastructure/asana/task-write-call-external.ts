import type { z } from "zod";
import type { TaskWriteExecutionContext, TaskWriteExecutorRegistry } from "../../application/common/ports/task-write-executor";
import { mergeCustomExternalData, type CustomExternalDataMergeOperation } from "../../domain/external-data-merge";
import { canonicalizeTaskWriteJson, customExternalDataSchema } from "../../domain/task-write-values";
import type { ReadBackAsanaTask } from "./task-write-asana-response";
import { initialExternalData, readExternalData } from "./task-write-reconciliation";

type ExternalStep = Parameters<TaskWriteExecutorRegistry["asana_merge_external_data"][1]["execute"]>[0];
type TaskWriteExternalBaseline = ExternalStep["payload"]["baseline"];
type TaskWriteExternalChange = ExternalStep["payload"]["changes"][number];
type TaskWriteTarget = ExternalStep["payload"]["target"];
type ExternalData = z.infer<typeof customExternalDataSchema>;

/** Custom external dataを検証済みの正規化JSONへ変換します。 */
export function serializeTaskWriteExternalData(data: unknown): string {
  return canonicalizeTaskWriteJson(customExternalDataSchema.parse(data));
}

/** 保存済みの一時参照をAsanaタスクGIDへ解決します。 */
export function resolveTaskWriteTarget(target: TaskWriteTarget, context: TaskWriteExecutionContext): string {
  if (target.kind === "existing") return target.gid;
  const gid = context.references.get(target.ref);
  if (gid == null) throw new Error("保存済み一時参照のタスクGIDがありません。");
  return gid;
}

function baselineExternalData(
  baseline: TaskWriteExternalBaseline,
  context: TaskWriteExecutionContext,
): { readonly gid: string; readonly data: ExternalData } {
  if (baseline.kind === "stored") return { gid: baseline.external_gid, data: customExternalDataSchema.parse(baseline.data) };
  const create = context.plan.steps.find((step) => step.kind === "asana_create_task"
    && step.scope.kind === "operation"
    && step.scope.operation_id === baseline.create_operation_id
    && step.payload.target.ref === baseline.temporary_ref);
  if (create?.kind !== "asana_create_task") throw new Error("作成時external基準の作成stepがありません。");
  return {
    gid: `TaskHub:v1:task:${create.payload.create_uuid}`,
    data: customExternalDataSchema.parse(initialExternalData(create, context)),
  };
}

function dependencyValues(
  values: Extract<TaskWriteExternalChange, { readonly kind: "dependencies" }>["before"],
  context: TaskWriteExecutionContext,
): ExternalData["dependencies"] {
  return values.map((value) => ({
    task_gid: resolveTaskWriteTarget(value.target, context),
    scope: value.scope,
    source: value.source,
  })).sort((left, right) => left.task_gid.localeCompare(right.task_gid));
}

function obsidianLinkKey(link: ExternalData["obsidian_links"][number]): string {
  return `${link.vault_id}\u0000${link.path}`;
}

function mergeOperation(
  change: TaskWriteExternalChange,
  baseline: ExternalData,
  context: TaskWriteExecutionContext,
): CustomExternalDataMergeOperation {
  switch (change.kind) {
    case "duration":
      return {
        operation: "set_duration",
        before: "kind" in change.before ? undefined : change.before,
        after: "kind" in change.after ? undefined : change.after,
      };
    case "dependencies":
      return {
        operation: "set_dependencies",
        before: dependencyValues(change.before, context),
        after: dependencyValues(change.after, context),
      };
    case "parent_work_mode":
      return {
        operation: "set_parent_work_mode",
        before: change.before,
        after: change.after,
      };
    case "obsidian_links": {
      const key = obsidianLinkKey(change.link);
      const previous = baseline.obsidian_links.find((link) => obsidianLinkKey(link) === key);
      if (change.action === "add") {
        if (previous != null) throw new Error("追加するObsidianリンクが承認時基準に既にあります。");
        return {
          operation: "set_obsidian_links",
          before: baseline.obsidian_links,
          after: [...baseline.obsidian_links, change.link],
        };
      }
      if (previous == null || canonicalizeTaskWriteJson(previous) !== canonicalizeTaskWriteJson(change.link)) {
        throw new Error("解除するObsidianリンクが承認時基準と一致しません。");
      }
      return {
        operation: "set_obsidian_links",
        before: baseline.obsidian_links,
        after: baseline.obsidian_links.filter((link) => obsidianLinkKey(link) !== key),
      };
    }
    case "last_active_status":
      return {
        operation: "set_last_active_status",
        before: baseline.last_active_status,
        after: change.after,
      };
    case "activity_anchor_on":
      return {
        operation: "set_activity_anchor_on",
        before: baseline.activity_anchor_on,
        after: change.after,
      };
  }
}

/** 承認時基準と直前GETのCustom external dataを一度だけ3-wayマージします。 */
export function mergeTaskWriteExternalData(
  step: ExternalStep,
  context: TaskWriteExecutionContext,
  currentTask: ReadBackAsanaTask,
): { readonly kind: "already_applied" } | { readonly kind: "merged"; readonly external: { readonly gid: string; readonly data: string } } {
  const baseline = baselineExternalData(step.payload.baseline, context);
  const current = readExternalData(currentTask);
  if (current.kind !== "valid" || current.gid !== baseline.gid) {
    throw new Error("Custom external dataの識別子または保存形式が承認時基準と一致しません。");
  }
  const operations = step.payload.changes.map((change) => mergeOperation(change, baseline.data, context));
  const result = mergeCustomExternalData({
    baseline: baseline.data,
    current: customExternalDataSchema.parse(current.data),
    operations,
    last_writer: step.payload.device_id,
  });
  if (result.kind === "conflict") {
    throw new Error(`Custom external dataの${result.field}が同時に変更されました。`);
  }
  if (result.kind === "already_applied") return { kind: "already_applied" };
  return {
    kind: "merged",
    external: { gid: baseline.gid, data: serializeTaskWriteExternalData(result.data) },
  };
}
