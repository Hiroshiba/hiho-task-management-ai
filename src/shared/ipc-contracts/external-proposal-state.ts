import { z } from "zod";
import { displayTextSchema, identifierSchema } from "./common";
import { proposalViewSchema } from "./proposal-values";

const externalProposalStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending_approval") }).strict(),
  z.object({ kind: z.literal("approving") }).strict(),
  z
    .object({
      kind: z.literal("finished"),
      outcome: z.enum(["applied", "already_applied", "not_applied", "partially_applied", "unknown"]),
      execution_id: identifierSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("rejected") }).strict(),
  z
    .object({
      kind: z.literal("expired"),
      reason_code: z.enum(["context_changed", "instance_restarted", "superseded"]),
    })
    .strict(),
  z.object({ kind: z.literal("failed"), reason_code: identifierSchema, message: displayTextSchema }).strict(),
  z.object({ kind: z.literal("unknown"), reason_code: identifierSchema, message: displayTextSchema }).strict(),
]);

const externalProposalSchema = z
  .object({
    proposal_id: identifierSchema,
    request_id: identifierSchema,
    revision: z.number().int().positive(),
    state: externalProposalStatusSchema,
    view: proposalViewSchema,
  })
  .strict();

export const externalProposalStateSchema = z
  .object({
    enabled: z.boolean(),
    bridge: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("stopped") }).strict(),
      z.object({ kind: z.literal("running") }).strict(),
      z
        .object({
          kind: z.literal("unavailable"),
          code: z.enum(["startup_failed", "permission_denied", "protocol_mismatch", "unavailable"]),
          message: displayTextSchema,
        })
        .strict(),
    ]),
    registration: z
      .object({
        command: displayTextSchema,
        allow_execution_command: displayTextSchema,
        instructions: displayTextSchema,
      })
      .strict(),
    proposals: z.array(externalProposalSchema).max(256),
    review_target: z.object({ proposal_id: identifierSchema, request_id: identifierSchema }).strict().optional(),
  })
  .strict();
