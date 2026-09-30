import { z } from "zod";

/** Asana Events APIのopaqueな同期トークンを検証するスキーマです。 */
export const asanaSyncTokenSchema = z.string().min(1);
