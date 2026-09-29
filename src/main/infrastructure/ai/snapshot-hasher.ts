import { createHash } from "node:crypto";
import type { SnapshotHasher } from "../../application/common/ports/snapshot-hasher";
import {
  canonicalizeBaselineSnapshotForHash,
  canonicalizeGuiEditBaselineForHash,
  snapshotHashSchema,
} from "../../domain";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 正規化したスナップショットを同期SHA-256でハッシュ化するportを作ります。 */
export function createSnapshotHasher(): SnapshotHasher {
  return {
    hashBaselineSnapshot: (snapshot) => sha256(canonicalizeBaselineSnapshotForHash(snapshot)),
    hashGuiEditBaseline: (task) => snapshotHashSchema.parse(
      sha256(canonicalizeGuiEditBaselineForHash(task)),
    ),
  };
}
