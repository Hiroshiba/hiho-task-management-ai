import { z } from "zod";
import type { JsonValue } from "../../shared/domain";
import {
  externalToolMaxStatusEvidence,
  externalToolOutputSchema,
  externalToolStatusEvidenceAttemptSchema,
  externalToolStatusEvidenceCollectionSchema,
  externalToolStatusEvidenceSchema,
  type ExternalToolOutput,
  type ExternalToolStatusEvidence,
  type ExternalToolStatusEvidenceAttempt,
} from "./schemas";

const outputStatusEvidenceRecordSchema = z
  .object({
    locator: externalToolStatusEvidenceSchema.shape.locator,
    target_task_gid: externalToolStatusEvidenceSchema.shape.target_task_gid,
    status: externalToolStatusEvidenceSchema.shape.status,
  })
  .passthrough();

type ActiveCollection = {
  readonly kind: "active";
  readonly attempt_id: string;
  readonly signal: AbortSignal;
  readonly evidence_by_locator: Map<string, ExternalToolStatusEvidence>;
};

type CollectorState =
  | { readonly kind: "inactive" }
  | ActiveCollection;

type EvidenceCandidate =
  | { readonly kind: "ignored" }
  | { readonly kind: "evidence"; readonly value: ExternalToolStatusEvidence };

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
    || typeof signal.throwIfAborted !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  try {
    signal.throwIfAborted();
  } catch (error: unknown) {
    throw new Error("外部状態根拠の収集が中断されました。", { cause: error });
  }
  throw new Error("中断済みAbortSignalの理由を取得できません。");
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function appendTopLevelRecords(records: JsonValue[], value: JsonValue): void {
  if (isJsonArray(value)) {
    for (const item of value) {
      records.push(item);
    }
    return;
  }
  records.push(value);
}

function topLevelRecords(output: ExternalToolOutput): readonly JsonValue[] {
  const records: JsonValue[] = [];
  if (output.format === "json") {
    appendTopLevelRecords(records, output.value);
    return records;
  }
  for (const value of output.values) {
    appendTopLevelRecords(records, value);
  }
  return records;
}

function parseEvidenceCandidate(value: JsonValue): EvidenceCandidate {
  const parsed = outputStatusEvidenceRecordSchema.safeParse(value);
  if (!parsed.success) {
    return { kind: "ignored" };
  }
  return {
    kind: "evidence",
    value: externalToolStatusEvidenceSchema.parse({
      kind: "external_tool",
      locator: parsed.data.locator,
      target_task_gid: parsed.data.target_task_gid,
      status: parsed.data.status,
    }),
  };
}

function sameEvidence(
  left: ExternalToolStatusEvidence,
  right: ExternalToolStatusEvidence,
): boolean {
  return left.locator === right.locator
    && left.target_task_gid === right.target_task_gid
    && left.status === right.status;
}

function assertCompatibleEvidence(
  current: ExternalToolStatusEvidence,
  incoming: ExternalToolStatusEvidence,
): void {
  if (sameEvidence(current, incoming)) {
    return;
  }
  throw new Error(
    `外部状態根拠locator ${incoming.locator} に異なる対象または状態を指定できません。`,
  );
}

function extractEvidence(
  output: ExternalToolOutput,
): readonly ExternalToolStatusEvidence[] {
  const evidenceByLocator = new Map<string, ExternalToolStatusEvidence>();
  for (const record of topLevelRecords(output)) {
    const candidate = parseEvidenceCandidate(record);
    if (candidate.kind === "ignored") {
      continue;
    }
    const current = evidenceByLocator.get(candidate.value.locator);
    if (current != null) {
      assertCompatibleEvidence(current, candidate.value);
      continue;
    }
    evidenceByLocator.set(candidate.value.locator, candidate.value);
  }
  return [...evidenceByLocator.values()].sort((left, right) =>
    compareStrings(left.locator, right.locator));
}

/** AIターン中だけ外部ツールの構造化状態根拠を保持します。 */
export class ExternalToolStatusEvidenceCollector {
  private state: CollectorState = { kind: "inactive" };

