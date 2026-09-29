import { z } from "zod";
import type { GuiEditInput } from "./write-plan";

const dueInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("on"), value: z.string() }).strict(),
  z.object({ kind: z.literal("at"), value: z.string() }).strict(),
]);

/** GUIの日付指定を保存用planの操作へ変換します。 */
export function normalizeGuiDueOperation(value: unknown): GuiEditInput["operation"] {
  const parsed = dueInputSchema.parse(value);
  switch (parsed.kind) {
    case "none": return { kind: "clear_due" };
    case "on": return { kind: "set_due", value: { kind: "due_on", due_on: parsed.value } };
    case "at": return { kind: "set_due", value: { kind: "due_at", due_at: parsed.value } };
  }
}
