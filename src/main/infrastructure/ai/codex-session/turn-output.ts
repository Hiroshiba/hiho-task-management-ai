import { z } from "zod";
import { CodexSessionCapabilityError, CodexSessionError, CodexSessionOutputValidationError } from "./errors";

type TurnInputItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "skill"; readonly name: string; readonly path: string };

/** Codexへ渡す構造化出力の形式指示を作成します。 */
export function createModelFormatInstruction<Response, Input extends TurnInputItem[]>(
  responseSchema: z.ZodType<Response>,
  inputSchema: z.ZodType<Input>,
): string {
  const generated = z.toJSONSchema(responseSchema, { target: "draft-07" });
  const parsed = z.object({}).passthrough().safeParse(generated);
  if (!parsed.success) {
    throw new CodexSessionCapabilityError(
      "構造化出力スキーマをJSONオブジェクトへ変換できません。",
      parsed.error,
    );
  }
  const serialized = JSON.stringify(parsed.data);
  if (serialized == null) {
    throw new CodexSessionCapabilityError(
      "構造化出力スキーマをJSON文字列へ変換できません。",
    );
  }
  const instruction = [
    "最終応答はJSONオブジェクトだけにしてください。",
    "最上位オブジェクトにはresponse_jsonだけを含めてください。",
    "response_jsonには、次のJSON Schemaを満たすオブジェクトをJSON文字列化した文字列を指定してください。",
    "response_jsonの値はJSONとして解析できなければなりません。",
    "Markdown、コードフェンス、説明、前後の余分な文字は付けないでください。",
    "response_jsonをJSONとして解析した結果は、次のJSON Schemaを満たす必要があります。",
    serialized,
  ].join("\n");
  const validatedInstruction = inputSchema.safeParse([{ type: "text", text: instruction }]);
  if (!validatedInstruction.success) {
    throw new CodexSessionCapabilityError(
      "構造化出力の形式指示が上限を超えています。",
      validatedInstruction.error,
    );
  }
  const instructionItem = validatedInstruction.data[0];
  if (instructionItem == null || instructionItem.type !== "text") {
    throw new CodexSessionCapabilityError(
      "構造化出力の形式指示を作成できません。",
    );
  }
  return instructionItem.text;
}

/** 最初のテキスト入力へ構造化出力の形式指示を付けます。 */
export function prependModelFormatInstruction<Input extends TurnInputItem[]>(
  input: Input,
  instruction: string,
  inputSchema: z.ZodType<Input>,
): Input {
  let textFound = false;
  const prefixedInput = input.map((item) => {
    if (textFound || item.type !== "text") {
      return item;
    }
    textFound = true;
    return {
      ...item,
      text: `${instruction}\n\n${item.text}`,
    };
  });
  if (!textFound) {
    throw new CodexSessionError("Codexターン入力にテキスト項目がありません。");
  }
  return inputSchema.parse(prefixedInput);
}

/** Codexの最終応答を構造化出力として検証します。 */
export function parseStructuredOutput<Response>(
  text: string,
  envelopeSchema: z.ZodType<{ response_json: string }>,
  responseSchema: z.ZodType<Response>,
): Response {
  let parsedEnvelope: unknown;
  try {
    parsedEnvelope = JSON.parse(text);
  } catch (error: unknown) {
    throw new CodexSessionOutputValidationError(error);
  }
  const envelope = envelopeSchema.safeParse(parsedEnvelope);
  if (!envelope.success) {
    throw new CodexSessionOutputValidationError(envelope.error);
  }
  let parsedResponse: unknown;
  try {
    parsedResponse = JSON.parse(envelope.data.response_json);
  } catch (error: unknown) {
    throw new CodexSessionOutputValidationError(error);
  }
  const response = responseSchema.safeParse(parsedResponse);
  if (!response.success) {
    throw new CodexSessionOutputValidationError(response.error);
  }
  return response.data;
}
