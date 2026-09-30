import type { Input } from "electron";

/** 最大化ショートカットか判定します。 */
export function isMaximizeShortcut(input: Input): boolean {
  const commandOrControl = process.platform === "darwin"
    ? input.meta && !input.control
    : input.control && !input.meta;
  return (
    commandOrControl
    && input.shift
    && !input.alt
    && input.code === "KeyM"
  );
}

/** 全画面ショートカットか判定します。 */
export function isFullscreenShortcut(input: Input): boolean {
  if (process.platform === "darwin") {
    return (
      input.control
      && input.meta
      && !input.shift
      && !input.alt
      && input.code === "KeyF"
    );
  }
  return (
    !input.control
    && !input.meta
    && !input.alt
    && !input.shift
    && input.code === "F11"
  );
}
