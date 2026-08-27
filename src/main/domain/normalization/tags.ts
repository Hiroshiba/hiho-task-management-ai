import {
  areaTagNameSchema,
  blockStateSchema,
  gidSchema,
  taskTagSchema,
  type Area,
  type BlockState,
  type CleanupItem,
  type Importance,
  type TaskTag,
} from "../../../shared/domain";

const importanceTagDefinitions: readonly {
  readonly value: Importance;
  readonly name: string;
}[] = [
  { value: 1, name: "TaskHub/重要度/1" },
  { value: 2, name: "TaskHub/重要度/2" },
  { value: 3, name: "TaskHub/重要度/3" },
  { value: 4, name: "TaskHub/重要度/4" },
  { value: 5, name: "TaskHub/重要度/5" },
];

const blockTagDefinitions: readonly {
  readonly state: BlockState;
  readonly name: string;
}[] = [
  { state: "none", name: "TaskHub/ブロック/なし" },
  { state: "partial", name: "TaskHub/ブロック/一部" },
  { state: "full", name: "TaskHub/ブロック/完全" },
];

const areaTagPrefix = "TaskHub/領域/";
const unclassifiedArea = "未分類";

export type TagNormalizationInput = {
  readonly task_gid: string;
  readonly tags: readonly TaskTag[];
  readonly block_state: BlockState;
};

export type TagNormalizationResult = {
  readonly importance: Importance;
  readonly area: Area;
  readonly block_state: BlockState;
  readonly retained_tags: readonly TaskTag[];
  readonly added_tag_names: readonly string[];
  readonly removed_tag_gids: readonly string[];
  readonly cleanup_items: readonly CleanupItem[];
};

function findImportanceTag(name: string): {
  readonly value: Importance;
  readonly name: string;
} | undefined {
  return importanceTagDefinitions.find((definition) => definition.name === name);
}

function findBlockTag(name: string): {
  readonly state: BlockState;
  readonly name: string;
} | undefined {
  return blockTagDefinitions.find((definition) => definition.name === name);
}

function getBlockTagName(state: BlockState): string {
  const definition = blockTagDefinitions.find((candidate) => candidate.state === state);
  if (definition == null) {
    throw new Error("ブロック状態に対応するタグが見つかりません。");
  }
  return definition.name;
}

function getCleanupMessage(
  kind: "importance" | "area",
  value: string,
  taskGid: string,
): CleanupItem {
  if (kind === "importance") {
    return {
      kind: "importance_tag_conflict",
      task_gid: taskGid,
      message: `重要度タグが複数あるため、重要度${value}を一時採用します。`,
    };
  }
  return {
    kind: "area_tag_conflict",
    task_gid: taskGid,
    message: `領域タグが複数あるため、${value}として扱います。`,
  };
}

/** タグ競合を保持しながら重要度・領域・ブロックタグを正規化します。 */
export function normalizeTaskTags(
  input: TagNormalizationInput,
): TagNormalizationResult {
  gidSchema.parse(input.task_gid);
  blockStateSchema.parse(input.block_state);

  const importanceValues: Importance[] = [];
  const areaValues: string[] = [];
  const blockTagName = getBlockTagName(input.block_state);
  const cleanupItems: CleanupItem[] = [];
  const removedTagGids: string[] = [];
  const retainedTags: TaskTag[] = [];
  const addedTagNames: string[] = [];
  let retainedExpectedBlockTag = false;

  for (const tag of input.tags) {
    taskTagSchema.parse(tag);
    const parsedTagName = areaTagNameSchema.safeParse(tag.name);
    if (!parsedTagName.success) {
      const importance = findImportanceTag(tag.name);
      if (importance != null) {
        importanceValues.push(importance.value);
      }
    }

    if (parsedTagName.success) {
      areaValues.push(tag.name.slice(areaTagPrefix.length));
    }

    const block = findBlockTag(tag.name);
    if (block != null) {
      if (tag.name === blockTagName && !retainedExpectedBlockTag) {
        retainedExpectedBlockTag = true;
        retainedTags.push(tag);
      } else {
        removedTagGids.push(tag.gid);
      }
      continue;
    }

    retainedTags.push(tag);
  }

  let importance: Importance = 3;
  let hasImportance = false;
  for (const value of importanceValues) {
    if (!hasImportance || value > importance) {
      importance = value;
      hasImportance = true;
    }
  }

  if (importanceValues.length === 0) {
    addedTagNames.push("TaskHub/重要度/3");
  } else if (importanceValues.length > 1) {
    cleanupItems.push(
      getCleanupMessage("importance", String(importance), input.task_gid),
    );
  }

  let area: Area = unclassifiedArea;
  if (areaValues.length === 1) {
    const areaValue = areaValues[0];
    if (areaValue == null) {
      throw new Error("領域タグの値が取得できません。");
    }
    area = areaValue;
  } else if (areaValues.length === 0) {
    addedTagNames.push(`${areaTagPrefix}${unclassifiedArea}`);
  } else {
    cleanupItems.push(
      getCleanupMessage("area", unclassifiedArea, input.task_gid),
    );
  }

  if (!retainedExpectedBlockTag) {
    addedTagNames.push(blockTagName);
  }

  return {
    importance,
    area,
    block_state: input.block_state,
    retained_tags: retainedTags,
    added_tag_names: addedTagNames,
    removed_tag_gids: removedTagGids,
    cleanup_items: cleanupItems,
  };
}
