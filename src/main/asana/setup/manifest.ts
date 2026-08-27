import { z } from "zod";
import {
  asanaSectionResponseSchema,
  asanaTagResponseSchema,
  blockTagNameSchema,
  gidSchema,
  importanceTagNameSchema,
  sectionGidSchema,
} from "../../../shared/domain";

const manifestSectionDefinitions = [
  {
    order: 1,
    name: "01 未着手",
    status: "not_started",
    completed: false,
  },
  {
    order: 2,
    name: "02 進行中",
    status: "in_progress",
    completed: false,
  },
  {
    order: 3,
    name: "90 完了",
    status: "completed",
    completed: true,
  },
  {
    order: 4,
    name: "99 取り下げ",
    status: "withdrawn",
    completed: true,
  },
];

const manifestTagDefinitions = [
  { kind: "importance", name: "TaskHub/重要度/1" },
  { kind: "importance", name: "TaskHub/重要度/2" },
  { kind: "importance", name: "TaskHub/重要度/3" },
  { kind: "importance", name: "TaskHub/重要度/4" },
  { kind: "importance", name: "TaskHub/重要度/5" },
  { kind: "area", name: "TaskHub/領域/未分類" },
  { kind: "block", name: "TaskHub/ブロック/なし" },
  { kind: "block", name: "TaskHub/ブロック/一部" },
  { kind: "block", name: "TaskHub/ブロック/完全" },
];

const setupSectionDeclarationSchema = z.discriminatedUnion("name", [
  z
    .object({
      order: z.literal(1),
      name: z.literal("01 未着手"),
      status: z.literal("not_started"),
      completed: z.literal(false),
    })
    .strict(),
  z
    .object({
      order: z.literal(2),
      name: z.literal("02 進行中"),
      status: z.literal("in_progress"),
      completed: z.literal(false),
    })
    .strict(),
  z
    .object({
      order: z.literal(3),
      name: z.literal("90 完了"),
      status: z.literal("completed"),
      completed: z.literal(true),
    })
    .strict(),
  z
    .object({
      order: z.literal(4),
      name: z.literal("99 取り下げ"),
      status: z.literal("withdrawn"),
      completed: z.literal(true),
    })
    .strict(),
]);

const setupTagDeclarationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("importance"),
      name: importanceTagNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("area"),
      name: z.literal("TaskHub/領域/未分類"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("block"),
      name: blockTagNameSchema,
    })
    .strict(),
]);

/** 初期設定で必要なセクションとタグの宣言を検証するスキーマです。 */
export const setupManifestSchema = z
  .object({
    sections: z.array(setupSectionDeclarationSchema).length(4),
    tags: z.array(setupTagDeclarationSchema).length(9),
  })
  .strict()
  .superRefine((manifest, context) => {
    manifestSectionDefinitions.forEach((expected, index) => {
      const actual = manifest.sections[index];
      if (
        actual == null
        || actual.order !== expected.order
        || actual.name !== expected.name
        || actual.status !== expected.status
        || actual.completed !== expected.completed
      ) {
        context.addIssue({
          code: "custom",
          path: ["sections", index],
          message: "必須セクションの順序または状態定義が不正です。",
        });
      }
    });
    manifestTagDefinitions.forEach((expected, index) => {
      const actual = manifest.tags[index];
      if (
        actual == null
        || actual.kind !== expected.kind
        || actual.name !== expected.name
      ) {
        context.addIssue({
          code: "custom",
          path: ["tags", index],
          message: "必須タグの順序または名前が不正です。",
        });
      }
    });
  });

/** 初期設定で使用する必須セクションとタグを宣言します。 */
export const setupManifest = setupManifestSchema.parse({
  sections: manifestSectionDefinitions,
  tags: manifestTagDefinitions,
});

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
    Object.entries(gids).forEach(([name, gid]) => {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "設定済みセクションGIDを重複して指定できません。",
        });
        return;
      }
      seen.add(gid);
    });
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
    Object.entries(gids).forEach(([name, gid]) => {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "設定済みタグGIDを重複して指定できません。",
        });
        return;
      }
      seen.add(gid);
    });
  });

const setupSectionResourcesSchema = z
  .array(asanaSectionResponseSchema)
  .superRefine((sections, context) => {
    const seen = new Set<string>();
    sections.forEach((section, index) => {
      if (seen.has(section.gid)) {
        context.addIssue({
          code: "custom",
          path: [index, "gid"],
          message: "取得済みセクションGIDを重複して指定できません。",
        });
        return;
      }
      seen.add(section.gid);
    });
  });

