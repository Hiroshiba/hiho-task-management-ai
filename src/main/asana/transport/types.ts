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
