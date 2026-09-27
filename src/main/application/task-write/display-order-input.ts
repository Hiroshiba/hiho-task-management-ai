interface DisplayOrderContext {
  readonly project_gid: string;
  readonly section_gids: {
    readonly not_started: string;
    readonly in_progress: string;
  };
}

interface ProjectTask {
  readonly gid: string;
  readonly memberships: readonly {
    readonly project: { readonly gid: string };
    readonly section?: { readonly gid: string } | null;
  }[];
}

/** プロジェクト所属タスクから表示順序の入力を組み立てます。 */
export function buildDisplayOrderInput(
  context: DisplayOrderContext,
  tasks: readonly ProjectTask[],
  rankedTaskGids: readonly string[],
): {
  readonly project_gid: string;
  readonly section_gids: DisplayOrderContext["section_gids"];
  readonly current_order: { readonly not_started: readonly string[]; readonly in_progress: readonly string[] };
  readonly ranking: readonly string[];
} {
  const notStartedOrder: string[] = [];
  const inProgressOrder: string[] = [];
  const currentOrder = {
    not_started: notStartedOrder,
    in_progress: inProgressOrder,
  };
  const activeGids = new Set<string>();
  for (const task of tasks) {
    const memberships = task.memberships.filter(
      (membership) => membership.project.gid === context.project_gid,
    );
    if (memberships.length !== 1) {
      continue;
    }
    const sectionGid = memberships[0]?.section?.gid;
    if (sectionGid == null) {
      continue;
    }
    if (sectionGid === context.section_gids.not_started) {
      currentOrder.not_started.push(task.gid);
      activeGids.add(task.gid);
    } else if (sectionGid === context.section_gids.in_progress) {
      currentOrder.in_progress.push(task.gid);
      activeGids.add(task.gid);
    }
  }
  return {
    project_gid: context.project_gid,
    section_gids: {
      not_started: context.section_gids.not_started,
      in_progress: context.section_gids.in_progress,
    },
    current_order: currentOrder,
    ranking: rankedTaskGids.filter((gid) => activeGids.has(gid)),
  };
}
