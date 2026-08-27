import { z } from "zod";
import {
  asanaSectionResponseSchema,
  asanaTagResponseSchema,
  gidSchema,
  sectionGidSchema,
} from "../../../shared/domain";
import { AsanaReadClient } from "../client/client";
import { AsanaSetupClient } from "../client/setup-client";
import {
  reconcileSetupResources,
  setupManifest,
  setupReconciliationInputSchema,
  setupReconciliationResultSchema,
  type SetupReconciliationResult,
  type SetupSectionCheck,
  type SetupTagCheck,
} from "./manifest";

const configuredSectionGidsSchema = z
  .object({
    not_started: sectionGidSchema,
    in_progress: sectionGidSchema,
    completed: sectionGidSchema,
    withdrawn: sectionGidSchema,
  })
  .strict()
  .superRefine((gids, context) => {
    const seen = new Set<string>();
    for (const [name, gid] of Object.entries(gids)) {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "設定済みセクションGIDを重複して指定できません。",
        });
        continue;
      }
      seen.add(gid);
    }
  });

const configuredTagGidsSchema = z
  .object({
    importance_1: gidSchema,
    importance_2: gidSchema,
    importance_3: gidSchema,
    importance_4: gidSchema,
    importance_5: gidSchema,
    area_unclassified: gidSchema,
    block_none: gidSchema,
    block_partial: gidSchema,
    block_full: gidSchema,
  })
  .strict()
  .superRefine((gids, context) => {
    const seen = new Set<string>();
    for (const [name, gid] of Object.entries(gids)) {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "設定済みタグGIDを重複して指定できません。",
        });
        continue;
      }
      seen.add(gid);
    }
  });

const resourceCoordinatorInputSchema = z
  .object({
    workspace_gid: gidSchema,
    project_gid: gidSchema,
    configured_section_gids: configuredSectionGidsSchema.optional(),
    configured_tag_gids: configuredTagGidsSchema.optional(),
  })
  .strict();

function addUniqueGidIssues(
  gids: readonly string[],
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  gids.forEach((gid, index) => {
    if (seen.has(gid)) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: "GIDを重複して指定できません。",
      });
      return;
    }
    seen.add(gid);
  });
}

const readySectionGidsSchema = configuredSectionGidsSchema;
const readyTagGidsSchema = configuredTagGidsSchema;

const readyResultSchema = z
  .object({
    kind: z.literal("ready"),
    section_gids: readySectionGidsSchema,
    tag_gids: readyTagGidsSchema,
    additional_sections: z.array(asanaSectionResponseSchema),
    additional_tags: z.array(asanaTagResponseSchema),
    created_section_gids: z.array(sectionGidSchema),
    created_tag_gids: z.array(gidSchema),
  })
  .strict()
  .superRefine((result, context) => {
    addUniqueGidIssues(
      result.created_section_gids,
      ["created_section_gids"],
      context,
    );
    addUniqueGidIssues(
      result.created_tag_gids,
      ["created_tag_gids"],
      context,
    );
    addUniqueGidIssues(
      result.additional_sections.map((section) => section.gid),
      ["additional_sections"],
      context,
    );
    addUniqueGidIssues(
      result.additional_tags.map((tag) => tag.gid),
      ["additional_tags"],
      context,
    );
  });

const requiresActionResultSchema = z
  .object({
    kind: z.literal("requires_action"),
    reconciliation: setupReconciliationResultSchema,
  })
  .strict();

const resourceCoordinatorResultSchema = z
  .discriminatedUnion("kind", [readyResultSchema, requiresActionResultSchema])
  .superRefine((result, context) => {
    if (
      result.kind === "requires_action"
      && result.reconciliation.kind !== "requires_action"
    ) {
      context.addIssue({
        code: "custom",
        path: ["reconciliation", "kind"],
        message: "初期設定の照合結果がrequires_actionではありません。",
      });
    }
  });

