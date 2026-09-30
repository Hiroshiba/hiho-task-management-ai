import { z } from "zod";
import type { DynamicToolCallParams, DynamicToolCallResponse } from "../codex-app-server";
import { validateAbortSignal } from "../codex-app-server/rpc-endpoint";
import type { CodexToolResponseSerializer } from "./tool-response";
import { CodexSessionError, CodexSessionStateError } from "./errors";
const taskctlDynamicToolName = "taskctl";
const obsidianDynamicToolName = "obsidian";
type ActiveToolTurn = {
  readonly phase: "starting" | "running";
  readonly threadId: string;
  readonly signal: AbortSignal;
  readonly abortRequested: boolean;
  readonly turnId?: string;
};

type DynamicToolOptions<Taskctl extends { readonly ok: boolean }, Obsidian extends { readonly ok: boolean }, ObsidianQuery> = {
  readonly getActiveTurn: () => ActiveToolTurn | undefined;
  readonly getThreadId: () => string | undefined;
  readonly responseSerializer: CodexToolResponseSerializer<Taskctl, Obsidian>;
  readonly executeTaskctlQuery: (query: unknown) => Promise<Taskctl>;
  readonly obsidianQuerySchema: z.ZodType<ObsidianQuery>;
  readonly executeObsidianQuery: (query: ObsidianQuery, signal: AbortSignal) => Promise<Obsidian>;
  readonly createInvalidObsidianResponse: () => Obsidian;
  readonly readObsidianErrorResponse: (error: unknown) => Obsidian | undefined;
  readonly createTaskctlAbortError: () => Error;
};

/** Codex dynamic toolを現在のターンへ配送します。 */
export class CodexDynamicToolHandler<Taskctl extends { readonly ok: boolean }, Obsidian extends { readonly ok: boolean }, ObsidianQuery> {
  public constructor(private readonly options: DynamicToolOptions<Taskctl, Obsidian, ObsidianQuery>) {}

