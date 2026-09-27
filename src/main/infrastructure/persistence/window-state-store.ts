import { z } from "zod";
import type { PersistentTextFile } from "./persistent-text-file";

export const windowStateVersion = 1;

const windowBoundsSchema = z
  .object({
    x: z.number().finite().int(),
    y: z.number().finite().int(),
    width: z.number().finite().int().positive(),
    height: z.number().finite().int().positive(),
  })
  .strict();

const normalWindowModeSchema = z.enum(["normal", "maximized"]);

export const windowStateSchema = z.discriminatedUnion("mode", [
  z
    .object({
      version: z.literal(windowStateVersion),
      mode: z.literal("normal"),
      bounds: windowBoundsSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(windowStateVersion),
      mode: z.literal("maximized"),
      bounds: windowBoundsSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(windowStateVersion),
      mode: z.literal("fullscreen"),
      restore_mode: normalWindowModeSchema,
      bounds: windowBoundsSchema,
    })
    .strict(),
]);

export type WindowState = z.infer<typeof windowStateSchema>;
export type NormalWindowMode = z.infer<typeof normalWindowModeSchema>;

function parseWindowState(serialized: string): WindowState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error("ウィンドウ状態のJSONが不正です。", { cause: error });
  }
  try {
    return windowStateSchema.parse(parsed);
  } catch (error) {
    throw new Error("ウィンドウ状態の内容が不正です。", { cause: error });
  }
}

/** ウィンドウ状態を安全なJSONとして保存・読み込みします。 */
export class WindowStateStore {
  public constructor(private readonly file: PersistentTextFile) {}

  /** 保存済みウィンドウ状態を検証して読み出します。 */
  public load(): WindowState | undefined {
    const serialized = this.file.read();
    if (serialized == null) {
      return undefined;
    }
    return parseWindowState(serialized);
  }

  /** ウィンドウ状態を原子的に保存します。 */
  public save(state: WindowState): void {
    this.file.replaceAtomically(
      JSON.stringify(windowStateSchema.parse(state)),
      "ウィンドウ状態",
    );
  }
}
