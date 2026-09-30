/** 未承認の外部提案を指定理由で失効させます。 */
export function expireExternalAgentProposals(
  proposals: Iterable<{ revision: number; state: { readonly kind: string; readonly reason_code?: string } }>,
  reasonCode: "context_changed" | "instance_restarted" | "superseded",
  emitChanged: () => void,
): void {
  let changed = false;
  for (const record of proposals) {
    if (record.state.kind === "pending_approval") {
      record.revision += 1;
      record.state = { kind: "expired", reason_code: reasonCode };
      changed = true;
    }
  }
  if (changed) {
    emitChanged();
  }
}
