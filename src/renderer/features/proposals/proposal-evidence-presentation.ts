import type { ProposalOperation } from "./proposal-presentation";

/** 根拠の種別を日本語で表示します。 */
export function evidenceKindLabel(kind: string): string {
  switch (kind) {
    case "user_message":
      return "ユーザーの依頼";
    case "task":
      return "タスク";
    case "obsidian":
      return "Obsidian";
    case "external_tool":
      return "外部ツール";
    case "external_review":
      return "外部セッションの依頼";
    default:
      throw new Error("未知の根拠種別です。");
  }
}

function statusEvidenceKindLabel(kind: string): string {
  switch (kind) {
    case "user_explicit":
      return "ユーザーの依頼";
    case "task_or_note_explicit":
      return "タスクまたはObsidian";
    case "external_structured_status":
      return "外部ツール";
    case "children_only_all_completed":
      return "タスク";
    case "external_review_explicit":
      return "外部セッションの依頼";
    default:
      throw new Error("未知の状態根拠種別です。");
  }
}

/** 状態の根拠を日本語で表示します。 */
export function statusEvidenceDetails(operation: ProposalOperation): readonly string[] {
  if (operation.operation !== "complete" && operation.operation !== "withdraw") {
    return [];
  }
  return [
    `${statusEvidenceKindLabel(operation.status_evidence.kind)}: ${operation.status_evidence.reference.locator}`,
  ];
}

/** 操作の根拠原文を重複なく表示します。 */
export function operationEvidenceExcerpts(operation: ProposalOperation): readonly string[] {
  const excerpts = new Set<string>();
  const addExcerpt = (excerpt: string | undefined): void => {
    if (excerpt == null || excerpt.trim().length === 0) {
      return;
    }
    excerpts.add(excerpt);
  };
  operation.evidence_refs.forEach((reference) => addExcerpt(reference.excerpt));
  if (operation.operation === "complete" || operation.operation === "withdraw") {
    addExcerpt(operation.status_evidence.reference.excerpt);
  }
  if (operation.operation === "create_task" && operation.creation.kind === "split_child") {
    addExcerpt(operation.creation.instruction_reference.excerpt);
  }
  return [...excerpts];
}
