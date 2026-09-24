import assert from "node:assert/strict";
import { test } from "node:test";
import {
  proposalOperationSchema,
  proposalSchema,
  type CodexGeneratedResponse,
  type Proposal,
} from "../../../shared/ai";
import {
  aiWorkflowSnapshotSchema,
  type AiWorkflowSnapshot,
} from "../../../shared/ai-workflow";
import { taskSchema } from "../../../shared/domain";
import type {
  CodexSessionTurnInputFactory,
  CodexSessionTurnResult,
} from "../../codex/session";
import { DiagnosticFailureDispositionError } from "../../diagnostic-failure";
import { ExternalToolStatusEvidenceCollector } from "../../external-tools/status-evidence-collector";
import {
  ProposalWorkspace,
  type ProposalWorkspaceValidation,
} from "../proposal-workspace";
import { AiWorkflowService, type AiWorkflowSessionPort } from "./service";

class StubSession implements AiWorkflowSessionPort {
  onTurn: (
    workspace: ProposalWorkspace,
    validate: (proposal: Proposal) => ProposalWorkspaceValidation<null>,
  ) => CodexGeneratedResponse = () => {
    throw new Error("ターンの応答が設定されていません。");
  };
  private workspace: ProposalWorkspace | undefined;
  private validate: ((proposal: Proposal) => ProposalWorkspaceValidation<null>) | undefined;

  /** 同期後のターン入力を用意して試験用の応答を返します。 */
  async startTurnWithPreparation(
    prepareInput: CodexSessionTurnInputFactory,
    signal: AbortSignal,
  ): Promise<CodexSessionTurnResult> {
    await prepareInput(signal);
    const workspace = this.workspace;
    const validate = this.validate;
    if (workspace == null || validate == null) {
      throw new Error("ワークスペースが設定されていません。");
    }
    this.workspace = undefined;
    this.validate = undefined;
    return {
      threadId: "thread-1",
      turnId: "turn-1",
      response: this.onTurn(workspace, validate),
    };
  }

  /** ターンのtaskctlスナップショットを固定します。 */
  freezeTaskctlSnapshot(): void {}

  /** ターンのtaskctlスナップショットを解放します。 */
  releaseTaskctlSnapshot(): void {}

  /** 現在のターンへワークスペースを設定します。 */
  activateProposalWorkspace(
    workspace: ProposalWorkspace,
    validate: (proposal: Proposal) => ProposalWorkspaceValidation<null>,
  ): void {
    this.workspace = workspace;
    this.validate = validate;
  }

  /** 差分の購読解除関数を返します。 */
  onDelta(): () => void {
    return () => {};
  }
}

function createService(
  session: StubSession,
  snapshotProvider: () => AiWorkflowSnapshot,
  logRetryEvent: () => void,
  collector: ExternalToolStatusEvidenceCollector,
): AiWorkflowService {
  return new AiWorkflowService({
    sessionId: "session-1",
    session,
    snapshotProvider,
    taskctlSnapshotProvider: () => ({
      sync: { kind: "synced", synced_at: snapshotProvider().synced_at },
      tasks: snapshotProvider().tasks,
      ranking: { kind: "unavailable" },
    }),
    baselineExternalDataProvider: () => [],
    externalStatusEvidenceCollector: collector,
    applicationCoordinator: {
      apply: () => {
        throw new Error("承認は試験しません。");
      },
    },
    prepareApprovalInput: () => {
      throw new Error("承認は試験しません。");
    },
    isOnline: () => true,
    logRetryEvent,
  });
}

function createProposal(workspace: ProposalWorkspace): Proposal {
  return {
    title: "追加案",
    groups: [{
      group_id: "group-1",
      atomic: false,
      operations: [proposalOperationSchema.parse({
        operation: "create_task",
        operation_id: "operation-1",
        baseline_snapshot_hash: workspace.baselineSnapshotHash,
        reason: "依頼されたタスクを追加する",
        basis: "explicit",
        confidence: 1,
        evidence_refs: [{ kind: "user_message", locator: "user-message:request" }],
        temporary_ref: "new-task-1",
        creation: { kind: "single_task" },
        before: { kind: "absent" },
        after: { title: "追加するタスク", duration: { value: 1, unit: "hour" } },
      })],
    }],
  };
}

