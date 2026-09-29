import { externalTaskGidSchema } from "../../domain/primitives";
import { customExternalDataSchema } from "../../domain/schemas";
import { canonicalizeJson } from "../../domain/canonical-json";
import type { TaskWriteExternalBaseline } from "../common/task-write-step";

type ExternalTask = {
  readonly external: { readonly gid: string; readonly data: string } | null;
};

type StoredBaseline = Extract<TaskWriteExternalBaseline, { readonly kind: "stored" }>;

export type GuiExternalBaseline =
  | { readonly kind: "valid"; readonly baseline: StoredBaseline }
  | { readonly kind: "conflict"; readonly reason_code: "external_unreadable" | "external_identity_mismatch" };

/** GUI編集の基準Custom external dataを保存用値へ変換します。 */
export function guiExternalBaseline(task: ExternalTask): GuiExternalBaseline {
  if (task.external == null) return { kind: "conflict", reason_code: "external_unreadable" };
  const gid = externalTaskGidSchema.safeParse(task.external.gid);
  if (!gid.success) return { kind: "conflict", reason_code: "external_unreadable" };
  let decoded: unknown;
  try {
    decoded = JSON.parse(task.external.data);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { kind: "conflict", reason_code: "external_unreadable" };
  }
  const data = customExternalDataSchema.safeParse(decoded);
  if (!data.success || canonicalizeJson(data.data) !== task.external.data) {
    return { kind: "conflict", reason_code: "external_unreadable" };
  }
  if (gid.data !== `TaskHub:v1:task:${data.data.id}`) {
    return { kind: "conflict", reason_code: "external_identity_mismatch" };
  }
  return { kind: "valid", baseline: { kind: "stored", external_gid: gid.data, data: data.data } };
}