const setupTagResourcesSchema = z
  .array(asanaTagResponseSchema)
  .superRefine((tags, context) => {
    const seen = new Set<string>();
    tags.forEach((tag, index) => {
      if (seen.has(tag.gid)) {
        context.addIssue({
          code: "custom",
          path: [index, "gid"],
          message: "取得済みタグGIDを重複して指定できません。",
        });
        return;
      }
      seen.add(tag.gid);
    });
  });

/** 初期設定の照合入力を検証するスキーマです。 */
export const setupReconciliationInputSchema = z
  .object({
    sections: setupSectionResourcesSchema,
    tags: setupTagResourcesSchema,
    configured_section_gids: configuredSectionGidsSchema.optional(),
    configured_tag_gids: configuredTagGidsSchema.optional(),
  })
  .strict();

type SetupSectionDeclaration = z.infer<typeof setupSectionDeclarationSchema>;
type SetupTagDeclaration = z.infer<typeof setupTagDeclarationSchema>;
type SetupSectionResource = z.infer<typeof asanaSectionResponseSchema>;
type SetupTagResource = z.infer<typeof asanaTagResponseSchema>;
type ConfiguredSectionGids = z.infer<typeof configuredSectionGidsSchema>;
type ConfiguredTagGids = z.infer<typeof configuredTagGidsSchema>;

const matchedSectionSchema = z
  .object({
    kind: z.literal("matched"),
    required: setupSectionDeclarationSchema,
    resource: asanaSectionResponseSchema,
  })
  .strict();

const missingSectionSchema = z
  .object({
    kind: z.literal("missing"),
    required: setupSectionDeclarationSchema,
    configured_gid: sectionGidSchema.optional(),
  })
  .strict();

const duplicateSectionSchema = z
  .object({
    kind: z.literal("duplicate"),
    required: setupSectionDeclarationSchema,
    resources: z.array(asanaSectionResponseSchema).min(2),
  })
  .strict();

const renamedSectionSchema = z
  .object({
    kind: z.literal("renamed"),
    required: setupSectionDeclarationSchema,
    configured_gid: sectionGidSchema,
    resource: asanaSectionResponseSchema,
  })
  .strict();

const setupSectionCheckSchema = z.discriminatedUnion("kind", [
  matchedSectionSchema,
  missingSectionSchema,
  duplicateSectionSchema,
  renamedSectionSchema,
]);

const matchedTagSchema = z
  .object({
    kind: z.literal("matched"),
    required: setupTagDeclarationSchema,
    resource: asanaTagResponseSchema,
  })
  .strict();

const missingTagSchema = z
  .object({
    kind: z.literal("missing"),
    required: setupTagDeclarationSchema,
    configured_gid: gidSchema.optional(),
  })
  .strict();

const duplicateTagSchema = z
  .object({
    kind: z.literal("duplicate"),
    required: setupTagDeclarationSchema,
    resources: z.array(asanaTagResponseSchema).min(2),
  })
  .strict();

const renamedTagSchema = z
  .object({
    kind: z.literal("renamed"),
    required: setupTagDeclarationSchema,
    configured_gid: gidSchema,
    resource: asanaTagResponseSchema,
  })
  .strict();

const setupTagCheckSchema = z.discriminatedUnion("kind", [
  matchedTagSchema,
  missingTagSchema,
  duplicateTagSchema,
  renamedTagSchema,
]);

function isSameSectionDeclaration(
  actual: SetupSectionDeclaration,
  expected: SetupSectionDeclaration,
): boolean {
  return (
    actual.order === expected.order
    && actual.name === expected.name
    && actual.status === expected.status
    && actual.completed === expected.completed
  );
}

function isSameTagDeclaration(
  actual: SetupTagDeclaration,
  expected: SetupTagDeclaration,
): boolean {
  return actual.kind === expected.kind && actual.name === expected.name;
}

function validateSectionCheckOrder(
  checks: readonly { readonly required: SetupSectionDeclaration }[],
  context: z.RefinementCtx,
): void {
  setupManifest.sections.forEach((expected, index) => {
    const actual = checks[index];
    if (actual == null || !isSameSectionDeclaration(actual.required, expected)) {
      context.addIssue({
        code: "custom",
        path: [index, "required"],
        message: "セクション照合結果の宣言順序が必須定義と一致しません。",
      });
    }
  });
}

