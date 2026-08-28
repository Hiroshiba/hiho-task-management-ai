import { z } from "zod";
import {
  createUtf8ByteLimitedStringSchema,
  asanaProjectResponseSchema,
  asanaProjectReferenceResponseSchema,
  asanaSectionResponseSchema,
  asanaTagResponseSchema,
  gidSchema,
  identifierSchema,
  type AsanaProjectResponse,
} from "../../../shared/domain";
import {
  setupManifest,
  type SetupManifest,
} from "../setup";
import type { AsanaTransportRequestPort } from "../transport";

const listLimit = "100";
const workspaceOptFields = "gid,name";
const projectListOptFields = "gid,name";
const projectResponseOptFields = "gid,name,workspace.gid,workspace.name";
const sectionOptFields = "gid,name";
const tagOptFields = "gid,name";

const nextPageSchema = z
  .object({
    offset: identifierSchema,
    path: z.string(),
    uri: z.string(),
  })
  .strip();

const workspaceSchema = z
  .object({
    gid: gidSchema,
    name: z.string(),
  })
  .strip();

const workspacePageResponseSchema = z
  .object({
    data: z.array(workspaceSchema),
    next_page: nextPageSchema.nullable(),
  })
  .strip();

const projectListPageResponseSchema = z
  .object({
    data: z.array(asanaProjectReferenceResponseSchema),
    next_page: nextPageSchema.nullable(),
  })
  .strip();

const projectResponseSchema = z
  .object({
    data: asanaProjectResponseSchema,
  })
  .strip();

const sectionResponseSchema = z
  .object({
    data: asanaSectionResponseSchema,
  })
  .strip();

const tagResponseSchema = z
  .object({
    data: asanaTagResponseSchema,
  })
  .strip();

const projectNameSchema = createUtf8ByteLimitedStringSchema(1024)
  .refine((value) => value.trim().length > 0, {
    message: "プロジェクト名を空白だけにできません。",
  })
  .refine((value) => value.trim() === value, {
    message: "プロジェクト名の前後に空白を含められません。",
  })
  .refine((value) => !hasControlCharacter(value), {
    message: "プロジェクト名に制御文字を含められません。",
  });

const createProjectBodySchema = z
  .object({
    data: z
      .object({
        name: projectNameSchema,
        workspace: gidSchema,
      })
      .strict(),
  })
  .strict();

const createSectionBodySchema = z
  .object({
    data: z
      .object({
        name: z.string(),
      })
      .strict(),
  })
  .strict();

const createTagBodySchema = z
  .object({
    data: z
      .object({
        name: z.string(),
        workspace: gidSchema,
      })
      .strict(),
  })
  .strict();

type AsanaWorkspace = z.infer<typeof workspaceSchema>;
type AsanaProjectReference = z.infer<typeof asanaProjectReferenceResponseSchema>;
type AsanaSectionResponse = z.infer<typeof asanaSectionResponseSchema>;
type AsanaTagResponse = z.infer<typeof asanaTagResponseSchema>;

