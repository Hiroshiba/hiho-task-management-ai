/** 実行結果の理由コードを日本語で表示します。 */
export function reasonCodeLabel(reasonCode: string): string {
  switch (reasonCode) {
    case "applied":
    case "mock_applied": return "反映済み";
    case "already_applied":
    case "mock_already_applied": return "既に反映済み";
    case "approval_conflict": return "承認時の状態と一致しません";
    case "atomic_group_blocked": return "一括適用グループを反映できません";
    case "writer_conflict":
    case "baseline_changed": return "基準データが変更されました";
    case "external_id_collision": return "外部IDが衝突しています";
    case "recovery_required": return "復旧が必要です";
    case "recovery_context_missing": return "復旧用データがありません";
    case "task_not_found": return "対象タスクが見つかりません";
    case "duplicate_external_id": return "外部IDが重複しています";
    case "journal_target_mismatch": return "実行記録の対象が一致しません";
    case "external_api_failed": return "外部サービスへの反映に失敗しました";
    case "local_resync_required": return "ローカル同期が必要です";
    case "write_failed": return "書き込みに失敗しました";
    case "write_unconfirmed":
    case "mock_result_unknown": return "書き込み結果を確認できません";
    case "relationship_cycle": return "依存関係が循環します";
    case "external_unreadable": return "外部データを読み取れません";
    case "external_identity_mismatch": return "外部データの対象が一致しません";
    case "offline": return "オフラインのため反映できません";
    default: throw new Error("未知の実行理由コードです。");
  }
}
