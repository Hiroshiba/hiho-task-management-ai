import { z } from "zod";
import {
  asanaTaskResponseSchema,
  customExternalDataSchema,
  dateSchema,
  externalTaskGidSchema,
  identifierSchema,
  parseCustomExternalData,
  serializeCustomExternalData,
  type AsanaTaskResponse,
} from "../../shared/domain";

const externalTaskGidPrefix = "TaskHub:v1:task:";
const activeTaskStatusSchema = z.enum(["not_started", "in_progress"]);
const brokenExternalDataReasonSchema = z.enum([
  "invalid_json",
  "invalid_schema",
  "capacity_exceeded",
]);

const missingExternalDataResultSchema = z
  .object({
    kind: z.literal("missing"),
    task_gid: identifierSchema,
  })
  .strict();

const validExternalDataResultSchema = z
  .object({
    kind: z.literal("valid"),
    task_gid: identifierSchema,
    data: customExternalDataSchema,
  })
  .strict();

const brokenExternalDataResultSchema = z
  .object({
    kind: z.literal("broken"),
    task_gid: identifierSchema,
    reason: brokenExternalDataReasonSchema,
  })
  .strict();

const unknownVersionExternalDataResultSchema = z
  .object({
    kind: z.literal("unknown_version"),
    task_gid: identifierSchema,
    schema: z.number().int(),
  })
  .strict();

const identityMismatchExternalDataResultSchema = z
  .object({
    kind: z.literal("identity_mismatch"),
    task_gid: identifierSchema,
  })
  .strict();

const ingestionResultSchema = z.discriminatedUnion("kind", [
  missingExternalDataResultSchema,
  validExternalDataResultSchema,
  brokenExternalDataResultSchema,
  unknownVersionExternalDataResultSchema,
  identityMismatchExternalDataResultSchema,
]);

const initializationInputSchema = z
  .object({
    id: z.uuid(),
    activity_anchor_on: dateSchema,
    last_active_status: activeTaskStatusSchema,
    device_id: identifierSchema,
    created_via: identifierSchema,
  })
  .strict();

const initializationResultSchema = z
  .object({
    gid: externalTaskGidSchema,
    data: z.string(),
  })
  .strict()
  .superRefine((result, context) => {
    const parsed = parseCustomExternalData(result.data);
    if (parsed.kind !== "valid") {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "初期化するCustom external dataは現行schemaのvalidなcanonical JSONでなければなりません。",
      });
      return;
    }
    if (externalDataUuid(result.gid) !== parsed.data.id) {
      context.addIssue({
        code: "custom",
        path: ["gid"],
        message: "Custom external dataのgidとdataの識別子が一致しません。",
      });
    }
    if (serializeCustomExternalData(parsed.data) !== result.data) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "初期化するCustom external dataはcanonical JSONでなければなりません。",
      });
    }
  });

export type ExternalDataIngestionResult = z.infer<
  typeof ingestionResultSchema
>;
export type CustomExternalDataInitializationInput = z.infer<
  typeof initializationInputSchema
>;
export type CustomExternalDataInitializationResult = z.infer<
  typeof initializationResultSchema
>;

/** AsanaタスクのCustom external data取込結果を検証するスキーマです。 */
export const externalDataIngestionResultSchema = ingestionResultSchema;

/** 新規Custom external dataの初期化入力を検証するスキーマです。 */
export const customExternalDataInitializationInputSchema =
  initializationInputSchema;

/** 新規Custom external dataの初期化結果を検証するスキーマです。 */
export const customExternalDataInitializationResultSchema =
  initializationResultSchema;

function externalDataUuid(gid: string): string {
  const validatedGid = externalTaskGidSchema.parse(gid);
  return validatedGid.slice(externalTaskGidPrefix.length);
}

/** AsanaタスクのCustom external dataを安全に取り込みます。 */
export function ingestAsanaExternalData(
  task: AsanaTaskResponse,
): ExternalDataIngestionResult {
  const validatedTask = asanaTaskResponseSchema.parse(task);
  if (validatedTask.external == null) {
    return ingestionResultSchema.parse({
      kind: "missing",
      task_gid: validatedTask.gid,
    });
  }

  const parsed = parseCustomExternalData(validatedTask.external.data);
  switch (parsed.kind) {
    case "broken":
      return ingestionResultSchema.parse({
        kind: "broken",
        task_gid: validatedTask.gid,
        reason: parsed.reason,
      });
    case "unknown_version":
      return ingestionResultSchema.parse({
        kind: "unknown_version",
        task_gid: validatedTask.gid,
        schema: parsed.schema,
      });
    case "valid":
      if (externalDataUuid(validatedTask.external.gid) !== parsed.data.id) {
        return ingestionResultSchema.parse({
          kind: "identity_mismatch",
          task_gid: validatedTask.gid,
        });
      }
      return ingestionResultSchema.parse({
        kind: "valid",
        task_gid: validatedTask.gid,
        data: parsed.data,
      });
  }
}

/** 新規Asanaタスク用のCustom external dataを初期化します。 */
export function createInitialCustomExternalData(
  input: CustomExternalDataInitializationInput,
): CustomExternalDataInitializationResult {
  const validatedInput = initializationInputSchema.parse(input);
  const data = customExternalDataSchema.parse({
    schema: 1,
    id: validatedInput.id,
    rev: 1,
    last_active_status: validatedInput.last_active_status,
    activity_anchor_on: validatedInput.activity_anchor_on,
    parent_work_mode: "unknown",
    dependencies: [],
    obsidian_links: [],
    provenance: {
      created_via: validatedInput.created_via,
      last_writer: validatedInput.device_id,
    },
  });
  const gid = externalTaskGidSchema.parse(`${externalTaskGidPrefix}${data.id}`);
  const serializedData = serializeCustomExternalData(data);
  return initializationResultSchema.parse({
    gid,
    data: serializedData,
  });
}