void test("提出後のターンだけを公開し、次の依頼では新基準へ結び直す", async () => {
  let snapshot = aiWorkflowSnapshotSchema.parse({
    app_version: "app-1",
    project_gid: "project-1",
    synced_at: "2026-09-25T00:00:00.000Z",
    as_of: "2026-09-25T00:00:00.000Z",
    tasks: [],
    areas: [],
  });
  const session = new StubSession();
  const service = createService(session, () => snapshot, () => {},
    new ExternalToolStatusEvidenceCollector());
  session.onTurn = (workspace, validate) => {
    const status = workspace.applyBatch({
      workspace_id: workspace.workspaceId,
      edit_batch_id: "batch-1",
      expected_revision: 0,
      edits: [{ kind: "replace_all", proposal: createProposal(workspace) }],
    });
    const submitted = workspace.submit({
      workspace_id: workspace.workspaceId,
      expected_revision: status.revision,
    }, validate);
    assert.equal(submitted.kind, "submitted");
    return {
      kind: "proposal",
      workspace_id: workspace.workspaceId,
      revision: status.revision,
      message: "追加案を作成しました。",
      questions: [],
    };
  };
  const signal = new AbortController().signal;
  const first = await service.startTurn({ message: "タスクを追加して" }, signal);
  assert.equal(first.kind, "proposal");
  if (first.kind !== "proposal") {
    throw new Error("変更案が返りませんでした。");
  }
  const previousHash = first.proposal.baseline_snapshot_hash;
  snapshot = aiWorkflowSnapshotSchema.parse({
    ...snapshot,
    synced_at: "2026-09-25T01:00:00.000Z",
    as_of: "2026-09-25T01:00:00.000Z",
  });
  session.onTurn = (workspace, validate) => {
    const chunk = workspace.read({
      workspace_id: workspace.workspaceId,
      revision: 0,
      target: { kind: "proposal" },
    });
    const initial = proposalSchema.parse(JSON.parse(chunk.content));
    assert.equal(initial.groups[0]?.operations[0]?.baseline_snapshot_hash,
      workspace.baselineSnapshotHash);
    assert.notEqual(workspace.baselineSnapshotHash, previousHash);
    const submitted = workspace.submit({
      workspace_id: workspace.workspaceId,
      expected_revision: 0,
    }, validate);
    assert.equal(submitted.kind, "submitted");
    return {
      kind: "proposal",
      workspace_id: workspace.workspaceId,
      revision: 0,
      message: "変更案を保持しました。",
      questions: [],
    };
  };
  const second = await service.startTurn({
    message: "そのまま残して",
    base_proposal_id: first.proposal.proposal_id,
  }, signal);
  assert.equal(second.kind, "proposal");
  if (second.kind !== "proposal") {
    throw new Error("変更案が返りませんでした。");
  }
  assert.notEqual(second.proposal.baseline_snapshot_hash, previousHash);
  session.onTurn = () => ({
    kind: "no_proposal",
    message: "変更案を保持します。",
    questions: [],
    pending_proposal_action: "keep",
  });
  const third = await service.startTurn({
    message: "案を確認して",
    base_proposal_id: second.proposal.proposal_id,
  }, signal);
  assert.equal(third.kind, "no_proposal");
  assert.equal(service.getProposal(second.proposal.proposal_id).proposal_id,
    second.proposal.proposal_id);
  service.dispose();
});

