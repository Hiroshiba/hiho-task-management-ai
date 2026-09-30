import type { AsanaTaskResponse, BaselineSnapshot, SnapshotHash } from "../../../domain";

/** 保存済みスナップショットとGUI編集基準値の同期ハッシュ計算境界です。 */
export interface SnapshotHasher {
  hashBaselineSnapshot(snapshot: BaselineSnapshot): string;
  hashGuiEditBaseline(task: AsanaTaskResponse): SnapshotHash;
}
