import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { z } from "zod";
import { obsidianIntegrationContracts } from "../../../shared/ipc-contracts/obsidian-integration";
import type { IpcResult } from "../../../shared/ipc-contracts/common";
import { detailSchema } from "../../../shared/ipc-contracts/task-view";
import { vaultMappingSchema } from "../../../shared/ipc-contracts/vault-values";
import { useDiagnosticsApi, useObsidianIntegrationApi } from "../../shared/api/feature-apis";
import { reportRendererError } from "../../shared/logging/report-renderer-error";

type TaskDetail = z.infer<typeof detailSchema>;
type ObsidianLink = TaskDetail["obsidian_links"][number];
type VaultMapping = z.infer<typeof vaultMappingSchema>;
type NoteStatus = "exists" | "missing" | "unavailable";
type Feedback = { readonly kind: "progress" | "failure"; readonly message: string };
type Failure = Extract<IpcResult<unknown>, { readonly kind: "error" }>;

type ObsidianOptions = {
  readonly selectedTask: Ref<TaskDetail | undefined>;
  readonly saveBlocked: Ref<boolean>;
  readonly onToast: (kind: "success", message: string) => void;
  readonly onFeedback: (kind: "failure", message: string) => void;
  readonly onTaskFeedback: (kind: "failure" | "warning", message: string) => void;
  readonly clearTaskFeedback: () => void;
};

function failureMessage(message: string, failure: Failure): string {
  return failure.error_id == null ? message : message + " エラーID " + failure.error_id;
}

function linkKey(link: ObsidianLink): string {
  return link.vault_id + "\0" + link.path;
}

