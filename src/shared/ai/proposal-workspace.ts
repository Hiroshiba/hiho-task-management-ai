import { z } from "zod";
import { identifierSchema } from "../domain";
import {
  maximumProposalOperations,
  proposalOperationSchema,
  proposalSchema,
  proposalTitleSchema,
} from "./proposal";

export const maximumProposalWorkspaceArgumentBytes = 128 * 1024;
export const maximumProposalWorkspaceResponseBytes = 64 * 1024;

/** AI変更案ワークスペースの意味編集を検証するスキーマです。 */
export const proposalWorkspaceEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_title"), title: proposalTitleSchema }).strict(),
  z.object({
    kind: z.literal("insert_group"),
    group_id: identifierSchema,
    atomic: z.boolean(),
    before_group_id: identifierSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("set_group_atomic"),
    group_id: identifierSchema,
    atomic: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("move_group"),
    group_id: identifierSchema,
    before_group_id: identifierSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("remove_group"), group_id: identifierSchema }).strict(),
  z.object({
    kind: z.literal("insert_operation"),
    group_id: identifierSchema,
    operation: proposalOperationSchema,
    before_operation_id: identifierSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("replace_operation"),
    operation_id: identifierSchema,
    operation: proposalOperationSchema,
  }).strict(),
  z.object({
    kind: z.literal("move_operation"),
    operation_id: identifierSchema,
    group_id: identifierSchema,
    before_operation_id: identifierSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("remove_operation"), operation_id: identifierSchema }).strict(),
  z.object({ kind: z.literal("replace_all"), proposal: proposalSchema }).strict(),
]);

/** AI変更案ワークスペースへの編集バッチを検証するスキーマです。 */
export const proposalWorkspaceBatchSchema = z.object({
  workspace_id: identifierSchema,
  edit_batch_id: identifierSchema,
  expected_revision: z.number().int().nonnegative().safe(),
  edits: z.array(proposalWorkspaceEditSchema).min(1).max(maximumProposalOperations),
}).strict();

/** AI変更案ワークスペースの読み取り対象を検証するスキーマです。 */
export const proposalWorkspaceReadTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("summary") }).strict(),
  z.object({ kind: z.literal("proposal") }).strict(),
  z.object({ kind: z.literal("group"), group_id: identifierSchema }).strict(),
  z.object({ kind: z.literal("operation"), operation_id: identifierSchema }).strict(),
]);

/** AI変更案ワークスペースの部分読み取りを検証するスキーマです。 */
export const proposalWorkspaceReadSchema = z.object({
  workspace_id: identifierSchema,
  revision: z.number().int().nonnegative().safe(),
  target: proposalWorkspaceReadTargetSchema,
  offset: z.number().int().nonnegative().safe().optional(),
}).strict();

/** AI変更案ワークスペースの差分読み取りを検証するスキーマです。 */
export const proposalWorkspaceDiffSchema = z.object({
  workspace_id: identifierSchema,
  from_revision: z.number().int().nonnegative().safe(),
  revision: z.number().int().nonnegative().safe(),
  offset: z.number().int().nonnegative().safe().optional(),
}).strict();

/** AI変更案ワークスペースの提出を検証するスキーマです。 */
export const proposalWorkspaceSubmitSchema = z.object({
  workspace_id: identifierSchema,
  expected_revision: z.number().int().nonnegative().safe(),
}).strict();

export type ProposalWorkspaceEdit = z.infer<typeof proposalWorkspaceEditSchema>;
export type ProposalWorkspaceBatch = z.infer<typeof proposalWorkspaceBatchSchema>;
export type ProposalWorkspaceRead = z.infer<typeof proposalWorkspaceReadSchema>;
export type ProposalWorkspaceDiff = z.infer<typeof proposalWorkspaceDiffSchema>;
export type ProposalWorkspaceSubmit = z.infer<typeof proposalWorkspaceSubmitSchema>;
