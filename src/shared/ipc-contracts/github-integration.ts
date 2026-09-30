import { z } from "zod";
import { emptyRequestSchema, errorIdSchema, responseSchema, type IpcResult } from "./common";

export const githubIntegrationChannels = {
  getStatus: "github-integration:get-status",
} satisfies Record<string, string>;

export const githubIntegrationStatusSchema = z
  .object({
    kind: z.literal("unavailable"),
    reason_code: z.literal("client_unavailable"),
    error_id: errorIdSchema,
  })
  .strict();

export const githubIntegrationContracts = {
  getStatus: {
    channel: githubIntegrationChannels.getStatus,
    request: emptyRequestSchema,
    response: responseSchema(githubIntegrationStatusSchema),
  },
};

export type GithubIntegrationApi = {
  readonly getStatus: () => Promise<IpcResult<z.infer<typeof githubIntegrationStatusSchema>>>;
};