/** Vault設定と選択タスクのObsidianノート状態を所有します。 */
export function useObsidianIntegration(options: ObsidianOptions) {
  const api = useObsidianIntegrationApi();
  const diagnostics = useDiagnosticsApi();
  const vaultMappings = ref<readonly VaultMapping[]>([]);
  const vaultMappingsLoading = ref(false);
  const vaultMappingBusy = ref(false);
  const vaultMappingFeedback = ref<Feedback>();
  const vaultSaveGeneration = ref(0);
  const registeredVaultIds = ref<readonly string[]>([]);
  const noteStatuses = ref<ReadonlyMap<string, NoteStatus>>(new Map());
  let vaultGeneration = 0;
  let noteGeneration = 0;
  let disposed = false;

  onBeforeUnmount(() => {
    disposed = true;
    vaultGeneration += 1;
    noteGeneration += 1;
  });

  watch([options.selectedTask, registeredVaultIds], () => {
    void refreshNoteStatuses();
  }, { immediate: true });

  function applyVaultMappings(mappings: readonly VaultMapping[]): void {
    vaultMappings.value = mappings;
    registeredVaultIds.value = mappings.map((mapping) => mapping.vault_id);
  }

  async function loadVaults(): Promise<void> {
    const generation = ++vaultGeneration;
    try {
      const result = obsidianIntegrationContracts.listVaults.response.parse(await api.listVaults());
      if (disposed || generation !== vaultGeneration) return;
      if (result.kind === "error") {
        options.onFeedback("failure", failureMessage("Vault一覧を読み込めませんでした。", result));
        return;
      }
      registeredVaultIds.value = result.value.vault_ids;
    } catch (error) {
      await reportRendererError(diagnostics, error, "error");
      if (!disposed && generation === vaultGeneration) {
        options.onFeedback("failure", "Vault一覧を読み込めませんでした。");
      }
    }
  }

  async function loadVaultMappings(): Promise<void> {
    const generation = ++vaultGeneration;
    vaultMappingsLoading.value = true;
    vaultMappingFeedback.value = undefined;
    try {
      const result = obsidianIntegrationContracts.listVaultMappings.response.parse(await api.listVaultMappings());
      if (disposed || generation !== vaultGeneration) return;
      if (result.kind === "error") {
        vaultMappingFeedback.value = {
          kind: "failure",
          message: failureMessage("Vault設定を読み込めませんでした。", result),
        };
        return;
      }
      applyVaultMappings(result.value);
    } catch (error) {
      await reportRendererError(diagnostics, error, "error");
      if (!disposed && generation === vaultGeneration) {
        vaultMappingFeedback.value = { kind: "failure", message: "Vault設定を読み込めませんでした。" };
      }
    } finally {
      if (!disposed && generation === vaultGeneration) vaultMappingsLoading.value = false;
    }
  }

  async function saveVaultMapping(mapping: VaultMapping): Promise<void> {
    if (vaultMappingBusy.value || options.saveBlocked.value) return;
    const validated = vaultMappingSchema.parse(mapping);
    const wasRegistered = vaultMappings.value.some((candidate) => candidate.vault_id === validated.vault_id);
    const generation = ++vaultGeneration;
    vaultMappingsLoading.value = false;
    vaultMappingBusy.value = true;
    vaultMappingFeedback.value = { kind: "progress", message: "Vault設定を保存しています。" };
    try {
      const result = obsidianIntegrationContracts.saveVaultMapping.response.parse(await api.saveVaultMapping(validated));
      if (disposed || generation !== vaultGeneration) return;
      if (result.kind === "error") {
        const message = result.code === "conflict"
          ? "AI依頼が残っている場合は「確認して閉じる」または「依頼を中止」を行い、別の処理中なら完了を待ってからVault設定を変更してください。"
          : "Vault設定を保存できませんでした。";
        vaultMappingFeedback.value = { kind: "failure", message: failureMessage(message, result) };
        return;
      }
      applyVaultMappings(result.value);
      vaultSaveGeneration.value += 1;
      vaultMappingFeedback.value = undefined;
      options.onToast("success", wasRegistered
        ? "Vault「" + validated.vault_id + "」のパスを更新しました。"
        : "Vault「" + validated.vault_id + "」を登録しました。");
    } catch (error) {
      await reportRendererError(diagnostics, error, "error");
      if (!disposed && generation === vaultGeneration) {
        vaultMappingFeedback.value = { kind: "failure", message: "Vault設定を保存できませんでした。" };
      }
    } finally {
      if (!disposed && generation === vaultGeneration) vaultMappingBusy.value = false;
    }
  }

  function isCurrentNoteRequest(generation: number, task: TaskDetail): boolean {
    return !disposed && generation === noteGeneration && options.selectedTask.value === task;
  }

  async function readNoteStatus(link: ObsidianLink, generation: number, task: TaskDetail): Promise<NoteStatus> {
    try {
      const input = obsidianIntegrationContracts.noteExists.request.parse({
        vault_id: link.vault_id,
        relative_path: link.path,
      });
      const result = obsidianIntegrationContracts.noteExists.response.parse(await api.noteExists(input));
      if (result.kind === "error") {
        if (isCurrentNoteRequest(generation, task)) {
          options.onTaskFeedback("failure", failureMessage("ノートの状態を確認できませんでした。", result));
        }
        return "unavailable";
      }
      return result.value.kind === "resolved" ? "exists" : "missing";
    } catch (error) {
      await reportRendererError(diagnostics, error, "error");
      if (isCurrentNoteRequest(generation, task)) {
        options.onTaskFeedback("failure", "ノートの状態を確認できませんでした。");
      }
      return "unavailable";
    }
  }

  async function refreshNoteStatuses(): Promise<void> {
    const generation = ++noteGeneration;
    const task = options.selectedTask.value;
    const vaultIds = registeredVaultIds.value;
    if (task == null) {
      noteStatuses.value = new Map();
      return;
    }
    const statuses = new Map<string, NoteStatus>();
    for (const link of task.obsidian_links) {
      if (!vaultIds.includes(link.vault_id)) statuses.set(linkKey(link), "unavailable");
    }
    noteStatuses.value = statuses;
    const checked = await Promise.all(task.obsidian_links
      .filter((link) => vaultIds.includes(link.vault_id))
      .map(async (link) => ({ key: linkKey(link), status: await readNoteStatus(link, generation, task) })));
    if (!isCurrentNoteRequest(generation, task)) return;
    for (const result of checked) statuses.set(result.key, result.status);
    noteStatuses.value = statuses;
  }

  async function checkNote(): Promise<void> {
    await refreshNoteStatuses();
  }

  async function openNote(link: ObsidianLink): Promise<void> {
    const task = options.selectedTask.value;
    if (task == null || !task.obsidian_links.some((candidate) => linkKey(candidate) === linkKey(link))) {
      throw new Error("選択中のタスクにObsidianリンクがありません。");
    }
    if (!registeredVaultIds.value.includes(link.vault_id)) {
      options.onTaskFeedback("warning", "このVaultは登録されていません。");
      return;
    }
    const generation = noteGeneration;
    try {
      const input = obsidianIntegrationContracts.openNote.request.parse({
        vault_id: link.vault_id,
        relative_path: link.path,
      });
      const result = obsidianIntegrationContracts.openNote.response.parse(await api.openNote(input));
      if (!isCurrentNoteRequest(generation, task)) return;
      if (result.kind === "error") {
        options.onTaskFeedback("failure", failureMessage("ノートを開けませんでした。", result));
        return;
      }
      options.clearTaskFeedback();
      options.onToast("success", "Obsidianへノートを開く要求を送信しました。");
    } catch (error) {
      await reportRendererError(diagnostics, error, "error");
      if (isCurrentNoteRequest(generation, task)) {
        options.onTaskFeedback("failure", "ノートを開けませんでした。");
      }
    }
  }

  return {
    vaultMappings, vaultMappingsLoading, vaultMappingBusy, vaultMappingFeedback, vaultSaveGeneration,
    registeredVaultIds, noteStatuses, loadVaults, loadVaultMappings, saveVaultMapping, checkNote, openNote,
  };
}
