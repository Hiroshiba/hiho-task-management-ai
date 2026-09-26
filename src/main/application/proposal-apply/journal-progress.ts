export type JournalStage =
  | "prepared"
  | "started"
  | "write_started"
  | "task_created"
  | "attributes_applied"
  | "relations_applied"
  | "read_back"
  | "metadata_verified"
  | "ranking_recalculated"
  | "legacy_unresolved";

type JournalEntry = {
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly stage: JournalStage;
};

export type JournalProgressPort = {
  readonly updateStage: (
    proposalId: string,
    operationId: string,
    stage: JournalStage,
  ) => void;
  readonly complete: (
    proposalId: string,
    operationId: string,
    result: "applied" | "not_applied" | "unknown" | "failed",
  ) => void;
};

type WriteResult =
  | { readonly outcome: "applied" | "already_applied" }
  | { readonly outcome: "conflict"; readonly side_effect: "none" | "possible" };

export const journalStages: readonly JournalStage[] = [
  "prepared",
  "write_started",
  "task_created",
  "attributes_applied",
  "relations_applied",
  "read_back",
  "metadata_verified",
  "ranking_recalculated",
];

/** 保存済みの適用段階から外部作用の確度を判定します。 */
export function effectCertaintyForJournalStage(
  stage: JournalStage,
): "none" | "possible" | "confirmed" {
  if (stage === "prepared") {
    return "none";
  }
  if (journalStages.indexOf(stage) >= journalStages.indexOf("read_back")) {
    return "confirmed";
  }
  return "possible";
}

/** 適用ジャーナルの段階を保存しながら前進させます。 */
export function advanceJournal(
  journal: Pick<JournalProgressPort, "updateStage">,
  entry: JournalEntry,
  targetStage: JournalStage,
  onStagePersisted: (stage: JournalStage) => void,
): void {
  const currentIndex = journalStages.indexOf(entry.stage);
  const targetIndex = journalStages.indexOf(targetStage);
  if (currentIndex < 0 || targetIndex < 0) {
    throw new Error("適用ジャーナルの段階が不正です。");
  }
  if (targetIndex < currentIndex) {
    throw new Error("適用ジャーナルの段階を後退させられません。");
  }
  for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
    const stage = journalStages[index];
    if (stage == null) {
      throw new Error("適用ジャーナルの段階が見つかりません。");
    }
    journal.updateStage(entry.proposal_id, entry.operation_id, stage);
    onStagePersisted(stage);
  }
}

/** 書き込み結果を読み戻しとメタデータ確認まで保存します。 */
export function recordJournalResultBeforeRanking(
  journal: JournalProgressPort,
  entry: JournalEntry,
  result: WriteResult,
  onStagePersisted: (stage: JournalStage) => void,
): boolean {
  if (result.outcome === "conflict") {
    if (result.side_effect === "possible") {
      return false;
    }
    journal.complete(entry.proposal_id, entry.operation_id, "not_applied");
    return false;
  }
  let stage = entry.stage;
  const verificationStages: readonly JournalStage[] = ["read_back", "metadata_verified"];
  for (const targetStage of verificationStages) {
    if (journalStages.indexOf(targetStage) <= journalStages.indexOf(stage)) {
      continue;
    }
    journal.updateStage(entry.proposal_id, entry.operation_id, targetStage);
    stage = targetStage;
    onStagePersisted(stage);
  }
  return true;
}
