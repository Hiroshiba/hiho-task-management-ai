import { z } from "zod";
import { errorIdSchema, identifierSchema } from "./common";

export const diagnosticsChannels = {
  report: "diagnostics:report",
} satisfies Record<string, string>;

const diagnosticRequestSchema = z
  .object({
    level: z.enum(["error", "warning"]),
    message: z.string().min(1).max(4_096),
    stack: z.string().min(1).max(16_384),
    operation_id: identifierSchema.optional(),
  })
  .strict();
const diagnosticResponseSchema = z.object({ error_id: errorIdSchema }).strict();

export const diagnosticsContracts = {
  report: {
    channel: diagnosticsChannels.report,
    request: diagnosticRequestSchema,
    response: diagnosticResponseSchema,
  },
};

export type DiagnosticsApi = {
  readonly report: (
    input: z.infer<typeof diagnosticRequestSchema>,
  ) => Promise<z.infer<typeof diagnosticResponseSchema>>;
};
