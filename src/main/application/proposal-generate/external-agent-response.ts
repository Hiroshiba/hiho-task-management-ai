function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** 診断文を応答のUTF-8容量へ収めます。 */
export function normalizeExternalAgentDiagnosticMessage(
  message: string,
  maximumMessageBytes: number,
): {
  readonly message: string;
  readonly message_truncated: boolean;
} {
  if (getUtf8ByteLength(message) <= maximumMessageBytes) {
    return { message, message_truncated: false };
  }
  const suffix = "…";
  const maximumPrefixBytes = maximumMessageBytes - getUtf8ByteLength(suffix);
  let prefix = "";
  let bytes = 0;
  for (const character of message) {
    const characterBytes = getUtf8ByteLength(character);
    if (bytes + characterBytes > maximumPrefixBytes) {
      break;
    }
    prefix += character;
    bytes += characterBytes;
  }
  return { message: `${prefix}${suffix}`, message_truncated: true };
}

/** ワークスペースの問題文を応答のUTF-8容量へ収めます。 */
export function normalizeExternalAgentWorkspaceIssue<TIssue extends { readonly message: string }>(
  issue: TIssue,
  maximumMessageBytes: number,
): TIssue & { readonly message_truncated: boolean } {
  return { ...issue, ...normalizeExternalAgentDiagnosticMessage(issue.message, maximumMessageBytes) };
}

/** 準備済み提案文脈をCLI応答へ変換します。 */
export function externalAgentPrepareResponse(prepared: {
  readonly request_id: string;
  readonly proposal_context_id: string;
  readonly workspace: { readonly workspaceId: string };
  readonly turn_context: unknown;
  readonly evidence_locator_prefix: string;
}): object {
  return {
    operation: "proposals.prepare",
    request_id: prepared.request_id,
    proposal_context_id: prepared.proposal_context_id,
    workspace_id: prepared.workspace.workspaceId,
    revision: 0,
    turn_context: prepared.turn_context,
    evidence_locator_prefix: prepared.evidence_locator_prefix,
  };
}

/** 提出済み外部提案をCLI応答へ変換します。 */
export function externalAgentSubmitResponse(
  workspaceId: string,
  revision: number,
  record: { readonly proposal_id: string; readonly request_id: string; readonly operation_ids: readonly string[]; readonly state: { readonly kind: string } },
): object {
  return {
    operation: "proposals.submit",
    workspace_id: workspaceId,
    revision,
    result: {
      kind: "submitted",
      proposal_id: record.proposal_id,
      request_id: record.request_id,
      operation_count: record.operation_ids.length,
      state_kind: record.state.kind,
    },
  };
}

/** ワークスペース編集結果をCLI応答へ変換します。 */
export function externalAgentWorkspaceEditsResponse(status: {
  readonly workspace_id: string;
  readonly revision: number;
  readonly state: string;
  readonly completion: string;
  readonly issues: readonly unknown[];
}): object {
  return {
    operation: "proposals.apply-edits",
    workspace_id: status.workspace_id,
    revision: status.revision,
    state: status.state,
    completion: status.completion,
    issue_count: status.issues.length,
  };
}

/** ワークスペース読取結果をCLI応答へ変換します。 */
export function externalAgentWorkspaceReadResponse<TChunk extends { readonly content: string; readonly offset: number }>(
  target: unknown,
  chunk: TChunk,
  maximumResponseBytes: number,
): object {
  const metadata = { operation: "proposals.read", target };
  return { ...metadata, ...limitExternalAgentWorkspaceChunk(chunk, metadata, maximumResponseBytes) };
}

/** ワークスペース差分をCLI応答へ変換します。 */
export function externalAgentWorkspaceDiffResponse<TChunk extends { readonly content: string; readonly offset: number }>(
  chunk: TChunk,
  maximumResponseBytes: number,
): object {
  const metadata = { operation: "proposals.diff" };
  return { ...metadata, ...limitExternalAgentWorkspaceChunk(chunk, metadata, maximumResponseBytes) };
}

/** ワークスペース本文をCLI応答の容量へ収めます。 */
export function limitExternalAgentWorkspaceChunk<TChunk extends {
  readonly content: string;
  readonly offset: number;
}>(
  chunk: TChunk,
  metadata: Record<string, unknown>,
  maximumResponseBytes: number,
): TChunk & { readonly next_offset?: number } {
  const response = { ...metadata, ...chunk };
  if (getUtf8ByteLength(JSON.stringify(response)) <= maximumResponseBytes) {
    return chunk;
  }
  let low = 0;
  let high = chunk.content.length;
  while (low < high) {
    let middle = Math.ceil((low + high) / 2);
    const previous = chunk.content.charCodeAt(middle - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) {
      middle -= 1;
    }
    if (middle <= low) {
      high = low;
      continue;
    }
    const candidate = {
      ...response,
      content: chunk.content.slice(0, middle),
      next_offset: chunk.offset + middle,
    };
    if (getUtf8ByteLength(JSON.stringify(candidate)) <= maximumResponseBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  if (low === 0) {
    throw new Error("読み取り応答の上限内に内容を収められません。");
  }
  return {
    ...chunk,
    content: chunk.content.slice(0, low),
    next_offset: chunk.offset + low,
  };
}

/** ワークスペース検証結果をCLI応答の容量で分割します。 */
export function paginateExternalAgentWorkspaceEntries<T>(
  entries: readonly T[],
  offset: number,
  createResponse: (page: readonly T[], nextOffset: number | undefined) => unknown,
  maximumResponseBytes: number,
  createInvalidOffsetError: () => Error,
): { readonly page: readonly T[]; readonly next_offset?: number } {
  if (offset > entries.length) {
    throw createInvalidOffsetError();
  }
  let end = Math.min(offset + 50, entries.length);
  while (end >= offset) {
    if (end === offset && end < entries.length) {
      break;
    }
    const nextOffset = end < entries.length ? end : undefined;
    const page = entries.slice(offset, end);
    if (getUtf8ByteLength(JSON.stringify(createResponse(page, nextOffset))) <= maximumResponseBytes) {
      return {
        page,
        ...(nextOffset == null ? {} : { next_offset: nextOffset }),
      };
    }
    end -= 1;
  }
  throw new Error("検証結果の応答を上限内に収められません。");
}
