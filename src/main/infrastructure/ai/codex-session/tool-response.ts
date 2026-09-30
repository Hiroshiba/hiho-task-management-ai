import { z } from "zod";
import type { DynamicToolCallResponse } from "../codex-app-server";
import { CodexSessionError } from "./errors";

/** Codex dynamic toolの応答を上限内のJSONへ変換します。 */
export class CodexToolResponseSerializer<Taskctl extends { readonly ok: boolean }, Obsidian extends { readonly ok: boolean }> {
  private readonly maximumProposalWorkspaceResponseBytes: number;
  private readonly maximumDynamicToolResponseBytes: number;
  private readonly taskctlResponseSchema: z.ZodType<Taskctl>;
  private readonly obsidianResponseSchema: z.ZodType<Obsidian>;

  public constructor(
    maximumProposalWorkspaceResponseBytes: number,
    maximumDynamicToolResponseBytes: number,
    taskctlResponseSchema: z.ZodType<Taskctl>,
    obsidianResponseSchema: z.ZodType<Obsidian>,
  ) {
    this.maximumProposalWorkspaceResponseBytes = maximumProposalWorkspaceResponseBytes;
    this.maximumDynamicToolResponseBytes = maximumDynamicToolResponseBytes;
    this.taskctlResponseSchema = taskctlResponseSchema;
    this.obsidianResponseSchema = obsidianResponseSchema;
  }

  /** AI変更案ワークスペースの応答を変換します。 */
  public serializeProposalWorkspaceToolResponse(value: unknown, success: boolean): DynamicToolCallResponse {
    const serialized = JSON.stringify(value);
    if (serialized == null) {
      throw new CodexSessionError("AI変更案ワークスペースの応答をJSONへ変換できません。");
    }
    if (Buffer.byteLength(serialized, "utf8") > this.maximumProposalWorkspaceResponseBytes) {
      return this.serializeProposalWorkspaceToolResponse({
        ok: false,
        error: { code: "response_too_large", message: "診断結果が大きすぎます。部分読み取りを使用してください。" },
      }, false);
    }
    return { contentItems: [{ type: "inputText", text: serialized }], success };
  }

  /** AI変更案ワークスペースの入力診断を変換します。 */
  public serializeProposalWorkspaceInvalidRequest(error: z.ZodError): DynamicToolCallResponse {
    const issueCount = error.issues.length;
    const issues = error.issues.slice(0, 50).map((issue) => ({
      code: issue.code,
      json_pointer: issue.path
        .map((part) => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`)
        .join(""),
      expected_type: issue.code === "invalid_type" ? issue.expected : null,
    }));
    while (true) {
      const result = {
        ok: false,
        error: {
          code: "invalid_request",
          message: "AI変更案ワークスペースの引数が不正です。",
          issue_count: issueCount,
          issues_truncated: issues.length < issueCount,
          issues,
        },
      };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") <= this.maximumProposalWorkspaceResponseBytes) {
        return this.serializeProposalWorkspaceToolResponse(result, false);
      }
      if (issues.length === 0) {
        throw new CodexSessionError("AI変更案ワークスペースの入力診断を分割できません。");
      }
      issues.pop();
    }
  }

  /** AI変更案ワークスペースの検証結果をページ化します。 */
  public serializeProposalWorkspaceIssuesResponse<Result extends object, Issue>(
    result: Result,
    issues: readonly Issue[],
    offset: number,
    success: boolean,
  ): DynamicToolCallResponse {
    const start = Math.min(offset, issues.length);
    let end = Math.min(start + 50, issues.length);
    while (end >= start) {
      const page = {
        ...result,
        issues: issues.slice(start, end),
        issue_count: issues.length,
        ...(end < issues.length ? { next_offset: end } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(page), "utf8") <= this.maximumProposalWorkspaceResponseBytes) {
        return this.serializeProposalWorkspaceToolResponse(page, success);
      }
      end -= 1;
    }
    throw new CodexSessionError("AI変更案ワークスペースの診断結果を分割できません。");
  }

  /** taskctl応答を検証してサイズ上限内へ変換します。 */
  public serializeDynamicToolResponse(response: Taskctl): DynamicToolCallResponse {
    const validatedResponse = this.taskctlResponseSchema.parse(response);
    const serialized = z.string().parse(JSON.stringify(validatedResponse));
    if (Buffer.byteLength(serialized, "utf8") <= this.maximumDynamicToolResponseBytes) {
      return {
        contentItems: [{ type: "inputText", text: serialized }],
        success: validatedResponse.ok,
      };
    }
    const fallback = this.taskctlResponseSchema.parse({
      ok: false,
      error: { code: "response_too_large", message: "taskctl応答が大きすぎます。" },
      sync: { kind: "unavailable" },
    });
    const serializedFallback = z.string().parse(JSON.stringify(fallback));
    if (Buffer.byteLength(serializedFallback, "utf8") > this.maximumDynamicToolResponseBytes) {
      throw new CodexSessionError("taskctl応答のサイズ上限を確認できません。");
    }
    return {
      contentItems: [{ type: "inputText", text: serializedFallback }],
      success: false,
    };
  }

  /** Obsidian応答を検証してサイズ上限内へ変換します。 */
  public serializeObsidianDynamicToolResponse(response: Obsidian): DynamicToolCallResponse {
    const validatedResponse = this.obsidianResponseSchema.parse(response);
    const serialized = z.string().parse(JSON.stringify(validatedResponse));
    if (Buffer.byteLength(serialized, "utf8") <= this.maximumDynamicToolResponseBytes) {
      return {
        contentItems: [{ type: "inputText", text: serialized }],
        success: validatedResponse.ok,
      };
    }
    const fallback = this.obsidianResponseSchema.parse({
      ok: false,
      error: { code: "response_too_large", message: "Obsidian応答が大きすぎます。" },
    });
    const serializedFallback = z.string().parse(JSON.stringify(fallback));
    if (Buffer.byteLength(serializedFallback, "utf8") > this.maximumDynamicToolResponseBytes) {
      throw new CodexSessionError("Obsidian応答のサイズ上限を確認できません。");
    }
    return {
      contentItems: [{ type: "inputText", text: serializedFallback }],
      success: false,
    };
  }
}
