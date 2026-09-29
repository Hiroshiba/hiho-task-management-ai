import type { CodexGeneratedResponse, Task } from "../../../domain";
import type { TaskReadRanking } from "./task-read-repository";

/** 変更案生成が参照する固定済みタスク状態です。 */
export type ProposalGenerationTaskctlSnapshot = {
  readonly sync: { readonly kind: "synced"; readonly synced_at: string } | { readonly kind: "unavailable" };
  readonly tasks: Task[];
  readonly ranking: { readonly kind: "available"; readonly cache: TaskReadRanking }
    | { readonly kind: "unavailable" };
};

/** 変更案生成からAIセッションへ渡すターン入力です。 */
export type ProposalGenerationTurnInput = Array<
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "skill"; readonly name: string; readonly path: string }
>;

/** AIセッションが返す検証済みターン結果です。 */
export type ProposalGenerationTurnResult = {
  readonly threadId: string;
  readonly turnId: string;
  readonly response: CodexGeneratedResponse;
};

/** AIセッションから受け取る差分です。 */
export type ProposalGenerationDelta = {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly delta: string;
};

/** AIセッションの差分購読関数です。 */
export type ProposalGenerationDeltaListener =
  (delta: ProposalGenerationDelta) => void | PromiseLike<void>;

/** 同期後のAIターンと提案ワークスペースを操作する境界です。 */
export interface ProposalGenerationSessionPort<
  TTurnInput,
  TTurnResult,
  TSnapshot,
  TWorkspace,
  TProposal,
  TValidation,
  TDelta,
> {
  startTurnWithPreparation(
    prepareInput: (signal: AbortSignal) => TTurnInput | PromiseLike<TTurnInput>,
    signal: AbortSignal,
  ): Promise<TTurnResult>;
  freezeTaskctlSnapshot(snapshot: TSnapshot): void;
  releaseTaskctlSnapshot(): void;
  activateProposalWorkspace(
    workspace: TWorkspace,
    validate: (proposal: TProposal) => TValidation,
  ): void;
  onDelta(listener: (delta: TDelta) => void | PromiseLike<void>): () => void;
}
