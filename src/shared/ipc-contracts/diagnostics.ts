import { z } from "zod";
import { errorIdSchema, identifierSchema, responseSchema, type IpcResult } from "./common";

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
const diagnosticResultSchema = z.object({ error_id: errorIdSchema }).strict();

export const diagnosticsContracts = {
  report: {
    channel: diagnosticsChannels.report,
    request: diagnosticRequestSchema,
    response: responseSchema(diagnosticResultSchema),
  },
};

export type DiagnosticsApi = {
  readonly report: (
    input: z.infer<typeof diagnosticRequestSchema>,
  ) => Promise<IpcResult<z.infer<typeof diagnosticResultSchema>>>;
};
