import {
  mapResourceIssues,
  parseProjects,
  parseWorkspaces,
  sameSectionGids,
  sameTagGids,
  type ResourceCheck,
} from "./setup-validation";

type Workspace = { readonly gid: string; readonly name: string };
type Project = { readonly gid: string; readonly name: string };
type ProjectChoice =
  | { readonly kind: "existing"; readonly project_gid: string }
  | { readonly kind: "create"; readonly name: string };

type SectionGids = {
  readonly not_started: string;
  readonly in_progress: string;
  readonly completed: string;
  readonly withdrawn: string;
};

type TagGids = {
  readonly importance_1: string;
  readonly importance_2: string;
  readonly importance_3: string;
  readonly importance_4: string;
  readonly importance_5: string;
  readonly area_unclassified: string;
  readonly block_none: string;
  readonly block_partial: string;
  readonly block_full: string;
};

type ResourceResult =
  | {
      readonly kind: "requires_action";
      readonly reconciliation: {
        readonly kind: "requires_action" | "ready";
        readonly sections: readonly ResourceCheck[];
        readonly tags: readonly ResourceCheck[];
      };
    }
  | {
      readonly kind: "ready";
      readonly section_gids: SectionGids;
      readonly tag_gids: TagGids;
    };

type AsanaResourceDependencies<TState extends { readonly kind: string }, TResourceResult extends ResourceResult> = {
  readonly deviceId: string;
  readonly codexAvailability: unknown;
  readonly coordinate: (
    input: {
      readonly workspace_gid: string;
      readonly project_gid: string;
      readonly configured_section_gids?: SectionGids;
    },
    signal: AbortSignal,
  ) => Promise<TResourceResult>;
  readonly parseResourceResult: (value: TResourceResult) => TResourceResult;
  readonly parseState: (value: unknown) => TState;
};

/** Asanaのワークスペース一覧から初期設定状態を生成します。 */
export async function listSetupWorkspaces<
  TState extends { readonly kind: string },
  TWorkspace extends Workspace,
>(
  clientId: string,
  codexAvailability: unknown,
  signal: AbortSignal,
  dependencies: {
    readonly listWorkspaces: (signal: AbortSignal) => Promise<readonly unknown[]>;
    readonly parseWorkspace: (value: unknown) => TWorkspace;
    readonly parseState: (value: unknown) => TState;
  },
): Promise<TState> {
  const workspaces = parseWorkspaces(
    await dependencies.listWorkspaces(signal),
    dependencies.parseWorkspace,
  );
  return dependencies.parseState({
    kind: "workspace_selection_required",
    step: "workspace",
    client_id: clientId,
    codex: codexAvailability,
    workspaces,
  });
}

/** 選択したワークスペースのプロジェクト一覧を取得します。 */
export async function selectSetupWorkspace<
  TState extends { readonly kind: string },
  TWorkspace extends Workspace,
  TProject extends Project,
>(
  state: {
    readonly client_id: string;
    readonly codex: unknown;
    readonly workspaces: readonly TWorkspace[];
  },
  workspaceGid: string,
  signal: AbortSignal,
  dependencies: {
    readonly listProjects: (workspaceGid: string, signal: AbortSignal) => Promise<readonly unknown[]>;
    readonly parseProject: (value: unknown) => TProject;
    readonly parseState: (value: unknown) => TState;
  },
): Promise<TState> {
  const workspace = state.workspaces.find((candidate) => candidate.gid === workspaceGid);
  if (workspace == null) {
    throw new Error("一覧にないワークスペースを選択できません。");
  }
  const projects = parseProjects(
    await dependencies.listProjects(workspace.gid, signal),
    dependencies.parseProject,
  );
  return dependencies.parseState({
    kind: "project_selection_required",
    step: "project",
    client_id: state.client_id,
    codex: state.codex,
    workspace,
    projects,
  });
}

/** プロジェクトを選択または作成します。 */
export async function resolveSetupProject<TProject extends Project>(
  state: { readonly workspace: Workspace; readonly projects: readonly TProject[] },
  input: ProjectChoice,
  signal: AbortSignal,
  dependencies: {
    readonly createProject: (
      workspaceGid: string,
      name: string,
      signal: AbortSignal,
    ) => Promise<{ readonly gid: string; readonly name: string; readonly workspace: { readonly gid: string } }>;
    readonly parseProject: (value: unknown) => TProject;
  },
): Promise<TProject> {
  if (input.kind === "existing") {
    const selected = state.projects.find((candidate) => candidate.gid === input.project_gid);
    if (selected == null) {
      throw new Error("一覧にないプロジェクトを選択できません。");
    }
    return selected;
  }
  const created = await dependencies.createProject(state.workspace.gid, input.name, signal);
  if (created.workspace.gid !== state.workspace.gid || created.name !== input.name) {
    throw new Error("作成したプロジェクトの応答が要求と一致しません。");
  }
  return dependencies.parseProject({ gid: created.gid, name: created.name });
}

