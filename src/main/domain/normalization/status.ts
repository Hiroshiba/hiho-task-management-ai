import { gidSchema } from "../../../shared/domain/primitives";
import {
  cleanupItemSchema,
  taskStatusSchema,
  type CleanupItem,
  type TaskStatus,
} from "../../../shared/domain/schemas";

export type ActiveTaskStatus = "not_started" | "in_progress";

export type StatusSectionConfiguration = {
  readonly not_started: string;
  readonly in_progress: string;
  readonly completed: string;
  readonly withdrawn: string;
};

export type StatusObservation = {
  readonly section_gid?: string;
  readonly section_name?: string;
  readonly completed: boolean;
};

export type PreviousStatusSnapshot = {
  readonly section_gid?: string;
  readonly status: TaskStatus;
  readonly completed: boolean;
};

export type StatusReconciliationInput = {
  readonly task_gid: string;
  readonly sections: StatusSectionConfiguration;
  readonly current: StatusObservation;
  readonly previous?: PreviousStatusSnapshot;
  readonly last_active_status?: ActiveTaskStatus;
};

export type StatusWrite =
  | {
      readonly kind: "move_section";
      readonly section_gid: string;
      readonly status: TaskStatus;
    }
  | {
      readonly kind: "set_completed";
      readonly completed: boolean;
    };

export type LastActiveStatusUpdate =
  | {
      readonly kind: "set";
      readonly value: ActiveTaskStatus;
    }
  | {
      readonly kind: "unchanged";
    };

export type StatusNotification = {
  readonly kind: "status_reconciled";
  readonly message: string;
  readonly status: TaskStatus;
};

type StatusReconciledResult = {
  readonly kind: "reconciled";
  readonly task_gid: string;
  readonly status: TaskStatus;
  readonly section_gid: string;
  readonly completed: boolean;
  readonly writes: readonly StatusWrite[];
  readonly last_active_status: LastActiveStatusUpdate;
  readonly warnings: readonly string[];
  readonly notification?: StatusNotification;
};

type StatusRequiresCleanupResult = {
  readonly kind: "requires_cleanup";
  readonly task_gid: string;
  readonly section_gid: string;
  readonly completed: boolean;
  readonly writes: readonly [];
  readonly last_active_status: {
    readonly kind: "unchanged";
  };
  readonly warnings: readonly [];
  readonly cleanup_item: CleanupItem;
};

export type StatusReconciliationResult =
  | StatusReconciledResult
  | StatusRequiresCleanupResult;

type StatusDefinition = {
  readonly status: TaskStatus;
  readonly gid: string;
  readonly expected_name: string;
  readonly completed: boolean;
};

/** 状態セクション設定の不備を表すエラーです。 */
export class StatusSectionConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StatusSectionConfigurationError";
  }
}

/** 不明な状態セクションへの書き込みを表すエラーです。 */
export class UnknownStatusSectionError extends Error {
  public constructor(sectionGid: string) {
    super(`不明な状態セクションGID ${sectionGid} への書き込みはできません。`);
    this.name = "UnknownStatusSectionError";
  }
}

function buildDefinitions(
  configuration: StatusSectionConfiguration,
): readonly StatusDefinition[] {
  const definitions: readonly StatusDefinition[] = [
    {
      status: "not_started",
      gid: configuration.not_started,
      expected_name: "01 未着手",
      completed: false,
    },
    {
      status: "in_progress",
      gid: configuration.in_progress,
      expected_name: "02 進行中",
      completed: false,
    },
    {
      status: "completed",
      gid: configuration.completed,
      expected_name: "90 完了",
      completed: true,
    },
    {
      status: "withdrawn",
      gid: configuration.withdrawn,
      expected_name: "99 取り下げ",
      completed: true,
    },
  ];

  const seen = new Set<string>();
  for (const definition of definitions) {
    const parsedGid = gidSchema.safeParse(definition.gid);
    if (!parsedGid.success) {
      throw new StatusSectionConfigurationError(
        `${definition.status} の状態セクションGIDが設定されていません。`,
      );
    }
    if (seen.has(parsedGid.data)) {
      throw new StatusSectionConfigurationError(
        `状態セクションGID ${parsedGid.data} が重複しています。`,
      );
    }
    seen.add(parsedGid.data);
  }

  return definitions;
}

function findDefinition(
  definitions: readonly StatusDefinition[],
  sectionGid: string,
): StatusDefinition | undefined {
  return definitions.find((definition) => definition.gid === sectionGid);
}

function findDefinitionByStatus(
  definitions: readonly StatusDefinition[],
  status: TaskStatus,
): StatusDefinition {
  const definition = definitions.find((candidate) => candidate.status === status);
  if (definition == null) {
    throw new StatusSectionConfigurationError(
      `${status} の状態セクションが設定されていません。`,
    );
  }
  return definition;
}

function isActiveStatus(status: TaskStatus): status is ActiveTaskStatus {
  return status === "not_started" || status === "in_progress";
}

function validateActiveStatus(status: ActiveTaskStatus): void {
  if (!isActiveStatus(status)) {
    throw new Error("last_active_statusにはアクティブ状態を指定してください。");
  }
}

function createUnknownStatusCleanup(
  taskGid: string,
  sectionGid: string,
): CleanupItem {
  return cleanupItemSchema.parse({
    kind: "unknown_status_section",
    task_gid: taskGid,
    message: `タスクGID ${taskGid} は不明な状態セクションGID ${sectionGid} にあるため、要整理です。`,
  });
}