void test("未提出のワークスペースは最終応答が参照しても公開しない", async () => {
  const snapshot = aiWorkflowSnapshotSchema.parse({
    app_version: "app-1",
    project_gid: "project-1",
    synced_at: "2026-09-25T00:00:00.000Z",
    as_of: "2026-09-25T00:00:00.000Z",
    tasks: [],
    areas: [],
  });
  const session = new StubSession();
  let retryEvents = 0;
  const service = createService(session, () => snapshot, () => { retryEvents += 1; },
    new ExternalToolStatusEvidenceCollector());
  session.onTurn = (workspace, validate) => {
    const status = workspace.applyBatch({
      workspace_id: workspace.workspaceId,
      edit_batch_id: "batch-1",
      expected_revision: 0,
      edits: [{
        kind: "replace_all",
        proposal: {
          title: "対象不明の変更案",
          groups: [{
            group_id: "group-1",
            atomic: false,
            operations: [proposalOperationSchema.parse({
              operation: "update_notes",
              operation_id: "operation-1",
              baseline_snapshot_hash: workspace.baselineSnapshotHash,
              reason: "本文を更新する",
              basis: "explicit",
              confidence: 1,
              evidence_refs: [{ kind: "user_message", locator: "user-message:request" }],
              target: { kind: "existing", gid: "missing-task" },
              before: "",
              after: "変更後の本文",
            })],
          }],
        },
      }],
    });
    assert.equal(workspace.submit({
      workspace_id: workspace.workspaceId,
      expected_revision: status.revision,
    }, validate).kind, "invalid");
    return {
      kind: "proposal",
      workspace_id: workspace.workspaceId,
      revision: status.revision,
      message: "追加案を作成しました。",
      questions: [],
    };
  };
  await assert.rejects(
    service.startTurn({ message: "タスクを追加して" }, new AbortController().signal),
    (error: unknown) => error instanceof DiagnosticFailureDispositionError
      && error.disposition.response_error instanceof Error
      && error.disposition.response_error.message
        === "AI変更案の訂正を3回の試行で完了できませんでした。",
  );
  assert.equal(retryEvents, 3);
  service.dispose();
});

void test("前案の変更前値を新しいタスク基準へ結び直す", async () => {
  const task = taskSchema.parse({
    gid: "task-1",
    title: "対象タスク",
    notes: "元の本文",
    status: "not_started",
    importance: 3,
    area: "未分類",
    block_state: "none",
    parent_work_mode: "unknown",
    section_gid: "section-1",
    completed: false,
    tags: [],
    child_gids: [],
    dependencies: [],
    obsidian_links: [],
    activity_anchor_on: "2026-09-25",
  });
  let snapshot = aiWorkflowSnapshotSchema.parse({
    app_version: "app-1",
    project_gid: "project-1",
    synced_at: "2026-09-25T00:00:00.000Z",
    as_of: "2026-09-25T00:00:00.000Z",
    tasks: [task],
    areas: ["未分類"],
  });
  const session = new StubSession();
  const service = createService(session, () => snapshot, () => {},
    new ExternalToolStatusEvidenceCollector());
  session.onTurn = (workspace, validate) => {
    const status = workspace.applyBatch({
      workspace_id: workspace.workspaceId,
      edit_batch_id: "batch-1",
      expected_revision: 0,
      edits: [{
        kind: "replace_all",
        proposal: {
          title: "本文変更案",
          groups: [{
            group_id: "group-1",
            atomic: false,
            operations: [proposalOperationSchema.parse({
              operation: "update_notes",
              operation_id: "operation-1",
              baseline_snapshot_hash: workspace.baselineSnapshotHash,
              reason: "本文を更新する",
              basis: "explicit",
              confidence: 1,
              evidence_refs: [{ kind: "user_message", locator: "user-message:request" }],
              target: { kind: "existing", gid: task.gid },
              before: task.notes,
              after: "更新後の本文",
            })],
          }],
        },
      }],
    });
    assert.equal(workspace.submit({
      workspace_id: workspace.workspaceId,
      expected_revision: status.revision,
    }, validate).kind, "submitted");
    return {
      kind: "proposal",
      workspace_id: workspace.workspaceId,
      revision: status.revision,
      message: "本文の変更案です。",
      questions: [],
    };
  };
  const signal = new AbortController().signal;
  const first = await service.startTurn({ message: "本文を変更して" }, signal);
  assert.equal(first.kind, "proposal");
  if (first.kind !== "proposal") {
    throw new Error("変更案が返りませんでした。");
  }
  snapshot = aiWorkflowSnapshotSchema.parse({
    ...snapshot,
    synced_at: "2026-09-25T01:00:00.000Z",
    as_of: "2026-09-25T01:00:00.000Z",
    tasks: [{ ...task, notes: "新しい基準本文" }],
  });
  session.onTurn = (workspace, validate) => {
    const chunk = workspace.read({
      workspace_id: workspace.workspaceId,
      revision: 0,
      target: { kind: "proposal" },
    });
    const initial = proposalSchema.parse(JSON.parse(chunk.content));
    assert.equal(initial.groups[0]?.operations[0]?.before, "新しい基準本文");
    assert.equal(initial.groups[0]?.operations[0]?.baseline_snapshot_hash,
      workspace.baselineSnapshotHash);
    assert.equal(workspace.submit({
      workspace_id: workspace.workspaceId,
      expected_revision: 0,
    }, validate).kind, "submitted");
    return {
      kind: "proposal",
      workspace_id: workspace.workspaceId,
      revision: 0,
      message: "変更案を更新しました。",
      questions: [],
    };
  };
  const second = await service.startTurn({
    message: "この案を続けて",
    base_proposal_id: first.proposal.proposal_id,
  }, signal);
  assert.equal(second.kind, "proposal");
  service.dispose();
});

