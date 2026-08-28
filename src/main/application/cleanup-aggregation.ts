import { z } from "zod";
import {
  cleanupItemSchema,
} from "../../shared/domain";
import type { CleanupItemsCache } from "../../shared/storage";
import { StorageDatabase } from "../storage";

const proposalConflictCleanupItemSchema = cleanupItemSchema.extend({
  kind: z.literal("proposal_conflict"),
});
const brokenVaultLinkCleanupItemSchema = cleanupItemSchema.extend({
  kind: z.literal("broken_vault_link"),
});
const proposalConflictCleanupItemsSchema = z.array(
  proposalConflictCleanupItemSchema,
);
const brokenVaultLinkCleanupItemsSchema = z.array(
  brokenVaultLinkCleanupItemSchema,
);
const localCleanupItemsInputSchema = z
  .object({
    proposal_conflicts: proposalConflictCleanupItemsSchema,
    broken_vault_links: brokenVaultLinkCleanupItemsSchema,
  })
  .strict();

export type LocalCleanupItemsInput = z.infer<typeof localCleanupItemsInputSchema>;
export type ProposalConflictCleanupItem = z.infer<
  typeof proposalConflictCleanupItemSchema
>;
export type BrokenVaultLinkCleanupItem = z.infer<
  typeof brokenVaultLinkCleanupItemSchema
>;

/** ローカル非同期処理に由来する要整理項目を種類別に集約します。 */
export class CleanupAggregationService {
  public constructor(private readonly database: StorageDatabase) {}

  /** AI変更案の競合項目だけを置き換えます。 */
  public replaceProposalConflicts(
    items: readonly ProposalConflictCleanupItem[],
  ): CleanupItemsCache {
    const validatedItems = proposalConflictCleanupItemsSchema.parse(items);
    return this.database.replaceCleanupItemsByKinds(
      ["proposal_conflict"],
      validatedItems,
    );
  }

  /** Vaultリンク切れ項目だけを置き換えます。 */
  public replaceBrokenVaultLinks(
    items: readonly BrokenVaultLinkCleanupItem[],
  ): CleanupItemsCache {
    const validatedItems = brokenVaultLinkCleanupItemsSchema.parse(items);
    return this.database.replaceCleanupItemsByKinds(
      ["broken_vault_link"],
      validatedItems,
    );
  }

  /** ローカル非同期処理に由来する二種の項目をまとめて置き換えます。 */
  public replaceLocalCleanupItems(
    input: LocalCleanupItemsInput,
  ): CleanupItemsCache {
    const validatedInput = localCleanupItemsInputSchema.parse(input);
    return this.database.replaceCleanupItemsByKinds(
      ["proposal_conflict", "broken_vault_link"],
      [
        ...validatedInput.proposal_conflicts,
        ...validatedInput.broken_vault_links,
      ],
    );
  }
}
