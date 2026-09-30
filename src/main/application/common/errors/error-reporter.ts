import { z } from "zod";

export const errorReportContextSchema = z
  .object({
    source: z.enum(["main", "service", "ipc", "uncaught_exception"]),
    diagnosticCode: z.string().regex(/^[a-z][a-z._]*$/),
    context: z.enum([
      "service_diagnostic",
      "ipc_diagnostic",
      "diagnostic_storage",
      "external_url",
      "registry_dispose",
      "background_operation",
      "application_stop",
      "application_update",
      "main_window",
      "application_quit",
      "bootstrap",
      "uncaught_exception",
    ]),
    level: z.enum(["warning", "error"]),
    operationId: z.string().min(1).optional(),
  })
  .strict();

export type ErrorReportContext = Readonly<z.infer<typeof errorReportContextSchema>>;
export type ErrorId = string;

/** エラーの記録状態を保持して同じ失敗を一度だけ記録します。 */
export interface ErrorReporter {
  reportErrorOnce(error: unknown, context: ErrorReportContext): ErrorId;
  reportErrorOnceStrict(error: unknown, context: ErrorReportContext): ErrorId;
}