void test("内部AIの新規作成案は所要時間を指定しないと提出できない", async () => {
  const snapshot = aiWorkflowSnapshotSchema.parse({
    app_version: "app-1",
    project_gid: "project-1",
    synced_at: "2026-09-25T00:00:00.000Z",
    as_of: "2026-09-25T00:00:00.000Z",
    tasks: [],
    areas: [],
  });
  const session = new StubSession();
  const service = createService(session, () => snapshot, () => {},
    new ExternalToolStatusEvidenceCollector());
  session.onTurn = (workspace, validate) => {
    const proposal = createProposal(workspace);
    const group = proposal.groups[0];
    const operation = group?.operations[0];
    if (operation?.operation !== "create_task") {
      throw new Error("新規作成操作がありません。");
    }
    if (group == null) {
      throw new Error("新規作成グループがありません。");
    }
    const withoutDuration = proposalOperationSchema.parse({
      ...operation,
      after: { title: operation.after.title },
    });
    const status = workspace.applyBatch({
      workspace_id: workspace.workspaceId,
      edit_batch_id: "batch-1",
      expected_revision: 0,
      edits: [{
        kind: "replace_all",
        proposal: {
          ...proposal,
          groups: [{ ...group, operations: [withoutDuration] }],
        },
      }],
    });
    const submitted = workspace.submit({
      workspace_id: workspace.workspaceId,
      expected_revision: status.revision,
    }, validate);
    assert.equal(submitted.kind, "invalid");
    if (submitted.kind === "invalid") {
      assert.ok(submitted.issues.some((issue) =>
        issue.json_pointer === "/groups/0/operations/0/after/duration"));
    }
    return {
      kind: "no_proposal",
      message: "所要時間を確認します。",
      questions: [],
      pending_proposal_action: "keep",
    };
  };
  await service.startTurn({ message: "新しいタスクを追加して" }, new AbortController().signal);
  service.dispose();
});

void test("提出済みワークスペースと提案なし応答の矛盾を訂正対象にする", async () => {
  const snapshot = aiWorkflowSnapshotSchema.parse({
    app_version: "app-1",
    project_gid: "project-1",
    synced_at: "2026-09-25T00:00:00.000Z",
    as_of: "2026-09-25T00:00:00.000Z",
    tasks: [],
    areas: [],
  });
  const session = new StubSession();
  let retryEvents = 0;
  const service = createService(session, () => snapshot, () => { retryEvents += 1; },
    new ExternalToolStatusEvidenceCollector());
  session.onTurn = (workspace, validate) => {
    const status = workspace.applyBatch({
      workspace_id: workspace.workspaceId,
      edit_batch_id: "batch-1",
      expected_revision: 0,
      edits: [{ kind: "replace_all", proposal: createProposal(workspace) }],
    });
    assert.equal(workspace.submit({
      workspace_id: workspace.workspaceId,
      expected_revision: status.revision,
    }, validate).kind, "submitted");
    return {
      kind: "no_proposal",
      message: "変更案を破棄します。",
      questions: [],
      pending_proposal_action: "discard",
    };
  };
  await assert.rejects(
    service.startTurn({ message: "タスクを追加して" }, new AbortController().signal),
    (error: unknown) => error instanceof DiagnosticFailureDispositionError,
  );
  assert.equal(retryEvents, 3);
  service.dispose();
});

