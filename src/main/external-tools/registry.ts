import {
  externalToolDefinitionSchema,
  type ExternalToolDefinition,
} from "./schemas";
import { ExternalToolError } from "./errors";

function cloneDefinition(definition: ExternalToolDefinition): ExternalToolDefinition {
  return externalToolDefinitionSchema.parse({
    ...definition,
    allowed_subcommands: [...definition.allowed_subcommands],
    allowed_argument_names: [...definition.allowed_argument_names],
    ...(definition.allowed_domains == null
      ? {}
      : { allowed_domains: [...definition.allowed_domains] }),
    ...(definition.allowed_http_methods == null
      ? {}
      : { allowed_http_methods: [...definition.allowed_http_methods] }),
  });
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** 読み取り専用外部ツールの登録を管理します。 */
export class ExternalToolRegistry {
  private readonly definitions = new Map<string, ExternalToolDefinition>();

  /** 読み取り専用外部ツールを登録します。 */
  public register(definition: ExternalToolDefinition): void {
    const validatedDefinition = externalToolDefinitionSchema.parse(definition);
    if (this.definitions.has(validatedDefinition.tool_id)) {
      throw new ExternalToolError(
        "registry_conflict",
        "同じ外部ツールIDは重複して登録できません。",
        false,
      );
    }
    this.definitions.set(
      validatedDefinition.tool_id,
      cloneDefinition(validatedDefinition),
    );
  }

  /** 登録済み外部ツールを取得します。 */
  public get(toolId: string): ExternalToolDefinition {
    const validatedToolId = externalToolDefinitionSchema.shape.tool_id.parse(toolId);
    const definition = this.definitions.get(validatedToolId);
    if (definition == null) {
      throw new ExternalToolError(
        "tool_not_registered",
        "指定された外部ツールは登録されていません。",
        false,
      );
    }
    return cloneDefinition(definition);
  }

  /** 登録済み外部ツールをID順に取得します。 */
  public list(): readonly ExternalToolDefinition[] {
    return [...this.definitions.values()]
      .sort((left, right) => compareStrings(left.tool_id, right.tool_id))
      .map(cloneDefinition);
  }
}