/** 保存済み端末設定から同じAsana対象のセクションGIDを取得します。 */
export function configuredSectionGidsFor<TSectionGids extends SectionGids>(
  clientId: string,
  workspace: Workspace,
  project: Project,
  dependencies: {
    readonly getDeviceSettings: () => unknown;
    readonly parseDeviceSettings: (value: unknown) => {
      readonly client_id: string;
      readonly workspace_gid: string;
      readonly project_gid: string;
      readonly section_gids: TSectionGids;
    };
  },
): TSectionGids | undefined {
  const savedSettings = dependencies.getDeviceSettings();
  if (savedSettings == null) {
    return undefined;
  }
  const settings = dependencies.parseDeviceSettings(savedSettings);
  if (
    settings.client_id !== clientId
    || settings.workspace_gid !== workspace.gid
    || settings.project_gid !== project.gid
  ) {
    return undefined;
  }
  return settings.section_gids;
}

/** Asanaリソースを再照合し、次の初期設定状態を生成します。 */
export async function coordinateSetupResources<
  TState extends { readonly kind: string },
  TResourceResult extends ResourceResult,
>(
  input: {
    readonly client_id: string;
    readonly workspace: Workspace;
    readonly project: Project;
    readonly configured_section_gids: SectionGids | undefined;
  },
  signal: AbortSignal,
  dependencies: AsanaResourceDependencies<TState, TResourceResult>,
): Promise<TState> {
  const result = await dependencies.coordinate(
    {
      workspace_gid: input.workspace.gid,
      project_gid: input.project.gid,
      ...(input.configured_section_gids == null
        ? {}
        : { configured_section_gids: input.configured_section_gids }),
    },
    signal,
  );
  const parsedResult = dependencies.parseResourceResult(result);
  if (parsedResult.kind === "requires_action") {
    return dependencies.parseState({
      kind: "resources_requires_action",
      step: "resources",
      client_id: input.client_id,
      codex: dependencies.codexAvailability,
      workspace: input.workspace,
      project: input.project,
      issues: mapResourceIssues(parsedResult.reconciliation),
    });
  }
  return dependencies.parseState({
    kind: "resources_ready",
    step: "asana_capability",
    context: {
      device_id: dependencies.deviceId,
      client_id: input.client_id,
      workspace_gid: input.workspace.gid,
      workspace_name: input.workspace.name,
      project_gid: input.project.gid,
      project_name: input.project.name,
      section_gids: parsedResult.section_gids,
      tag_gids: parsedResult.tag_gids,
      codex: dependencies.codexAvailability,
    },
  });
}

/** 保存済み初期設定リソースをAsanaの現在値と再照合します。 */
export async function revalidateSetupResources<
  TState extends { readonly kind: string },
  TResourceResult extends ResourceResult,
>(
  context: {
    readonly client_id: string;
    readonly codex: unknown;
    readonly workspace_gid: string;
    readonly workspace_name: string;
    readonly project_gid: string;
    readonly project_name: string;
    readonly section_gids: SectionGids;
    readonly tag_gids: TagGids;
  },
  signal: AbortSignal,
  dependencies: {
    readonly coordinate: (
      input: {
        readonly workspace_gid: string;
        readonly project_gid: string;
        readonly configured_section_gids: SectionGids;
        readonly configured_tag_gids: TagGids;
      },
      signal: AbortSignal,
    ) => Promise<TResourceResult>;
    readonly parseResourceResult: (value: TResourceResult) => TResourceResult;
    readonly parseState: (value: unknown) => TState;
  },
): Promise<{ readonly kind: "requires_action"; readonly state: TState } | { readonly kind: "ready" }> {
  const refreshedResult = dependencies.parseResourceResult(
    await dependencies.coordinate(
      {
        workspace_gid: context.workspace_gid,
        project_gid: context.project_gid,
        configured_section_gids: context.section_gids,
        configured_tag_gids: context.tag_gids,
      },
      signal,
    ),
  );
  if (refreshedResult.kind === "requires_action") {
    return {
      kind: "requires_action",
      state: dependencies.parseState({
        kind: "resources_requires_action",
        step: "resources",
        client_id: context.client_id,
        codex: context.codex,
        workspace: { gid: context.workspace_gid, name: context.workspace_name },
        project: { gid: context.project_gid, name: context.project_name },
        issues: mapResourceIssues(refreshedResult.reconciliation),
      }),
    };
  }
  if (
    !sameSectionGids(context.section_gids, refreshedResult.section_gids)
    || !sameTagGids(context.tag_gids, refreshedResult.tag_gids)
  ) {
    throw new Error("保存済み初期設定リソースとAsanaの実状態が一致しません。");
  }
  return { kind: "ready" };
}
