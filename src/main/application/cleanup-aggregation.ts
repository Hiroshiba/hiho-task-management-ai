import { z } from "zod";
import {
  cleanupItemSchema,
  taskSchema,
  type Task,
} from "../../shared/domain";
import type { CleanupItemsCache } from "../../shared/storage";
import {
  asanaProposalApplicationResultSchema,
  asanaProposalRecoveryResultSchema,
  type AsanaProposalApplicationResult,
  type AsanaProposalRecoveryResult,
} from "../ai/proposal-application";
import {
  ObsidianReadError,
  obsidianResolvedPathResultSchema,
  type ObsidianResolvedPathResult,
} from "../obsidian";
import { StorageDatabase } from "../storage";

export type CleanupNoteExistsPort = {
  readonly noteExists: (
    vaultId: string,
    relativePath: string,
    signal: AbortSignal,
  ) => Promise<ObsidianResolvedPathResult>;
};

const tasksSchema = z.array(taskSchema);
const cleanupNoteExistsPortSchema = z.custom<CleanupNoteExistsPort>(
  (value) => typeof value === "object"
    && value != null
    && typeof Reflect.get(value, "noteExists") === "function",
  "Vaultリンク存在確認境界が不正です。",
);
const brokenVaultLinkErrorCodeSchema = z.enum([
  "vault_not_registered",
  "vault_unavailable",
  "vault_not_directory",
  "symlink_rejected",
  "path_security",
  "path_changed",
  "note_not_file",
]);
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

function createProposalConflictItem(
  proposalId: string,
  operationId: string,
  outcome: "not_applied" | "unknown",
  reasonCode: string,
  taskGid: string | undefined,
): ProposalConflictCleanupItem {
  const outcomeMessage = outcome === "not_applied"
    ? "適用されませんでした"
    : "適用結果を確定できません";
  const item = {
    kind: "proposal_conflict",
    message: `AI変更案 ${proposalId} の操作 ${operationId} は${outcomeMessage}。理由コードは ${reasonCode} です。`,
  };
  if (taskGid == null) {
    return proposalConflictCleanupItemSchema.parse(item);
  }
  return proposalConflictCleanupItemSchema.parse({
    ...item,
    task_gid: taskGid,
  });
}

function createProposalConflictItems(
  result: AsanaProposalApplicationResult,
): ProposalConflictCleanupItem[] {
  const items: ProposalConflictCleanupItem[] = [];
  for (const operation of result.operations) {
    if (operation.outcome !== "not_applied" && operation.outcome !== "unknown") {
      continue;
    }
    items.push(
      createProposalConflictItem(
        result.proposal_id,
        operation.operation_id,
        operation.outcome,
        operation.reason_code,
        operation.task_gid,
      ),
    );
  }
  return items;
}

function isBrokenVaultLinkError(error: unknown): error is ObsidianReadError {
  return error instanceof ObsidianReadError
    && brokenVaultLinkErrorCodeSchema.safeParse(error.code).success;
}

function createMissingVaultLinkItem(
  taskGid: string,
  vaultId: string,
  relativePath: string,
): BrokenVaultLinkCleanupItem {
  return brokenVaultLinkCleanupItemSchema.parse({
    kind: "broken_vault_link",
    message: `Vault ${vaultId} のノート ${relativePath} が見つかりません。`,
    task_gid: taskGid,
  });
}

function createUnavailableVaultLinkItem(
  taskGid: string,
  vaultId: string,
  relativePath: string,
  errorCode: z.infer<typeof brokenVaultLinkErrorCodeSchema>,
): BrokenVaultLinkCleanupItem {
  return brokenVaultLinkCleanupItemSchema.parse({
    kind: "broken_vault_link",
    message: `Vault ${vaultId} のノート ${relativePath} を参照できません。理由コードは ${errorCode} です。`,
    task_gid: taskGid,
  });
}

function validateNoteExistsResult(
  value: ObsidianResolvedPathResult,
  vaultId: string,
  relativePath: string,
): ObsidianResolvedPathResult {
  const result = obsidianResolvedPathResultSchema.parse(value);
  if (result.vault_id !== vaultId || result.relative_path !== relativePath) {
    throw new Error("Vaultリンクの存在確認結果が要求したリンクと一致しません。");
  }
  return result;
}

/** ローカル非同期処理に由来する要整理項目を種類別に集約します。 */
export class CleanupAggregationService {
  private readonly database: StorageDatabase;
  private readonly noteExistsPort: CleanupNoteExistsPort;

  public constructor(
    database: StorageDatabase,
    noteExistsPort: CleanupNoteExistsPort,
  ) {
    this.database = database;
    this.noteExistsPort = cleanupNoteExistsPortSchema.parse(noteExistsPort);
  }

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

  /** 単一のAI変更案適用結果から未適用項目を再構築します。 */
  public replaceProposalConflictsFromApplication(
    result: AsanaProposalApplicationResult,
  ): CleanupItemsCache {
    const validatedResult = asanaProposalApplicationResultSchema.parse(result);
    return this.replaceProposalConflicts(
      createProposalConflictItems(validatedResult),
    );
  }

  /** 復旧結果全体から未解決のAI変更案項目を再構築します。 */
  public replaceProposalConflictsFromRecovery(
    result: AsanaProposalRecoveryResult,
  ): CleanupItemsCache {
    const validatedResult = asanaProposalRecoveryResultSchema.parse(result);
    const items = validatedResult.applications.flatMap((application) =>
      createProposalConflictItems(application),
    );
    items.push(
      ...validatedResult.unresolved_journals.map((journal) =>
        createProposalConflictItem(
          journal.proposal_id,
          journal.operation_id,
          journal.outcome,
          journal.reason_code,
          journal.task_gid,
        ),
      ),
    );
    return this.replaceProposalConflicts(items);
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

  /** 同期済みタスクの全Vaultリンクを検査してリンク切れ項目を再構築します。 */
  public async replaceBrokenVaultLinksFromTasks(
    tasks: readonly Task[],
    signal: AbortSignal,
  ): Promise<CleanupItemsCache> {
    const validatedTasks = tasksSchema.parse(tasks);
    const items: BrokenVaultLinkCleanupItem[] = [];
    signal.throwIfAborted();
    for (const task of validatedTasks) {
      for (const link of task.obsidian_links) {
        signal.throwIfAborted();
        try {
          const result = validateNoteExistsResult(
            await this.noteExistsPort.noteExists(
              link.vault_id,
              link.path,
              signal,
            ),
            link.vault_id,
            link.path,
          );
          if (result.kind === "missing") {
            items.push(
              createMissingVaultLinkItem(
                task.gid,
                link.vault_id,
                link.path,
              ),
            );
          }
        } catch (error: unknown) {
          signal.throwIfAborted();
          if (!isBrokenVaultLinkError(error)) {
            throw error;
          }
          items.push(
            createUnavailableVaultLinkItem(
              task.gid,
              link.vault_id,
              link.path,
              brokenVaultLinkErrorCodeSchema.parse(error.code),
            ),
          );
        }
      }
    }
    signal.throwIfAborted();
    return this.replaceBrokenVaultLinks(items);
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