void test("未提出のワークスペースでは提案なしと前案破棄の応答を受け付ける", async () => {
  const snapshot = aiWorkflowSnapshotSchema.parse({
    app_version: "app-1",
    project_gid: "project-1",
    synced_at: "2026-09-25T00:00:00.000Z",
    as_of: "2026-09-25T00:00:00.000Z",
    tasks: [],
    areas: [],
  });
  const session = new StubSession();
  const service = createService(session, () => snapshot, () => {},
    new ExternalToolStatusEvidenceCollector());
  session.onTurn = () => ({
    kind: "no_proposal",
    message: "変更案を破棄します。",
    questions: [],
    pending_proposal_action: "discard",
  });
  const result = await service.startTurn({ message: "変更案を破棄して" },
    new AbortController().signal);
  assert.equal(result.kind, "no_proposal");
  if (result.kind === "no_proposal") {
    assert.equal(result.pending_proposal_action, "discard");
  }
  service.dispose();
});

void test("外部状態根拠を提出時に検証し、ターン終了後も保持する", async () => {
  const task = taskSchema.parse({
    gid: "task-1",
    title: "対象タスク",
    notes: "",
    status: "not_started",
    importance: 3,
    area: "未分類",
    block_state: "none",
    parent_work_mode: "unknown",
    section_gid: "section-1",
    completed: false,
    tags: [],
    child_gids: [],
    dependencies: [],
    obsidian_links: [],
    activity_anchor_on: "2026-09-25",
  });
  const snapshot = aiWorkflowSnapshotSchema.parse({
    app_version: "app-1",
    project_gid: "project-1",
    synced_at: "2026-09-25T00:00:00.000Z",
    as_of: "2026-09-25T00:00:00.000Z",
    tasks: [task],
    areas: ["未分類"],
  });
  const session = new StubSession();
  const collector = new ExternalToolStatusEvidenceCollector();
  const service = createService(session, () => snapshot, () => {}, collector);
  session.onTurn = (workspace, validate) => {
    collector.record(collector.captureAttempt(), {
      format: "json",
      value: { locator: "external:task-1", target_task_gid: task.gid, status: "completed" },
    });
    const status = workspace.applyBatch({
      workspace_id: workspace.workspaceId,
      edit_batch_id: "batch-1",
      expected_revision: 0,
      edits: [{
        kind: "replace_all",
        proposal: {
          title: "完了案",
          groups: [{
            group_id: "group-1",
            atomic: false,
            operations: [proposalOperationSchema.parse({
              operation: "complete",
              operation_id: "operation-1",
              baseline_snapshot_hash: workspace.baselineSnapshotHash,
              reason: "外部状態が完了している",
              basis: "explicit",
              confidence: 1,
              evidence_refs: [{ kind: "external_tool", locator: "external:task-1" }],
              target: { kind: "existing", gid: task.gid },
              before: task.status,
              after: "completed",
              status_evidence: {
                kind: "external_structured_status",
                reference: { kind: "external_tool", locator: "external:task-1" },
                status: "completed",
              },
            })],
          }],
        },
      }],
    });
    assert.equal(workspace.submit({
      workspace_id: workspace.workspaceId,
      expected_revision: status.revision,
    }, validate).kind, "submitted");
    return {
      kind: "proposal",
      workspace_id: workspace.workspaceId,
      revision: status.revision,
      message: "完了案を作成しました。",
      questions: [],
    };
  };
  const result = await service.startTurn({ message: "外部状態を確認して" },
    new AbortController().signal);
  assert.equal(result.kind, "proposal");
  if (result.kind === "proposal") {
    assert.equal(service.getProposal(result.proposal.proposal_id)
      .basic_validation.operations[0]?.kind, "valid");
  }
  assert.equal(collector.captureAttempt().kind, "inactive");
  service.dispose();
});