export type SetupSectionName = SetupManifest["sections"][number]["name"];
export type SetupTagName = SetupManifest["tags"][number]["name"];

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint == null) {
      throw new Error("プロジェクト名を検証できません。");
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function validateGid(value: string): string {
  return gidSchema.parse(value);
}

function validateSectionName(value: string): SetupSectionName {
  const validatedValue = z.string().parse(value);
  const declaration = setupManifest.sections.find(
    (section) => section.name === validatedValue,
  );
  if (declaration == null) {
    throw new Error("必須セクション以外の名前を指定できません。");
  }
  return declaration.name;
}

function validateTagName(value: string): SetupTagName {
  const validatedValue = z.string().parse(value);
  const declaration = setupManifest.tags.find(
    (tag) => tag.name === validatedValue,
  );
  if (declaration == null) {
    throw new Error("必須タグ以外の名前を指定できません。");
  }
  return declaration.name;
}

/** 初期設定で利用するAsana APIを提供します。 */
export class AsanaSetupClient {
  private readonly transport: AsanaTransportRequestPort;

  public constructor(transport: AsanaTransportRequestPort) {
    this.transport = transport;
  }

  /** 現在の利用者が参加するワークスペースを取得します。 */
  public async listCurrentUserWorkspaces(
    signal: AbortSignal,
  ): Promise<readonly AsanaWorkspace[]> {
    return this.listWorkspacePages(signal);
  }

  /** ワークスペース内のプロジェクトを100件ずつ取得します。 */
  public async listWorkspaceProjects(
    workspaceGid: string,
    signal: AbortSignal,
  ): Promise<readonly AsanaProjectReference[]> {
    const validatedWorkspaceGid = validateGid(workspaceGid);
    return this.listProjectPages(validatedWorkspaceGid, signal);
  }

  /** 専用プロジェクトを作成します。 */
  public async createProject(
    workspaceGid: string,
    name: string,
    signal: AbortSignal,
  ): Promise<AsanaProjectResponse> {
    const validatedWorkspaceGid = validateGid(workspaceGid);
    const validatedName = projectNameSchema.parse(name);
    const body = createProjectBodySchema.parse({
      data: {
        name: validatedName,
        workspace: validatedWorkspaceGid,
      },
    });
    const response = await this.transport.request(
      {
        method: "POST",
        path: ["projects"],
        query: { opt_fields: projectResponseOptFields },
        body,
        retry_safe: false,
        response_schema: projectResponseSchema,
      },
      signal,
    );
    return response.data;
  }

  /** 必須セクションを1つ作成します。 */
  public async createSection(
    projectGid: string,
    name: SetupSectionName,
    signal: AbortSignal,
  ): Promise<AsanaSectionResponse> {
    const validatedProjectGid = validateGid(projectGid);
    const validatedName = validateSectionName(name);
    const body = createSectionBodySchema.parse({
      data: { name: validatedName },
    });
    const response = await this.transport.request(
      {
        method: "POST",
        path: ["projects", validatedProjectGid, "sections"],
        query: { opt_fields: sectionOptFields },
        body,
        retry_safe: false,
        response_schema: sectionResponseSchema,
      },
      signal,
    );
    return response.data;
  }

  /** 必須タグを1つ作成します。 */
  public async createTag(
    workspaceGid: string,
    name: SetupTagName,
    signal: AbortSignal,
  ): Promise<AsanaTagResponse> {
    const validatedWorkspaceGid = validateGid(workspaceGid);
    const validatedName = validateTagName(name);
    const body = createTagBodySchema.parse({
      data: {
        name: validatedName,
        workspace: validatedWorkspaceGid,
      },
    });
    const response = await this.transport.request(
      {
        method: "POST",
        path: ["tags"],
        query: { opt_fields: tagOptFields },
        body,
        retry_safe: false,
        response_schema: tagResponseSchema,
      },
      signal,
    );
    return response.data;
  }

  private async listProjectPages(
    workspaceGid: string,
    signal: AbortSignal,
  ): Promise<readonly AsanaProjectReference[]> {
    const projects: AsanaProjectReference[] = [];
    const seenOffsets = new Set<string>();
    let offset: string | undefined;

    while (true) {
      const query: Record<string, string> = {
        limit: listLimit,
        opt_fields: projectListOptFields,
      };
      if (offset != null) {
        query.offset = offset;
      }
      const response = await this.transport.request(
        {
          method: "GET",
          path: ["workspaces", workspaceGid, "projects"],
          query,
          response_schema: projectListPageResponseSchema,
        },
        signal,
      );
      projects.push(...response.data);
      const nextPage = response.next_page;
      if (nextPage == null) {
        return projects;
      }
      if (seenOffsets.has(nextPage.offset)) {
        throw new Error("Asana APIのページングoffsetが進みません。");
      }
      seenOffsets.add(nextPage.offset);
      offset = nextPage.offset;
    }
  }

  private async listWorkspacePages(
    signal: AbortSignal,
  ): Promise<readonly AsanaWorkspace[]> {
    const workspaces: AsanaWorkspace[] = [];
    const seenOffsets = new Set<string>();
    let offset: string | undefined;

    while (true) {
      const query: Record<string, string> = {
        limit: listLimit,
        opt_fields: workspaceOptFields,
      };
      if (offset != null) {
        query.offset = offset;
      }
      const response = await this.transport.request(
        {
          method: "GET",
          path: ["workspaces"],
          query,
          response_schema: workspacePageResponseSchema,
        },
        signal,
      );
      workspaces.push(...response.data);
      const nextPage = response.next_page;
      if (nextPage == null) {
        return workspaces;
      }
      if (seenOffsets.has(nextPage.offset)) {
        throw new Error("Asana APIのページングoffsetが進みません。");
      }
      seenOffsets.add(nextPage.offset);
      offset = nextPage.offset;
    }
  }
}
