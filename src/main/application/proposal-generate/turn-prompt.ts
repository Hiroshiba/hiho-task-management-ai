import type { PendingWithdrawConfirmation } from "./evidence-sources";

type PromptTask<TStatus extends string> = {
  readonly gid: string;
  readonly title: string;
  readonly status: TStatus;
  readonly completed: boolean;
};

type PromptPrepared<TStatus extends string> = {
  readonly baseline_snapshot_hash: string;
  readonly snapshot: {
    readonly app_version: string;
    readonly project_gid: string;
    readonly synced_at: string;
    readonly as_of: string;
    readonly tasks: readonly PromptTask<TStatus>[];
  };
  readonly baseline: { readonly tasks: readonly PromptTask<TStatus>[] };
  readonly user_message_source_id: string;
  readonly user_message_sources: readonly { readonly kind: string }[];
  readonly pending_withdraw_confirmation: PendingWithdrawConfirmation<TStatus> | undefined;
  readonly inherited_status_evidence_aliases: readonly unknown[];
  readonly inherited_split_instruction_aliases: readonly unknown[];
  readonly trusted_status_evidence: readonly unknown[];
};

type WorkflowErrorConstructor = new (message: string) => Error;

type PromptDependencies = {
  readonly parseContext: (value: unknown) => unknown;
  readonly canonicalizeJson: (value: unknown) => string;
  readonly maximumRetryAttempts: number;
  readonly WorkflowError: WorkflowErrorConstructor;
};

/** AIターンに渡す基準状態と訂正指示を組み立てます。 */
export function createTurnPrompt<TStatus extends string>(
  request: { readonly message: string; readonly target_task_gid?: string | undefined },
  prepared: PromptPrepared<TStatus>,
  workspace: { readonly workspaceId: string; readonly baselineSnapshotHash: string; getStatus(): { readonly revision: number } },
  retryContext: { readonly kind: "initial" } | { readonly kind: "correction"; readonly failedAttempt: number; readonly validationErrors: { readonly errors: readonly unknown[] } },
  dependencies: PromptDependencies,
): string {
  const context = dependencies.parseContext({
    baseline_snapshot_hash: prepared.baseline_snapshot_hash,
    app_version: prepared.snapshot.app_version,
    project_gid: prepared.snapshot.project_gid,
    synced_at: prepared.snapshot.synced_at,
    as_of: prepared.snapshot.as_of,
  });
  const targetTask = request.target_task_gid == null
    ? undefined
    : prepared.snapshot.tasks.find((task) => task.gid === request.target_task_gid);
  if (request.target_task_gid != null && targetTask == null) {
    throw new dependencies.WorkflowError("指定された対象タスクが基準スナップショットにありません。");
  }
  const targetTaskContext = targetTask == null
    ? null
    : { gid: targetTask.gid, title: targetTask.title };
  const withdrawConfirmationSources = prepared.user_message_sources.filter(
    (source) => source.kind === "withdraw_confirmation",
  );
  const taskNotesSourceIdPattern =
    `task-notes:${prepared.user_message_source_id.slice("user-message:".length)}:<対象タスクGID>`;
  const correctionInstructions = retryContext.kind === "initial"
    ? []
    : [
        "前回の検証エラーを修正してください。記載されたJSON Pointerと型付きcodeに従ってワークスペースを編集してください。",
        "検証エラーには会話本文や根拠本文を含めていません。ワークスペースの候補と今回のコンテキストを照合してください。",
        "<validation_errors>",
        dependencies.canonicalizeJson({
          attempt: retryContext.failedAttempt,
          max_attempts: dependencies.maximumRetryAttempts,
          errors: retryContext.validationErrors.errors.slice(0, 12),
        }),
        "</validation_errors>",
      ];
  return [
    "TaskHubの構造化変更案だけを検討してください。",
    "変更案は今回のproposal_workspace dynamic toolで読み取り、意味編集、検証、提出してください。",
    "editはreplace_allで全体を置換できます。大きな案はset_title、insert_group、insert_operationなどの分割編集で構築できます。",
    "各編集でedit_batch_idに新しいID、expected_revisionに現在の改訂番号を指定してください。read、diff、validateはoffsetで続きを読めます。",
    "提出が成功した場合だけ、response_jsonへ今回のworkspace_idと提出したrevision、短いmessageとquestionsを指定してください。完全なproposalは最終応答へ含めないでください。",
    ...correctionInstructions,
    "<baseline_context>",
    dependencies.canonicalizeJson(context),
    "</baseline_context>",
    "<proposal_workspace>",
    dependencies.canonicalizeJson({
      workspace_id: workspace.workspaceId,
      revision: workspace.getStatus().revision,
      baseline_snapshot_hash: workspace.baselineSnapshotHash,
    }),
    "</proposal_workspace>",
    "<target_task_context>",
    dependencies.canonicalizeJson(targetTaskContext),
    "</target_task_context>",
    "<user_message_sources>",
    dependencies.canonicalizeJson(prepared.user_message_sources),
    "</user_message_sources>",
    "<withdraw_confirmation_sources>",
    dependencies.canonicalizeJson(withdrawConfirmationSources),
    "</withdraw_confirmation_sources>",
    "<task_notes_source_id_pattern>",
    dependencies.canonicalizeJson({ pattern: taskNotesSourceIdPattern }),
    "</task_notes_source_id_pattern>",
    "<pending_withdraw_confirmation>",
    dependencies.canonicalizeJson(prepared.pending_withdraw_confirmation ?? null),
    "</pending_withdraw_confirmation>",
    "<inherited_status_evidence_aliases>",
    dependencies.canonicalizeJson(prepared.inherited_status_evidence_aliases),
    "</inherited_status_evidence_aliases>",
    "<inherited_split_instruction_aliases>",
    dependencies.canonicalizeJson(prepared.inherited_split_instruction_aliases),
    "</inherited_split_instruction_aliases>",
    "<trusted_status_evidence>",
    dependencies.canonicalizeJson(prepared.trusted_status_evidence),
    "</trusted_status_evidence>",
    "<current_request>",
    dependencies.canonicalizeJson({
      message: request.message,
      user_message_source_id: prepared.user_message_source_id,
    }),
    "</current_request>",
  ].join("\n");
}

