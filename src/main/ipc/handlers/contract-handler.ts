import type { z } from "zod";

type MaybePromise<Value> = Value | PromiseLike<Value>;

export type ContractHandler<Contract extends { readonly response: z.ZodType }> = (
  payload: unknown,
  signal: AbortSignal,
) => Promise<z.output<Contract["response"]>>;

export type IpcSuccessValue<Schema extends z.ZodType> = z.output<Schema> extends infer Response
  ? Response extends { readonly kind: "ok"; readonly value: infer Value }
    ? Value
    : never
  : never;

/** 契約に従って入力と成功応答を検証するIPC handlerを作成します。 */
export function createContractHandler<Request extends z.ZodType, Response extends z.ZodType>(
  contract: { readonly request: Request; readonly response: Response },
  useCase: (
    request: z.output<Request>,
    signal: AbortSignal,
  ) => MaybePromise<IpcSuccessValue<Response>>,
): ContractHandler<{ readonly response: Response }> {
  return async (payload, signal) => {
    const request = contract.request.safeParse(payload);
    if (!request.success) {
      return contract.response.parse({
        kind: "error",
        code: "invalid_request",
        message: "IPC入力が不正です。",
      });
    }
    const value = await useCase(request.data, signal);
    return contract.response.parse({ kind: "ok", value });
  };
}
