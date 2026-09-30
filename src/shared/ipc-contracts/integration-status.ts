import { z } from "zod";

/** 外部連携の設定状態を検証します。 */
export const integrationStatusSchema = z.object({
  github_app: z.object({
    kind: z.literal("unavailable"),
    reason_code: z.literal("client_unavailable"),
  }).strict(),
}).strict();

export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;