export type AsanaSetupResourceCoordinatorInput = z.infer<
  typeof resourceCoordinatorInputSchema
>;
export type AsanaSetupResourceCoordinatorResult = z.infer<
  typeof resourceCoordinatorResultSchema
>;

/** 初期設定リソース調整の入力を検証するスキーマです。 */
export const asanaSetupResourceCoordinatorInputSchema =
  resourceCoordinatorInputSchema;

/** 初期設定リソース調整の結果を検証するスキーマです。 */
export const asanaSetupResourceCoordinatorResultSchema =
  resourceCoordinatorResultSchema;

type AsanaSectionResponse = z.infer<typeof asanaSectionResponseSchema>;
type AsanaTagResponse = z.infer<typeof asanaTagResponseSchema>;
type SetupReadyResult = Extract<
  SetupReconciliationResult,
  { kind: "ready" }
>;

function hasBlockingIssue(
  reconciliation: SetupReconciliationResult,
): boolean {
  if (reconciliation.kind === "ready") {
    return false;
  }
  return (
    reconciliation.sections.some(isBlockingSectionIssue)
    || reconciliation.tags.some(isBlockingTagIssue)
  );
}

function isBlockingSectionIssue(check: SetupSectionCheck): boolean {
  switch (check.kind) {
    case "duplicate":
    case "renamed":
      return true;
    case "missing":
      return check.configured_gid != null;
    case "matched":
      return false;
  }
}

function isBlockingTagIssue(check: SetupTagCheck): boolean {
  switch (check.kind) {
    case "duplicate":
    case "renamed":
      return true;
    case "missing":
      return check.configured_gid != null;
    case "matched":
      return false;
  }
}

function createReconciliationInput(
  sections: readonly AsanaSectionResponse[],
  tags: readonly AsanaTagResponse[],
  input: AsanaSetupResourceCoordinatorInput,
): z.infer<typeof setupReconciliationInputSchema> {
  return {
    sections: [...sections],
    tags: [...tags],
    ...(input.configured_section_gids == null
      ? {}
      : { configured_section_gids: input.configured_section_gids }),
    ...(input.configured_tag_gids == null
      ? {}
      : { configured_tag_gids: input.configured_tag_gids }),
  };
}

function findMatchedSectionGid(
  checks: readonly SetupSectionCheck[],
  status: "not_started" | "in_progress" | "completed" | "withdrawn",
): string {
  const check = checks.find((candidate) => candidate.required.status === status);
  if (check == null || check.kind !== "matched") {
    throw new Error("必須セクションのGIDを確定できません。");
  }
  return sectionGidSchema.parse(check.resource.gid);
}

function findMatchedTagGid(
  checks: readonly SetupTagCheck[],
  name: string,
): string {
  const check = checks.find((candidate) => candidate.required.name === name);
  if (check == null || check.kind !== "matched") {
    throw new Error("必須タグのGIDを確定できません。");
  }
  return gidSchema.parse(check.resource.gid);
}

function getManifestTagName(index: number): string {
  const declaration = setupManifest.tags[index];
  if (declaration == null) {
    throw new Error("必須タグのmanifest定義を取得できません。");
  }
  return declaration.name;
}

