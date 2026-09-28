type ExternalTaskQuery = (
  | { readonly operation: "tasks.list" }
  | { readonly operation: "tasks.get"; readonly gid: string }
  | { readonly operation: "tasks.rank" }
  | { readonly operation: "tasks.graph" }
  | { readonly operation: "tasks.areas" }
  | { readonly operation: "tasks.search-local"; readonly query: string }
) & { readonly proposal_context_id?: string | undefined };

/** 外部連携のタスク読取要求をtaskctl要求へ変換します。 */
export function externalAgentTaskctlQuery(input: ExternalTaskQuery):
  | { readonly command: "list" }
  | { readonly command: "get"; readonly gid: string }
  | { readonly command: "rank" }
  | { readonly command: "graph" }
  | { readonly command: "areas" }
  | { readonly command: "search-local"; readonly query: string } {
  switch (input.operation) {
    case "tasks.list":
      return { command: "list" };
    case "tasks.get":
      return { command: "get", gid: input.gid };
    case "tasks.rank":
      return { command: "rank" };
    case "tasks.graph":
      return { command: "graph" };
    case "tasks.areas":
      return { command: "areas" };
    case "tasks.search-local":
      return { command: "search-local", query: input.query };
  }
}

/** 外部連携のタスク照会を選択した基準スナップショットで実行します。 */
export function executeExternalAgentTaskQuery<TSnapshot, TResult, TResponse>(
  input: ExternalTaskQuery,
  ports: {
    readonly assertReadReady: () => void;
    readonly getCurrentSnapshot: () => TSnapshot;
    readonly getPreparedSnapshot: (contextId: string) => TSnapshot;
    readonly execute: (query: ReturnType<typeof externalAgentTaskctlQuery>, snapshot: TSnapshot) => TResult;
    readonly parseResponse: (value: unknown) => TResponse;
  },
): TResponse {
  const contextId = input.proposal_context_id;
  let snapshot: TSnapshot;
  if (contextId == null) {
    ports.assertReadReady();
    snapshot = ports.getCurrentSnapshot();
  } else {
    snapshot = ports.getPreparedSnapshot(contextId);
  }
  const query = externalAgentTaskctlQuery(input);
  const result = ports.execute(query, snapshot);
  return ports.parseResponse({
    operation: input.operation,
    ...(contextId == null ? {} : { proposal_context_id: contextId }),
    result,
  });
}
