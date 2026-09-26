import type { CodexNotification } from "../codex-app-server";

/** ターンに属するCodex通知を判定します。 */
export function isTurnNotification(notification: CodexNotification): boolean {
  return (
    notification.method === "turn/started"
    || notification.method === "turn/completed"
    || notification.method === "item/completed"
    || notification.method === "item/agentMessage/delta"
  );
}

/** Codex通知が属するスレッドIDを返します。 */
export function notificationThreadId(notification: CodexNotification): string | undefined {
  switch (notification.method) {
    case "turn/started":
    case "turn/completed":
    case "item/completed":
    case "item/agentMessage/delta":
      return notification.params.threadId;
    default:
      return undefined;
  }
}

/** Codex通知が属するターンIDを返します。 */
export function notificationTurnId(notification: CodexNotification): string | undefined {
  switch (notification.method) {
    case "turn/started":
    case "turn/completed":
      return notification.params.turn.id;
    case "item/completed":
    case "item/agentMessage/delta":
      return notification.params.turnId;
    default:
      return undefined;
  }
}