function chooseInitialStatus(
  currentDefinition: StatusDefinition | undefined,
  completed: boolean,
): TaskStatus {
  if (currentDefinition?.status === "withdrawn") {
    return "withdrawn";
  }
  if (currentDefinition?.status === "completed" || completed) {
    return "completed";
  }
  if (currentDefinition?.status === "in_progress") {
    return "in_progress";
  }
  return "not_started";
}

function chooseStatusWithoutSection(
  completed: boolean,
  lastActiveStatus: ActiveTaskStatus | undefined,
): TaskStatus {
  if (completed) {
    return "completed";
  }
  return lastActiveStatus ?? "not_started";
}

function chooseActiveStatus(
  lastActiveStatus: ActiveTaskStatus | undefined,
): ActiveTaskStatus {
  return lastActiveStatus ?? "not_started";
}

function chooseStatus(
  input: StatusReconciliationInput,
  currentDefinition: StatusDefinition | undefined,
): TaskStatus {
  const previous = input.previous;
  if (previous == null) {
    return chooseInitialStatus(currentDefinition, input.current.completed);
  }

  const sectionChanged = input.current.section_gid != previous.section_gid;
  const completedChanged = input.current.completed !== previous.completed;

  if (sectionChanged) {
    if (currentDefinition != null) {
      return currentDefinition.status;
    }
    return chooseStatusWithoutSection(
      input.current.completed,
      input.last_active_status,
    );
  }

  if (completedChanged) {
    if (input.current.completed) {
      return "completed";
    }
    return chooseActiveStatus(input.last_active_status);
  }

  if (currentDefinition != null) {
    return currentDefinition.status;
  }
  return chooseStatusWithoutSection(input.current.completed, input.last_active_status);
}

function createLastActiveStatusUpdate(
  input: StatusReconciliationInput,
  status: TaskStatus,
): LastActiveStatusUpdate {
  if (isActiveStatus(status)) {
    if (input.last_active_status != status) {
      return { kind: "set", value: status };
    }
    return { kind: "unchanged" };
  }

  const previousStatus = input.previous?.status;
  if (previousStatus != null && isActiveStatus(previousStatus)) {
    if (input.last_active_status != previousStatus) {
      return { kind: "set", value: previousStatus };
    }
  }
  return { kind: "unchanged" };
}

function getStatusName(status: TaskStatus): string {
  const statusNames: { readonly [key in TaskStatus]: string } = {
    not_started: "未着手",
    in_progress: "進行中",
    completed: "完了",
    withdrawn: "取り下げ",
  };
  return statusNames[status];
}

function createStatusNotification(status: TaskStatus): StatusNotification {
  return {
    kind: "status_reconciled",
    message: `タスク状態を「${getStatusName(status)}」へ整合化しました。`,
    status,
  };
}

/** 状態セクションへの書き込み可否を検証します。 */
export function assertKnownStatusSectionForWrite(
  sections: StatusSectionConfiguration,
  sectionGid: string,
): void {
  const definitions = buildDefinitions(sections);
  const parsedGid = gidSchema.safeParse(sectionGid);
  if (!parsedGid.success || findDefinition(definitions, parsedGid.data) == null) {
    throw new UnknownStatusSectionError(sectionGid);
  }
}

/** Asanaの状態セクションと完了フラグを正規状態へ整合化します。 */
export function reconcileTaskStatus(
  input: StatusReconciliationInput,
): StatusReconciliationResult {
  gidSchema.parse(input.task_gid);
  if (input.last_active_status != null) {
    validateActiveStatus(input.last_active_status);
  }
  if (input.previous != null) {
    taskStatusSchema.parse(input.previous.status);
    if (input.previous.section_gid != null) {
      gidSchema.parse(input.previous.section_gid);
    }
  }
  const definitions = buildDefinitions(input.sections);
  let currentDefinition: StatusDefinition | undefined;
  if (input.current.section_gid != null) {
    const parsedGid = gidSchema.parse(input.current.section_gid);
    currentDefinition = findDefinition(definitions, parsedGid);
    if (currentDefinition == null) {
      return {
        kind: "requires_cleanup",
        task_gid: input.task_gid,
        section_gid: parsedGid,
        completed: input.current.completed,
        writes: [],
        last_active_status: { kind: "unchanged" },
        warnings: [],
        cleanup_item: createUnknownStatusCleanup(input.task_gid, parsedGid),
      };
    }
  }

  const warnings: string[] = [];
  if (
    currentDefinition != null &&
    input.current.section_name != null &&
    input.current.section_name !== currentDefinition.expected_name
  ) {
    warnings.push(
      `状態セクションGID ${currentDefinition.gid} の名前が ${currentDefinition.expected_name} から変更されています。`,
    );
  }

  const status = chooseStatus(input, currentDefinition);
  const targetDefinition = findDefinitionByStatus(definitions, status);
  const writes: StatusWrite[] = [];
  if (input.current.section_gid != targetDefinition.gid) {
    writes.push({
      kind: "move_section",
      section_gid: targetDefinition.gid,
      status,
    });
  }
  if (input.current.completed !== targetDefinition.completed) {
    writes.push({
      kind: "set_completed",
      completed: targetDefinition.completed,
    });
  }

  const lastActiveStatus = createLastActiveStatusUpdate(input, status);
  const result: StatusReconciledResult = {
    kind: "reconciled",
    task_gid: input.task_gid,
    status,
    section_gid: targetDefinition.gid,
    completed: targetDefinition.completed,
    writes,
    last_active_status: lastActiveStatus,
    warnings,
  };
  if (writes.length === 0 && lastActiveStatus.kind === "unchanged") {
    return result;
  }
  return {
    ...result,
    notification: createStatusNotification(status),
  };
}