function buildReadyResult(
  reconciliation: SetupReadyResult,
  createdSectionGids: readonly string[],
  createdTagGids: readonly string[],
): AsanaSetupResourceCoordinatorResult {
  const sectionGids = {
    not_started: findMatchedSectionGid(reconciliation.sections, "not_started"),
    in_progress: findMatchedSectionGid(reconciliation.sections, "in_progress"),
    completed: findMatchedSectionGid(reconciliation.sections, "completed"),
    withdrawn: findMatchedSectionGid(reconciliation.sections, "withdrawn"),
  };
  const tagGids = {
    importance_1: findMatchedTagGid(
      reconciliation.tags,
      getManifestTagName(0),
    ),
    importance_2: findMatchedTagGid(
      reconciliation.tags,
      getManifestTagName(1),
    ),
    importance_3: findMatchedTagGid(
      reconciliation.tags,
      getManifestTagName(2),
    ),
    importance_4: findMatchedTagGid(
      reconciliation.tags,
      getManifestTagName(3),
    ),
    importance_5: findMatchedTagGid(
      reconciliation.tags,
      getManifestTagName(4),
    ),
    area_unclassified: findMatchedTagGid(
      reconciliation.tags,
      getManifestTagName(5),
    ),
    block_none: findMatchedTagGid(
      reconciliation.tags,
      getManifestTagName(6),
    ),
    block_partial: findMatchedTagGid(
      reconciliation.tags,
      getManifestTagName(7),
    ),
    block_full: findMatchedTagGid(
      reconciliation.tags,
      getManifestTagName(8),
    ),
  };
  return resourceCoordinatorResultSchema.parse({
    kind: "ready",
    section_gids: sectionGids,
    tag_gids: tagGids,
    additional_sections: reconciliation.additional_sections,
    additional_tags: reconciliation.additional_tags,
    created_section_gids: [...createdSectionGids],
    created_tag_gids: [...createdTagGids],
  });
}

function assertCreatedSection(
  section: AsanaSectionResponse,
  requiredName: string,
  existingGids: Set<string>,
  createdGids: Set<string>,
): string {
  const gid = sectionGidSchema.parse(section.gid);
  if (section.name !== requiredName) {
    throw new Error("作成した必須セクションの名前が要求と一致しません。");
  }
  if (existingGids.has(gid) || createdGids.has(gid)) {
    throw new Error("作成した必須セクションのGIDが重複しています。");
  }
  createdGids.add(gid);
  return gid;
}

function assertCreatedTag(
  tag: AsanaTagResponse,
  requiredName: string,
  existingGids: Set<string>,
  createdGids: Set<string>,
): string {
  const gid = gidSchema.parse(tag.gid);
  if (tag.name !== requiredName) {
    throw new Error("作成した必須タグの名前が要求と一致しません。");
  }
  if (existingGids.has(gid) || createdGids.has(gid)) {
    throw new Error("作成した必須タグのGIDが重複しています。");
  }
  createdGids.add(gid);
  return gid;
}

async function createMissingSections(
  setupClient: AsanaSetupClient,
  projectGid: string,
  checks: readonly SetupSectionCheck[],
  existingSections: readonly AsanaSectionResponse[],
  signal: AbortSignal,
): Promise<readonly string[]> {
  const existingGids = new Set(existingSections.map((section) => section.gid));
  const createdGids = new Set<string>();
  const createdSectionGids: string[] = [];
  for (const check of checks) {
    switch (check.kind) {
      case "matched":
        continue;
      case "missing": {
        if (check.configured_gid != null) {
          throw new Error("設定済みセクションGIDを自動作成できません。");
        }
        const created = await setupClient.createSection(
          projectGid,
          check.required.name,
          signal,
        );
        const gid = assertCreatedSection(
          created,
          check.required.name,
          existingGids,
          createdGids,
        );
        createdSectionGids.push(gid);
        continue;
      }
      case "duplicate":
      case "renamed":
        throw new Error("初期設定のセクション照合結果を自動解決できません。");
    }
  }
  return createdSectionGids;
}

async function createMissingTags(
  setupClient: AsanaSetupClient,
  workspaceGid: string,
  checks: readonly SetupTagCheck[],
  existingTags: readonly AsanaTagResponse[],
  signal: AbortSignal,
): Promise<readonly string[]> {
  const existingGids = new Set(existingTags.map((tag) => tag.gid));
  const createdGids = new Set<string>();
  const createdTagGids: string[] = [];
  for (const check of checks) {
    switch (check.kind) {
      case "matched":
        continue;
      case "missing": {
        if (check.configured_gid != null) {
          throw new Error("設定済みタグGIDを自動作成できません。");
        }
        const created = await setupClient.createTag(
          workspaceGid,
          check.required.name,
          signal,
        );
        const gid = assertCreatedTag(
          created,
          check.required.name,
          existingGids,
          createdGids,
        );
        createdTagGids.push(gid);
        continue;
      }
      case "duplicate":
      case "renamed":
        throw new Error("初期設定のタグ照合結果を自動解決できません。");
    }
  }
  return createdTagGids;
}

