import type { CustomExternalDataMergeInput } from "../../domain";

type ExternalData = CustomExternalDataMergeInput["baseline"];
type Dependency = ExternalData["dependencies"][number];
type Duration = NonNullable<ExternalData["duration"]>;
type ObsidianLink = ExternalData["obsidian_links"][number];
type Due = { readonly kind: "absent" }
  | { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string };

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sortByKey<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): T[] {
  return [...values].sort((left, right) => compareStrings(keyOf(left), keyOf(right)));
}

/** 依存関係の順序を無視して同じ集合か判定します。 */
export function sameDependencies(
  left: readonly Dependency[],
  right: readonly Dependency[],
  canonicalizeJson: (value: unknown) => string,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const dependencyKey = (value: Dependency): string => canonicalizeJson(value);
  const leftKeys = sortByKey(left, dependencyKey).map(dependencyKey);
  const rightKeys = sortByKey(right, dependencyKey).map(dependencyKey);
  return leftKeys.every((value, index) => value === rightKeys[index]);
}

/** Obsidianリンクの識別子を作ります。 */
export function obsidianKey(value: ObsidianLink): string {
  return `${value.vault_id}\u0000${value.path}`;
}

/** Obsidianリンクの全属性が一致するか判定します。 */
export function sameObsidianLink(
  left: ObsidianLink,
  right: ObsidianLink,
  canonicalizeJson: (value: unknown) => string,
): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

/** 識別子に一致するObsidianリンクを探します。 */
export function findObsidianLink(
  links: readonly ObsidianLink[],
  target: ObsidianLink,
): ObsidianLink | undefined {
  return links.find((link) => obsidianKey(link) === obsidianKey(target));
}

/** 期限の種類と値が一致するか判定します。 */
export function sameDueProposalValue(
  left: Due,
  right: Due,
  canonicalizeJson: (value: unknown) => string,
): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

/** absentを所要時間の未設定値へ変換します。 */
export function optionalDuration(value: Duration | { readonly kind: "absent" }): Duration | undefined {
  if ("kind" in value) {
    return undefined;
  }
  return value;
}

/** 所要時間の設定状態と値が一致するか判定します。 */
export function sameDurationValue(
  left: Duration | undefined,
  right: Duration | undefined,
  canonicalizeJson: (value: unknown) => string,
): boolean {
  if (left == null || right == null) {
    return left == null && right == null;
  }
  return canonicalizeJson(left) === canonicalizeJson(right);
}