  /** taskctlとObsidianのdynamic tool要求を現在のターンへ配送します。 */
  public async handleDynamicTool(
    params: DynamicToolCallParams,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResponse> {
    if (params.tool === taskctlDynamicToolName) {
      return this.handleTaskctlDynamicTool(params, signal);
    }
    if (params.tool === obsidianDynamicToolName) {
      return this.handleObsidianDynamicTool(params, signal);
    }
    throw new CodexSessionError("dynamic toolの名前が不正です。");
  }

  private async handleTaskctlDynamicTool(
    params: DynamicToolCallParams,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResponse> {
    validateAbortSignal(signal);
    if (signal.aborted) {
      throw this.options.createTaskctlAbortError();
    }
    if (params.namespace != null) {
      throw new CodexSessionError("taskctl dynamic toolのnamespaceが不正です。");
    }
    if (params.tool !== taskctlDynamicToolName) {
      throw new CodexSessionError("taskctl dynamic toolの名前が不正です。");
    }
    const activeTurn = this.options.getActiveTurn();
    if (activeTurn == null || activeTurn.phase !== "running") {
      throw new CodexSessionStateError();
    }
    if (params.threadId !== activeTurn.threadId || params.turnId !== activeTurn.turnId) {
      throw new CodexSessionError("taskctl dynamic toolのターンが不正です。");
    }
    const currentThreadId = this.options.getThreadId();
    if (currentThreadId == null || params.threadId !== currentThreadId) {
      throw new CodexSessionError("taskctl dynamic toolのスレッドが不正です。");
    }
    const assertNotAborted = (): void => {
      if (signal.aborted || activeTurn.signal.aborted || activeTurn.abortRequested) {
        throw this.options.createTaskctlAbortError();
      }
    };
    assertNotAborted();
    const response = await this.options.executeTaskctlQuery(params.arguments);
    assertNotAborted();
    return this.options.responseSerializer.serializeDynamicToolResponse(response);
  }

  private async handleObsidianDynamicTool(
    params: DynamicToolCallParams,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResponse> {
    validateAbortSignal(signal);
    if (signal.aborted) {
      throw this.options.createTaskctlAbortError();
    }
    if (params.namespace != null) {
      throw new CodexSessionError("obsidian dynamic toolのnamespaceが不正です。");
    }
    if (params.tool !== obsidianDynamicToolName) {
      throw new CodexSessionError("obsidian dynamic toolの名前が不正です。");
    }
    const activeTurn = this.options.getActiveTurn();
    if (activeTurn == null || activeTurn.phase !== "running") {
      throw new CodexSessionStateError();
    }
    if (params.threadId !== activeTurn.threadId || params.turnId !== activeTurn.turnId) {
      throw new CodexSessionError("obsidian dynamic toolのターンが不正です。");
    }
    const currentThreadId = this.options.getThreadId();
    if (currentThreadId == null || params.threadId !== currentThreadId) {
      throw new CodexSessionError("obsidian dynamic toolのスレッドが不正です。");
    }
    const assertNotAborted = (): void => {
      if (signal.aborted || activeTurn.signal.aborted || activeTurn.abortRequested) {
        throw this.options.createTaskctlAbortError();
      }
    };
    assertNotAborted();
    const parsed = this.options.obsidianQuerySchema.safeParse(params.arguments);
    if (!parsed.success) {
      assertNotAborted();
      return this.options.responseSerializer.serializeObsidianDynamicToolResponse(
        this.options.createInvalidObsidianResponse(),
      );
    }
    const operationController = new AbortController();
    const abortOperation = (source: AbortSignal): void => {
      operationController.abort(source.reason);
    };
    const onToolAbort = (): void => {
      abortOperation(signal);
    };
    const onTurnAbort = (): void => {
      abortOperation(activeTurn.signal);
    };
    signal.addEventListener("abort", onToolAbort, { once: true });
    activeTurn.signal.addEventListener("abort", onTurnAbort, { once: true });
    if (signal.aborted) {
      onToolAbort();
    }
    if (activeTurn.signal.aborted || activeTurn.abortRequested) {
      onTurnAbort();
    }
    try {
      const response = await this.options.executeObsidianQuery(
        parsed.data,
        operationController.signal,
      );
      assertNotAborted();
      return this.options.responseSerializer.serializeObsidianDynamicToolResponse(response);
    } catch (error: unknown) {
      if (signal.aborted || activeTurn.signal.aborted || activeTurn.abortRequested) {
        assertNotAborted();
      }
      const obsidianResponse = this.options.readObsidianErrorResponse(error);
      if (obsidianResponse == null) {
        throw error;
      }
      assertNotAborted();
      return this.options.responseSerializer.serializeObsidianDynamicToolResponse(
        obsidianResponse,
      );
    } finally {
      signal.removeEventListener("abort", onToolAbort);
      activeTurn.signal.removeEventListener("abort", onTurnAbort);
    }
  }


}

type ObsidianQuery =
  | { readonly command: "vaults" }
  | { readonly command: "list"; readonly vault_id: string }
  | { readonly command: "search"; readonly vault_id: string; readonly query: string }
  | { readonly command: "read"; readonly vault_id: string; readonly relative_path: string }
  | { readonly command: "recent"; readonly vault_id: string; readonly limit: number };

type ObsidianReadPort<ListNote, SearchNote, ReadNote, RecentNote> = {
  listVaults(signal: AbortSignal): readonly string[] | PromiseLike<readonly string[]>;
  listNotes(vaultId: string, signal: AbortSignal): PromiseLike<readonly ListNote[]>;
  searchNotes(vaultId: string, query: string, signal: AbortSignal): PromiseLike<readonly SearchNote[]>;
  readNote(vaultId: string, relativePath: string, signal: AbortSignal): PromiseLike<ReadNote>;
  recentNotes(vaultId: string, limit: number, signal: AbortSignal): PromiseLike<readonly RecentNote[]>;
};

type ObsidianSuccessResponse<ListNote, SearchNote, ReadNote, RecentNote> =
  | { readonly ok: true; readonly command: "vaults"; readonly data: { readonly vault_ids: string[] } }
  | { readonly ok: true; readonly command: "list"; readonly data: { readonly vault_id: string; readonly notes: ListNote[] } }
  | { readonly ok: true; readonly command: "search"; readonly data: { readonly vault_id: string; readonly query: string; readonly notes: SearchNote[] } }
  | { readonly ok: true; readonly command: "read"; readonly data: { readonly vault_id: string; readonly note: ReadNote } }
  | { readonly ok: true; readonly command: "recent"; readonly data: { readonly vault_id: string; readonly limit: number; readonly notes: RecentNote[] } };

/** Obsidian要求を登録済みVaultの読み取りポートへ配送します。 */
export async function executeCodexObsidianQuery<ListNote, SearchNote, ReadNote, RecentNote>(
  query: ObsidianQuery,
  signal: AbortSignal,
  reader: ObsidianReadPort<ListNote, SearchNote, ReadNote, RecentNote>,
): Promise<ObsidianSuccessResponse<ListNote, SearchNote, ReadNote, RecentNote>> {
  switch (query.command) {
    case "vaults": {
      const vaultIds = await reader.listVaults(signal);
      return {
        ok: true,
        command: "vaults",
        data: { vault_ids: [...vaultIds] },
      };
    }
    case "list": {
      const notes = await reader.listNotes(query.vault_id, signal);
      return {
        ok: true,
        command: "list",
        data: { vault_id: query.vault_id, notes: [...notes] },
      };
    }
    case "search": {
      const notes = await reader.searchNotes(
        query.vault_id,
        query.query,
        signal,
      );
      return {
        ok: true,
        command: "search",
        data: {
          vault_id: query.vault_id,
          query: query.query,
          notes: [...notes],
        },
      };
    }
    case "read": {
      const note = await reader.readNote(
        query.vault_id,
        query.relative_path,
        signal,
      );
      return {
        ok: true,
        command: "read",
        data: { vault_id: query.vault_id, note },
      };
    }
    case "recent": {
      const notes = await reader.recentNotes(
        query.vault_id,
        query.limit,
        signal,
      );
      return {
        ok: true,
        command: "recent",
        data: {
          vault_id: query.vault_id,
          limit: query.limit,
          notes: [...notes],
        },
      };
    }
  }
}