  /** AIターンの外部状態根拠収集を開始します。 */
  public beginTurn(attemptId: string, signal: AbortSignal): void {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const attempt = externalToolStatusEvidenceAttemptSchema.parse({
      kind: "active",
      attempt_id: attemptId,
    });
    if (attempt.kind !== "active") {
      throw new Error("外部状態根拠attemptの検証結果が不正です。");
    }
    if (this.state.kind !== "inactive") {
      throw new Error("外部状態根拠を収集中のAIターンがあります。");
    }
    this.state = {
      kind: "active",
      attempt_id: attempt.attempt_id,
      signal,
      evidence_by_locator: new Map<string, ExternalToolStatusEvidence>(),
    };
  }

  /** 外部ツール実行へ現在の収集attemptを値として渡します。 */
  public captureAttempt(): ExternalToolStatusEvidenceAttempt {
    if (this.state.kind === "inactive") {
      return externalToolStatusEvidenceAttemptSchema.parse({ kind: "inactive" });
    }
    return externalToolStatusEvidenceAttemptSchema.parse({
      kind: "active",
      attempt_id: this.state.attempt_id,
    });
  }

  /** 検証済み外部ツール出力から当該attemptの構造化根拠を記録します。 */
  public record(
    attempt: ExternalToolStatusEvidenceAttempt,
    output: ExternalToolOutput,
  ): readonly ExternalToolStatusEvidence[] {
    const validatedAttempt = externalToolStatusEvidenceAttemptSchema.parse(attempt);
    const validatedOutput = externalToolOutputSchema.parse(output);
    if (validatedAttempt.kind === "inactive") {
      if (this.state.kind !== "inactive") {
        throw new Error("外部ツール実行中に外部状態根拠の収集attemptが変わりました。");
      }
      return externalToolStatusEvidenceCollectionSchema.parse([]);
    }
    const active = this.requireActiveCollection(validatedAttempt.attempt_id);
    throwIfAborted(active.signal);
    const extracted = extractEvidence(validatedOutput);
    let newEvidenceCount = 0;
    for (const evidence of extracted) {
      const current = active.evidence_by_locator.get(evidence.locator);
      if (current == null) {
        newEvidenceCount += 1;
        continue;
      }
      assertCompatibleEvidence(current, evidence);
    }
    if (
      active.evidence_by_locator.size + newEvidenceCount
      > externalToolMaxStatusEvidence
    ) {
      throw new Error(
        `一つのAIターンで保持できる外部状態根拠は${externalToolMaxStatusEvidence}件までです。`,
      );
    }
    for (const evidence of extracted) {
      if (!active.evidence_by_locator.has(evidence.locator)) {
        active.evidence_by_locator.set(evidence.locator, evidence);
      }
    }
    return externalToolStatusEvidenceCollectionSchema.parse(extracted);
  }

  /** AIターンの構造化根拠を確定してメモリから除去します。 */
  public finishTurn(
    attemptId: string,
    signal: AbortSignal,
  ): readonly ExternalToolStatusEvidence[] {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const attempt = externalToolStatusEvidenceAttemptSchema.parse({
      kind: "active",
      attempt_id: attemptId,
    });
    if (attempt.kind !== "active") {
      throw new Error("外部状態根拠attemptの検証結果が不正です。");
    }
    const active = this.requireActiveCollection(attempt.attempt_id);
    throwIfAborted(active.signal);
    const evidence = externalToolStatusEvidenceCollectionSchema.parse(
      [...active.evidence_by_locator.values()].sort((left, right) =>
        compareStrings(left.locator, right.locator)),
    );
    this.state = { kind: "inactive" };
    return evidence;
  }

  /** AIターンの構造化根拠を破棄してメモリから除去します。 */
  public cancelTurn(attemptId: string): void {
    const attempt = externalToolStatusEvidenceAttemptSchema.parse({
      kind: "active",
      attempt_id: attemptId,
    });
    if (attempt.kind !== "active") {
      throw new Error("外部状態根拠attemptの検証結果が不正です。");
    }
    this.requireActiveCollection(attempt.attempt_id);
    this.state = { kind: "inactive" };
  }

  private requireActiveCollection(attemptId: string): ActiveCollection {
    if (this.state.kind !== "active") {
      throw new Error("外部状態根拠の収集attemptが開始されていません。");
    }
    if (this.state.attempt_id !== attemptId) {
      throw new Error("外部状態根拠の収集attempt IDが一致しません。");
    }
    return this.state;
  }
}