/** 質問に対応する取り下げ確認状態を求めます。 */
export function createPendingWithdrawConfirmation<TStatus extends string>(
  response: { readonly questions: readonly { readonly withdraw_confirmation?: { readonly target_task_gid: string } | undefined }[] },
  prepared: PromptPrepared<TStatus>,
  WorkflowError: WorkflowErrorConstructor,
): PendingWithdrawConfirmation<TStatus> | undefined {
  if (response.questions.length !== 1) {
    return undefined;
  }
  const question = response.questions[0];
  if (question == null) {
    throw new WorkflowError("取り下げ確認の質問を取得できません。");
  }
  const confirmation = question.withdraw_confirmation;
  if (confirmation == null) {
    return undefined;
  }
  const task = prepared.snapshot.tasks.find((task) => task.gid === confirmation.target_task_gid);
  const baselineTask = prepared.baseline.tasks.find((task) => task.gid === confirmation.target_task_gid);
  if (
    task == null
    || baselineTask == null
    || (
      task.status !== "not_started"
      && task.status !== "in_progress"
    )
    || task.completed !== false
    || baselineTask.status !== task.status
    || baselineTask.completed !== task.completed
  ) {
    return undefined;
  }
  return {
    target_task_gid: task.gid,
    baseline_status: baselineTask.status,
    baseline_completed: baselineTask.completed,
  };
}

/** 質問をRenderer向けの表示値へ変換します。 */
export function createRendererQuestions<TStatus extends string>(
  questions: readonly { readonly question_id: string; readonly text: string; readonly options?: readonly string[] | undefined; readonly withdraw_confirmation?: { readonly target_task_gid: string } | undefined }[],
  pending: PendingWithdrawConfirmation<TStatus> | undefined,
  snapshot: { readonly tasks: readonly PromptTask<TStatus>[] },
  WorkflowError: WorkflowErrorConstructor,
): readonly {
  readonly question_id: string;
  readonly text: string;
  readonly options?: readonly string[];
}[] {
  return questions.map((question) => {
    if (
      pending != null
      && question.withdraw_confirmation?.target_task_gid === pending.target_task_gid
    ) {
      const task = snapshot.tasks.find((task) => task.gid === pending.target_task_gid);
      if (task == null) {
        throw new WorkflowError("取り下げ確認の対象タスクが基準スナップショットにありません。");
      }
      return {
        question_id: question.question_id,
        text: `タスク「${task.title}」GID ${task.gid}を取り下げますか。`,
        options: ["はい、それでいいです", "いいえ"],
      };
    }
    const base = {
      question_id: question.question_id,
      text: question.text,
    };
    if (question.options == null) {
      return base;
    }
    return { ...base, options: [...question.options] };
  });
}
