export type TargetIdentity =
  | { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };

export type ParentIdentity =
  | { readonly kind: "absent" }
  | TargetIdentity;

export type DueValue =
  | { readonly kind: "absent" }
  | { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string };

export type TemporaryResolution =
  | { readonly kind: "journal"; readonly gid: string }
  | { readonly kind: "selected_create" };

type DurationValue = { readonly value: number; readonly unit: string } | { readonly kind: "absent" };
type ComparableDependencyLike<TScope extends string = string> = {
  readonly target: TargetIdentity;
  readonly scope: TScope;
  readonly source: string;
};
type ObsidianLinkLike = { readonly vault_id: string; readonly path: string };
type ObsidianOperationLike =
  | { readonly operation: "link_obsidian"; readonly after: ObsidianLinkLike }
  | { readonly operation: "unlink_obsidian"; readonly before: ObsidianLinkLike };

/** 承認時の値比較と一時参照解決を組み立てます。 */
export function createApprovalComparison(canonicalizeJson: (value: unknown) => string) {
  function compareStrings(left: string, right: string): number {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  }

  function sortUniqueStrings(values: readonly string[]): string[] {
    return [...new Set(values)].sort(compareStrings);
  }

  function targetIdentityFromTask(task: { readonly parent_gid?: string | undefined }): ParentIdentity {
    if (task.parent_gid == null) {
      return { kind: "absent" };
    }
    return { kind: "existing", gid: task.parent_gid };
  }

  function taskDueValue(task: { readonly due_on?: string | undefined; readonly due_at?: string | undefined }): DueValue {
    if (task.due_on != null) {
      return { kind: "due_on", due_on: task.due_on };
    }
    if (task.due_at != null) {
      return { kind: "due_at", due_at: task.due_at };
    }
    return { kind: "absent" };
  }

  function sameTargetIdentity(
    left: TargetIdentity,
    right: TargetIdentity,
  ): boolean {
    if (left.kind !== right.kind) {
      return false;
    }
    if (left.kind === "existing" && right.kind === "existing") {
      return left.gid === right.gid;
    }
    if (left.kind === "temporary" && right.kind === "temporary") {
      return left.ref === right.ref;
    }
    return false;
  }

  function sameParentIdentity(
    left: ParentIdentity,
    right: ParentIdentity,
  ): boolean {
    if (left.kind === "absent" || right.kind === "absent") {
      return left.kind === right.kind;
    }
    return sameTargetIdentity(left, right);
  }

  function sameDueValue(left: DueValue, right: DueValue): boolean {
    if (left.kind !== right.kind) {
      return false;
    }
    if (left.kind === "absent" && right.kind === "absent") {
      return true;
    }
    if (left.kind === "due_on" && right.kind === "due_on") {
      return left.due_on === right.due_on;
    }
    if (left.kind === "due_at" && right.kind === "due_at") {
      return left.due_at === right.due_at;
    }
    return false;
  }

  function sameDurationValue(
    left: DurationValue,
    right: DurationValue,
  ): boolean {
    if ("kind" in left || "kind" in right) {
      return "kind" in left && "kind" in right;
    }
    return left.value === right.value && left.unit === right.unit;
  }

  function dependencyKey(dependency: ComparableDependencyLike): string {
    return canonicalizeJson(dependency);
  }

  function sameDependencies(
    left: readonly ComparableDependencyLike[],
    right: readonly ComparableDependencyLike[],
  ): boolean {
    if (left.length !== right.length) {
      return false;
    }
    const leftKeys = left.map(dependencyKey).sort(compareStrings);
    const rightKeys = right.map(dependencyKey).sort(compareStrings);
    return leftKeys.every((key, index) => key === rightKeys[index]);
  }

  function obsidianLinkKey(link: ObsidianLinkLike): string {
    return canonicalizeJson([link.vault_id, link.path]);
  }

  function sameObsidianLinks(
    left: readonly ObsidianLinkLike[],
    right: readonly ObsidianLinkLike[],
  ): boolean {
    if (left.length !== right.length) {
      return false;
    }
    const leftByKey = new Map(left.map((link) => [obsidianLinkKey(link), link]));
    const rightByKey = new Map(right.map((link) => [obsidianLinkKey(link), link]));
    if (leftByKey.size !== rightByKey.size) {
      return false;
    }
    for (const [key, leftLink] of leftByKey) {
      const rightLink = rightByKey.get(key);
      if (rightLink == null || canonicalizeJson(leftLink) !== canonicalizeJson(rightLink)) {
        return false;
      }
    }
    return true;
  }

  function resolveTargetIdentity(
    target: TargetIdentity,
    resolutions: ReadonlyMap<string, TemporaryResolution>,
  ): TargetIdentity | undefined {
    if (target.kind === "existing") {
      return { kind: "existing", gid: target.gid };
    }
    const resolution = resolutions.get(target.ref);
    if (resolution == null) {
      return undefined;
    }
    if (resolution.kind === "journal") {
      return { kind: "existing", gid: resolution.gid };
    }
    return { kind: "temporary", ref: target.ref };
  }

  function requireTargetIdentity(
    target: TargetIdentity,
    resolutions: ReadonlyMap<string, TemporaryResolution>,
  ): TargetIdentity {
    const resolved = resolveTargetIdentity(target, resolutions);
    if (resolved == null) {
      throw new Error("一時参照先を解決できません。");
    }
    return resolved;
  }

  function resolveParentIdentity(
    value: ParentIdentity,
    resolutions: ReadonlyMap<string, TemporaryResolution>,
  ): ParentIdentity {
    if (value.kind === "absent") {
      return { kind: "absent" };
    }
    return requireTargetIdentity(value, resolutions);
  }

  function resolveDependencies<TScope extends string>(
    dependencies: readonly ComparableDependencyLike<TScope>[],
    resolutions: ReadonlyMap<string, TemporaryResolution>,
  ): readonly ComparableDependencyLike<TScope>[] {
    return dependencies.map((dependency) => ({
      target: requireTargetIdentity(dependency.target, resolutions),
      scope: dependency.scope,
      source: dependency.source,
    }));
  }

  function findObsidianLink(
    links: readonly ObsidianLinkLike[],
    target: ObsidianLinkLike,
  ): ObsidianLinkLike | undefined {
    const key = obsidianLinkKey(target);
    return links.find((link) => obsidianLinkKey(link) === key);
  }

  function classifyObsidianOperation(
    operation: ObsidianOperationLike,
    task: { readonly obsidian_links: readonly ObsidianLinkLike[] },
  ): "applicable" | "already_applied" | "field_changed" {
    const target = operation.operation === "link_obsidian"
      ? operation.after
      : operation.before;
    const current = findObsidianLink(task.obsidian_links, target);
    if (current == null) {
      return operation.operation === "link_obsidian"
        ? "applicable"
        : "already_applied";
    }
    if (canonicalizeJson(current) !== canonicalizeJson(target)) {
      return "field_changed";
    }
    return operation.operation === "link_obsidian"
      ? "already_applied"
      : "applicable";
  }

  return {
    compareStrings,
    sortUniqueStrings,
    targetIdentityFromTask,
    taskDueValue,
    sameTargetIdentity,
    sameParentIdentity,
    sameDueValue,
    sameDurationValue,
    sameDependencies,
    sameObsidianLinks,
    findObsidianLink,
    resolveTargetIdentity,
    requireTargetIdentity,
    resolveParentIdentity,
    resolveDependencies,
    classifyObsidianOperation,
  };
}
