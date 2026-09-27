type ExternalTaskQuery =
  | { readonly operation: "tasks.list" }
  | { readonly operation: "tasks.get"; readonly gid: string }
  | { readonly operation: "tasks.rank" }
  | { readonly operation: "tasks.graph" }
  | { readonly operation: "tasks.areas" }
  | { readonly operation: "tasks.search-local"; readonly query: string };

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
