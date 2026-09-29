import { type ProposalWriteOperation } from "../../domain/proposal-write-operation";
import { canonicalizeJson } from "../../domain/canonical-json";
import { type TaskWriteExternalBaseline, type TaskWriteStep, type TaskWriteTarget } from "./task-write-step";

type CreatePayload = Extract<TaskWriteStep, { kind: "asana_create_task" }>["payload"];
type Dependency = Extract<ProposalWriteOperation, { operation: "set_dependencies" }>["before"][number];
type NonCreateOperation = Exclude<ProposalWriteOperation, { operation: "create_task" }>;

function targetKey(target: TaskWriteTarget, knownReferences: ReadonlyMap<string, string>): string {
  if (target.kind === "existing") {
    return `existing:${target.gid}`;
  }
  const taskGid = knownReferences.get(target.ref);
  return taskGid == null ? `temporary:${target.ref}` : `existing:${taskGid}`;
}

function dependencyKeys(
  dependencies: readonly Dependency[],
  knownReferences: ReadonlyMap<string, string>,
): readonly string[] {
  return dependencies.map((dependency) => canonicalizeJson({
    target: targetKey(dependency.target, knownReferences),
    scope: dependency.scope,
    source: dependency.source,
  })).sort();
}

function sameDependencies(
  before: readonly Dependency[],
  baseline: readonly Dependency[],
  knownReferences: ReadonlyMap<string, string>,
): boolean {
  return canonicalizeJson(dependencyKeys(before, knownReferences))
    === canonicalizeJson(dependencyKeys(baseline, knownReferences));
}

/** 操作の外部データ変更前値を承認時baselineと照合します。 */
export function operationMatchesExternalBaseline(
  operation: NonCreateOperation,
  baseline: TaskWriteExternalBaseline,
  knownReferences: ReadonlyMap<string, string>,
  createPayload: CreatePayload | undefined,
): boolean {
  if (baseline.kind === "created_task" && createPayload == null) {
    return false;
  }
  switch (operation.operation) {
    case "set_duration":
    case "clear_duration": {
      const duration = baseline.kind === "stored" ? baseline.data.duration : createPayload?.initial_external.duration;
      return "kind" in operation.before
        ? duration == null
        : duration != null && canonicalizeJson(operation.before) === canonicalizeJson(duration);
    }
    case "set_dependencies": {
      if (baseline.kind === "created_task") {
        if (createPayload == null) {
          return false;
        }
        return sameDependencies(operation.before, createPayload.initial_external.dependencies, knownReferences);
      }
      const storedDependencies: Dependency[] = baseline.data.dependencies.map((dependency) => ({
        target: { kind: "existing", gid: dependency.task_gid },
        scope: dependency.scope,
        source: dependency.source,
      }));
      return operation.before.every((dependency) => dependency.target.kind === "existing"
        || knownReferences.has(dependency.target.ref))
        && sameDependencies(operation.before, storedDependencies, knownReferences);
    }
    case "set_parent_work_mode": {
      const parentWorkMode = baseline.kind === "stored" ? baseline.data.parent_work_mode : createPayload?.initial_external.parent_work_mode;
      return operation.before === parentWorkMode;
    }
    case "link_obsidian": {
      const obsidianLinks = baseline.kind === "stored" ? baseline.data.obsidian_links : createPayload?.initial_external.obsidian_links;
      return obsidianLinks != null && !obsidianLinks.some((link) => link.vault_id === operation.after.vault_id
        && link.path === operation.after.path);
    }
    case "unlink_obsidian": {
      const obsidianLinks = baseline.kind === "stored" ? baseline.data.obsidian_links : createPayload?.initial_external.obsidian_links;
      const existing = obsidianLinks?.find((link) => link.vault_id === operation.before.vault_id
        && link.path === operation.before.path);
      return existing != null
        && canonicalizeJson(existing) === canonicalizeJson(operation.before);
    }
    case "update_title":
    case "update_notes":
    case "set_status":
    case "set_importance":
    case "set_due":
    case "clear_due":
    case "set_area":
    case "set_parent":
    case "complete":
    case "withdraw":
      return true;
  }
}
