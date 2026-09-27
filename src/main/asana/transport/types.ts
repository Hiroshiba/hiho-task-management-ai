import { z } from "zod";
import type { JsonValue } from "../../../shared/domain";

export interface TokenProvider {
  getAccessToken(): Promise<string>;
  refreshAccessToken(): Promise<string>;
}

type AsanaRequestCommon<T> = {
  readonly path: readonly string[];
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly response_schema: z.ZodType<T>;
};

export type AsanaGetRequest<T> = AsanaRequestCommon<T> & {
  readonly method: "GET";
};

export type AsanaPostRequest<T> = AsanaRequestCommon<T> & {
  readonly method: "POST";
  readonly body: JsonValue;
  readonly retry_safe: boolean;
};

export type AsanaPutRequest<T> = AsanaRequestCommon<T> & {
  readonly method: "PUT";
  readonly body: JsonValue;
  readonly retry_safe: boolean;
};

export type AsanaRequest<T> =
  | AsanaGetRequest<T>
  | AsanaPostRequest<T>
  | AsanaPutRequest<T>;

export type AsanaSingleAttemptWriteRequest<T> = Omit<
  AsanaPostRequest<T> | AsanaPutRequest<T>,
  "retry_safe"
>;

export interface AsanaTransportRequestPort {
  request<T>(request: AsanaRequest<T>, signal: AbortSignal): Promise<T>;
}

/** 指定優先度で通常要求と単一送信の書き込みを受け付けます。 */
export interface AsanaTransportPriorityPort extends AsanaTransportRequestPort {
  requestSingleAttempt<T>(
    request: AsanaSingleAttemptWriteRequest<T>,
    signal: AbortSignal,
  ): Promise<T>;
}