function assertCreatedResourcesPresent(
  sections: readonly AsanaSectionResponse[],
  tags: readonly AsanaTagResponse[],
  createdSectionGids: readonly string[],
  createdTagGids: readonly string[],
): void {
  const sectionGids = new Set(sections.map((section) => section.gid));
  for (const gid of createdSectionGids) {
    if (!sectionGids.has(gid)) {
      throw new Error("作成した必須セクションを再取得できません。");
    }
  }
  const tagGids = new Set(tags.map((tag) => tag.gid));
  for (const gid of createdTagGids) {
    if (!tagGids.has(gid)) {
      throw new Error("作成した必須タグを再取得できません。");
    }
  }
}

/** 初期設定に必要なAsanaリソースの作成を安全に調整します。 */
export class AsanaSetupResourceCoordinator {
  private readonly setupClient: AsanaSetupClient;
  private readonly readClient: AsanaReadClient;

  public constructor(
    setupClient: AsanaSetupClient,
    readClient: AsanaReadClient,
  ) {
    this.setupClient = setupClient;
    this.readClient = readClient;
  }

  /** 初期設定リソースを照合し必要な不足分だけ作成します。 */
  public async coordinate(
    input: AsanaSetupResourceCoordinatorInput,
    signal: AbortSignal,
  ): Promise<AsanaSetupResourceCoordinatorResult> {
    const validatedInput = resourceCoordinatorInputSchema.parse(input);
    const project = await this.readClient.getProject(
      validatedInput.project_gid,
      signal,
    );
    if (
      project.gid !== validatedInput.project_gid
      || project.workspace.gid !== validatedInput.workspace_gid
    ) {
      throw new Error("Asanaプロジェクトとワークスペースが入力と一致しません。");
    }
    const sections = await this.readClient.listProjectSections(
      validatedInput.project_gid,
      signal,
    );
    const tags = await this.readClient.listWorkspaceTags(
      validatedInput.workspace_gid,
      signal,
    );
    const reconciliation = reconcileSetupResources(
      createReconciliationInput(sections, tags, validatedInput),
    );
    if (hasBlockingIssue(reconciliation)) {
      return resourceCoordinatorResultSchema.parse({
        kind: "requires_action",
        reconciliation,
      });
    }
    if (reconciliation.kind === "ready") {
      return buildReadyResult(reconciliation, [], []);
    }
    const createdSectionGids = await createMissingSections(
      this.setupClient,
      validatedInput.project_gid,
      reconciliation.sections,
      sections,
      signal,
    );
    const createdTagGids = await createMissingTags(
      this.setupClient,
      validatedInput.workspace_gid,
      reconciliation.tags,
      tags,
      signal,
    );
    const refreshedSections = await this.readClient.listProjectSections(
      validatedInput.project_gid,
      signal,
    );
    const refreshedTags = await this.readClient.listWorkspaceTags(
      validatedInput.workspace_gid,
      signal,
    );
    assertCreatedResourcesPresent(
      refreshedSections,
      refreshedTags,
      createdSectionGids,
      createdTagGids,
    );
    const refreshedReconciliation = reconcileSetupResources({
      sections: [...refreshedSections],
      tags: [...refreshedTags],
    });
    if (refreshedReconciliation.kind !== "ready") {
      throw new Error("初期設定リソースの再照合に失敗しました。");
    }
    return buildReadyResult(
      refreshedReconciliation,
      createdSectionGids,
      createdTagGids,
    );
  }
}
