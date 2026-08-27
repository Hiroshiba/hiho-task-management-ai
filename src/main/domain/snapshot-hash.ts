import { createHash } from "node:crypto";
import { canonicalizeJson } from "../../shared/domain/canonical-json";
import {
  baselineSnapshotSchema,
  type BaselineSnapshot,
} from "../../shared/domain/schemas";

/** 基準スナップショットの正規化JSONにSHA-256を適用します。 */
export function hashBaselineSnapshot(snapshot: BaselineSnapshot): string {
  const validated = baselineSnapshotSchema.parse(snapshot);
  return createHash("sha256")
    .update(canonicalizeJson(validated), "utf8")
    .digest("hex");
}
