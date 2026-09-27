import { z } from "zod";

export const maximumZodIssues = 10;
const maximumZodIssuePathElements = 10;

const safeZodIssuePathFieldSchema = z.enum([
  "data",
  "sync",
  "has_more",
  "action",
  "resource",
  "parent",
  "user",
  "created_at",
  "change",
  "gid",
  "resource_type",
  "field",
  "new_value",
  "other",
]);
const safeZodIssuePathIndexSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger);
const safeZodIssuePathSegmentSchema = z.union([
  safeZodIssuePathFieldSchema,
  safeZodIssuePathIndexSchema,
]);
const safeZodIssueCodeSchema = z.enum([
  "invalid_type",
  "too_big",
  "too_small",
  "invalid_format",
  "not_multiple_of",
  "unrecognized_keys",
  "invalid_union",
  "invalid_key",
  "invalid_element",
  "invalid_value",
  "custom",
  "other",
]);
const safeZodIssueExpectedSchema = z.enum([
  "string",
  "number",
  "int",
  "boolean",
  "bigint",
  "symbol",
  "undefined",
  "null",
  "never",
  "void",
  "date",
  "array",
  "object",
  "tuple",
  "record",
  "map",
  "set",
  "file",
  "nonoptional",
  "nan",
  "function",
]);
export const safeZodIssueSchema = z
  .object({
    path: z.array(safeZodIssuePathSegmentSchema).max(maximumZodIssuePathElements),
    code: safeZodIssueCodeSchema,
    expected: safeZodIssueExpectedSchema.optional(),
  })
  .strict();

export type SafeZodIssue = z.infer<typeof safeZodIssueSchema>;
type SafeZodIssuePathSegment = z.infer<typeof safeZodIssuePathSegmentSchema>;
type SafeZodIssueCode = z.infer<typeof safeZodIssueCodeSchema>;
type SafeZodIssueExpected = z.infer<typeof safeZodIssueExpectedSchema>;
function sanitizeZodIssuePathSegment(value: PropertyKey): SafeZodIssuePathSegment {
  if (typeof value === "number") {
    const parsedIndex = safeZodIssuePathIndexSchema.safeParse(value);
    return parsedIndex.success ? parsedIndex.data : "other";
  }
  if (typeof value !== "string") {
    return "other";
  }
  const parsedField = safeZodIssuePathFieldSchema.safeParse(value);
  return parsedField.success ? parsedField.data : "other";
}

function getSafeZodIssuePath(path: readonly PropertyKey[]): SafeZodIssuePathSegment[] {
  return path
    .slice(0, maximumZodIssuePathElements)
    .map((segment) => sanitizeZodIssuePathSegment(segment));
}

function getSafeZodIssueCode(issue: z.ZodIssue): SafeZodIssueCode {
  const parsedCode = safeZodIssueCodeSchema.safeParse(issue.code);
  return parsedCode.success ? parsedCode.data : "other";
}

function getSafeZodIssueExpected(issue: z.ZodIssue): SafeZodIssueExpected | undefined {
  if (!("expected" in issue)) {
    return undefined;
  }
  const parsedExpected = safeZodIssueExpectedSchema.safeParse(issue.expected);
  return parsedExpected.success ? parsedExpected.data : undefined;
}

function getSafeZodIssues(value: unknown): SafeZodIssue[] {
  if (!(value instanceof z.ZodError)) {
    return [];
  }
  return value.issues.slice(0, maximumZodIssues).map((issue) => {
    const expected = getSafeZodIssueExpected(issue);
    return safeZodIssueSchema.parse({
      path: getSafeZodIssuePath(issue.path),
      code: getSafeZodIssueCode(issue),
      ...(expected === undefined ? {} : { expected }),
    });
  });
}

/** Zod検証エラーから安全な問題分類だけを抽出します。 */
export function getSafeZodDetail(value: unknown): { zod_issues?: SafeZodIssue[] } {
  const issues = getSafeZodIssues(value);
  return issues.length === 0 ? {} : { zod_issues: issues };
}