function validateTagCheckOrder(
  checks: readonly { readonly required: SetupTagDeclaration }[],
  context: z.RefinementCtx,
): void {
  setupManifest.tags.forEach((expected, index) => {
    const actual = checks[index];
    if (actual == null || !isSameTagDeclaration(actual.required, expected)) {
      context.addIssue({
        code: "custom",
        path: [index, "required"],
        message: "タグ照合結果の宣言順序が必須定義と一致しません。",
      });
    }
  });
}

const setupSectionChecksSchema = z
  .array(setupSectionCheckSchema)
  .length(4)
  .superRefine(validateSectionCheckOrder);

const setupTagChecksSchema = z
  .array(setupTagCheckSchema)
  .length(9)
  .superRefine(validateTagCheckOrder);

const matchedSectionResultsSchema = z
  .array(matchedSectionSchema)
  .length(4)
  .superRefine(validateSectionCheckOrder);

const matchedTagResultsSchema = z
  .array(matchedTagSchema)
  .length(9)
  .superRefine(validateTagCheckOrder);

const readySetupReconciliationSchema = z
  .object({
    kind: z.literal("ready"),
    sections: matchedSectionResultsSchema,
    tags: matchedTagResultsSchema,
    additional_sections: z.array(asanaSectionResponseSchema),
    additional_tags: z.array(asanaTagResponseSchema),
  })
  .strict();

const requiresActionSetupReconciliationSchema = z
  .object({
    kind: z.literal("requires_action"),
    sections: setupSectionChecksSchema,
    tags: setupTagChecksSchema,
    additional_sections: z.array(asanaSectionResponseSchema),
    additional_tags: z.array(asanaTagResponseSchema),
  })
  .strict();

/** 初期設定の照合結果を検証するスキーマです。 */
export const setupReconciliationResultSchema = z.discriminatedUnion("kind", [
  readySetupReconciliationSchema,
  requiresActionSetupReconciliationSchema,
]);

export type SetupManifest = z.infer<typeof setupManifestSchema>;
export type SetupReconciliationInput = z.infer<
  typeof setupReconciliationInputSchema
>;
export type SetupSectionCheck = z.infer<typeof setupSectionCheckSchema>;
export type SetupTagCheck = z.infer<typeof setupTagCheckSchema>;
export type SetupReconciliationResult = z.infer<
  typeof setupReconciliationResultSchema
>;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function getConfiguredSectionGid(
  configured: ConfiguredSectionGids | undefined,
  declaration: SetupSectionDeclaration,
): string | undefined {
  if (configured == null) {
    return undefined;
  }
  switch (declaration.status) {
    case "not_started":
      return configured.not_started;
    case "in_progress":
      return configured.in_progress;
    case "completed":
      return configured.completed;
    case "withdrawn":
      return configured.withdrawn;
  }
}

function getConfiguredTagGid(
  configured: ConfiguredTagGids | undefined,
  declaration: SetupTagDeclaration,
): string | undefined {
  if (configured == null) {
    return undefined;
  }
  if (declaration.kind === "area") {
    return configured.area_unclassified;
  }
  if (declaration.kind === "importance") {
    switch (declaration.name) {
      case "TaskHub/重要度/1":
        return configured.importance_1;
      case "TaskHub/重要度/2":
        return configured.importance_2;
      case "TaskHub/重要度/3":
        return configured.importance_3;
      case "TaskHub/重要度/4":
        return configured.importance_4;
      case "TaskHub/重要度/5":
        return configured.importance_5;
    }
  }
  switch (declaration.name) {
    case "TaskHub/ブロック/なし":
      return configured.block_none;
    case "TaskHub/ブロック/一部":
      return configured.block_partial;
    case "TaskHub/ブロック/完全":
      return configured.block_full;
  }
}

function createMissingSectionCheck(
  declaration: SetupSectionDeclaration,
  configuredGid: string | undefined,
): SetupSectionCheck {
  if (configuredGid == null) {
    return { kind: "missing", required: declaration };
  }
  return {
    kind: "missing",
    required: declaration,
    configured_gid: configuredGid,
  };
}

function createMissingTagCheck(
  declaration: SetupTagDeclaration,
  configuredGid: string | undefined,
): SetupTagCheck {
  if (configuredGid == null) {
    return { kind: "missing", required: declaration };
  }
  return {
    kind: "missing",
    required: declaration,
    configured_gid: configuredGid,
  };
}

