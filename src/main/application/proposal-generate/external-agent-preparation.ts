type RequestFailure<TExpectedError extends Error> =
  | { readonly kind: "expected"; readonly error: TExpectedError }
  | { readonly kind: "unexpected" };

type PreparedRequest<TPrepared, TExpectedError extends Error> =
  | {
      readonly kind: "pending";
      readonly digest: string;
      readonly creation: Promise<TPrepared | undefined>;
    }
  | {
      readonly kind: "accepted";
      readonly digest: string;
      readonly creation: Promise<TPrepared>;
    }
  | {
      readonly kind: "failed";
      readonly digest: string;
      readonly creation: Promise<undefined>;
      readonly failure: RequestFailure<TExpectedError>;
    };

type PreparationErrorCode =
  | "request_id_reused"
  | "unknown_result"
  | "unavailable"
  | "offline"
  | "capacity_exceeded"
  | "context_changed";

/** 外部提案の準備要求と文脈を所有します。 */
export class ExternalAgentPreparation<TPrepared extends {
  readonly proposal_context_id: string;
  readonly context_id: string;
}, TExpectedError extends Error> {
  private readonly requests = new Map<string, PreparedRequest<TPrepared, TExpectedError>>();
  private readonly contexts = new Map<string, TPrepared>();

  public constructor(private readonly contextPorts: {
    readonly parseId: (value: string) => string;
    readonly currentContextId: () => string | undefined;
    readonly createError: (message: string) => TExpectedError;
  }) {}

  /** 準備要求と文脈を破棄します。 */
  public clear(): void {
    this.requests.clear();
    this.contexts.clear();
  }

  /** 保持する提案文脈の件数を返します。 */
  public contextCount(): number {
    return this.contexts.size;
  }

  /** 現行の提案文脈を要求します。 */
  public requireContext(proposalContextId: string): TPrepared {
    const parsedContextId = this.contextPorts.parseId(proposalContextId);
    const prepared = this.contexts.get(parsedContextId);
    if (prepared == null) {
      throw this.contextPorts.createError("指定した提案基準が失効しています。");
    }
    if (this.contextPorts.currentContextId() !== prepared.context_id) {
      throw this.contextPorts.createError("Asana文脈が変更されたため提案基準が失効しています。");
    }
    return prepared;
  }

  /** request IDを再利用できる準備要求として処理します。 */
  public async prepare<TInput extends {
    readonly request_id: string;
    readonly instance_id: string;
    readonly context_id: string;
    readonly project_gid: string;
  }, TContext, TBaseline, TResponse>(
    input: TInput,
    ports: {
      readonly digest: (input: TInput) => string;
      readonly stopped: () => boolean;
      readonly requireContext: () => TContext;
      readonly assertRequestContext: (input: TInput, context: TContext) => void;
      readonly assertApplyReady: () => void;
      readonly online: () => boolean;
      readonly maximumRequests: number;
      readonly createBaseline: () => TBaseline | PromiseLike<TBaseline>;
      readonly createPreparedContext: (input: TInput, context: TContext, baseline: TBaseline) => TPrepared;
      readonly createResponse: (prepared: TPrepared) => TResponse;
      readonly createError: (code: PreparationErrorCode, message: string, cause?: unknown) => TExpectedError;
      readonly isExpectedError: (error: unknown) => error is TExpectedError;
      readonly isContextInvalidatedError: (error: unknown) => boolean;
    },
  ): Promise<TResponse> {
    const digest = ports.digest(input);
    const existing = this.requests.get(input.request_id);
    if (existing != null) {
      if (existing.digest !== digest) {
        throw ports.createError("request_id_reused", "同じrequest_idへ別の内容を指定できません。");
      }
      const prepared = await existing.creation;
      if (prepared == null) {
        const current = this.requests.get(input.request_id);
        if (current?.kind === "failed" && current.failure.kind === "expected") {
          throw current.failure.error;
        }
        throw ports.createError("unknown_result", "提案基準の準備結果が不明です。");
      }
      return ports.createResponse(prepared);
    }
    if (ports.stopped()) {
      throw ports.createError("unavailable", "外部連携サービスは停止済みです。");
    }
    const context = ports.requireContext();
    ports.assertRequestContext(input, context);
    ports.assertApplyReady();
    if (ports.online() !== true) {
      throw ports.createError("offline", "オフライン中は提案基準を準備できません。");
    }
    if (this.requests.size >= ports.maximumRequests) {
      throw ports.createError("capacity_exceeded", "外部提案の受付上限に達しています。");
    }
    const creation = Promise.resolve()
      .then(() => ports.createBaseline())
      .then((baseline) => ports.createPreparedContext(input, context, baseline))
      .then(
        (prepared) => {
          this.contexts.set(prepared.proposal_context_id, prepared);
          this.requests.set(input.request_id, {
            kind: "accepted",
            digest,
            creation: Promise.resolve(prepared),
          });
          return prepared;
        },
        (error: unknown) => {
          let expectedError: TExpectedError | undefined;
          if (ports.isExpectedError(error)) {
            expectedError = error;
          } else if (ports.isContextInvalidatedError(error)) {
            expectedError = ports.createError(
              "context_changed",
              "提案準備中にAsana文脈が変更されました。",
              error,
            );
          }
          let failure: RequestFailure<TExpectedError>;
          if (expectedError == null) {
            failure = { kind: "unexpected" };
          } else {
            failure = { kind: "expected", error: expectedError };
          }
          this.requests.set(input.request_id, {
            kind: "failed",
            digest,
            creation: Promise.resolve(undefined),
            failure,
          });
          if (expectedError != null) {
            return undefined;
          }
          throw error;
        },
      );
    this.requests.set(input.request_id, { kind: "pending", digest, creation });
    const prepared = await creation;
    if (prepared == null) {
      const current = this.requests.get(input.request_id);
      if (current?.kind === "failed" && current.failure.kind === "expected") {
        throw current.failure.error;
      }
      throw ports.createError("unknown_result", "提案基準の準備結果が不明です。");
    }
    return ports.createResponse(prepared);
  }
}