function reconcileSectionDeclaration(
  declaration: SetupSectionDeclaration,
  resources: readonly SetupSectionResource[],
  configuredGid: string | undefined,
  consumedGids: Set<string>,
): SetupSectionCheck {
  const namedResources = resources.filter(
    (resource) => resource.name === declaration.name,
  );
  if (namedResources.length > 1) {
    namedResources.forEach((resource) => consumedGids.add(resource.gid));
    return {
      kind: "duplicate",
      required: declaration,
      resources: namedResources,
    };
  }

  if (configuredGid != null) {
    const configuredResource = resources.find(
      (resource) => resource.gid === configuredGid,
    );
    if (configuredResource == null) {
      return createMissingSectionCheck(declaration, configuredGid);
    }
    consumedGids.add(configuredResource.gid);
    if (configuredResource.name !== declaration.name) {
      return {
        kind: "renamed",
        required: declaration,
        configured_gid: configuredGid,
        resource: configuredResource,
      };
    }
    return {
      kind: "matched",
      required: declaration,
      resource: configuredResource,
    };
  }

  const namedResource = namedResources[0];
  if (namedResource == null) {
    return createMissingSectionCheck(declaration, configuredGid);
  }
  consumedGids.add(namedResource.gid);
  return {
    kind: "matched",
    required: declaration,
    resource: namedResource,
  };
}

function reconcileTagDeclaration(
  declaration: SetupTagDeclaration,
  resources: readonly SetupTagResource[],
  configuredGid: string | undefined,
  consumedGids: Set<string>,
): SetupTagCheck {
  const namedResources = resources.filter(
    (resource) => resource.name === declaration.name,
  );
  if (namedResources.length > 1) {
    namedResources.forEach((resource) => consumedGids.add(resource.gid));
    return {
      kind: "duplicate",
      required: declaration,
      resources: namedResources,
    };
  }

  if (configuredGid != null) {
    const configuredResource = resources.find(
      (resource) => resource.gid === configuredGid,
    );
    if (configuredResource == null) {
      return createMissingTagCheck(declaration, configuredGid);
    }
    consumedGids.add(configuredResource.gid);
    if (configuredResource.name !== declaration.name) {
      return {
        kind: "renamed",
        required: declaration,
        configured_gid: configuredGid,
        resource: configuredResource,
      };
    }
    return {
      kind: "matched",
      required: declaration,
      resource: configuredResource,
    };
  }

  const namedResource = namedResources[0];
  if (namedResource == null) {
    return createMissingTagCheck(declaration, configuredGid);
  }
  consumedGids.add(namedResource.gid);
  return {
    kind: "matched",
    required: declaration,
    resource: namedResource,
  };
}

function sortSectionsByGid(
  sections: readonly SetupSectionResource[],
): SetupSectionResource[] {
  return [...sections].sort((left, right) => compareStrings(left.gid, right.gid));
}

function sortTagsByGid(
  tags: readonly SetupTagResource[],
): SetupTagResource[] {
  return [...tags].sort((left, right) => compareStrings(left.gid, right.gid));
}

/** 取得済みのAsanaセクションとタグを初期設定宣言へ照合します。 */
export function reconcileSetupResources(
  input: SetupReconciliationInput,
): SetupReconciliationResult {
  const parsedInput = setupReconciliationInputSchema.parse(input);
  const consumedSectionGids = new Set<string>();
  const consumedTagGids = new Set<string>();
  const sectionChecks = setupManifest.sections.map((declaration) =>
    reconcileSectionDeclaration(
      declaration,
      parsedInput.sections,
      getConfiguredSectionGid(
        parsedInput.configured_section_gids,
        declaration,
      ),
      consumedSectionGids,
    ),
  );
  const tagChecks = setupManifest.tags.map((declaration) =>
    reconcileTagDeclaration(
      declaration,
      parsedInput.tags,
      getConfiguredTagGid(parsedInput.configured_tag_gids, declaration),
      consumedTagGids,
    ),
  );
  const additionalSections = sortSectionsByGid(
    parsedInput.sections.filter(
      (section) => !consumedSectionGids.has(section.gid),
    ),
  );
  const additionalTags = sortTagsByGid(
    parsedInput.tags.filter((tag) => !consumedTagGids.has(tag.gid)),
  );
  const requiresAction =
    sectionChecks.some((check) => check.kind !== "matched")
    || tagChecks.some((check) => check.kind !== "matched");
  const result = requiresAction
    ? {
        kind: "requires_action",
        sections: sectionChecks,
        tags: tagChecks,
        additional_sections: additionalSections,
        additional_tags: additionalTags,
      }
    : {
        kind: "ready",
        sections: sectionChecks,
        tags: tagChecks,
        additional_sections: additionalSections,
        additional_tags: additionalTags,
      };
  return setupReconciliationResultSchema.parse(result);
}
