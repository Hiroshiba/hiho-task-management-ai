import { z } from "zod";
import type { CodexDiagnostic, CodexNotification } from "../codex-app-server";
import {
  isValidThreadSettingsNotification,
  validateSandboxPolicy,
  type ThreadSettingsNotification,
} from "./capability-policy";
import {
  CodexSessionCapabilityError,
  CodexSessionTurnError,
  CodexThreadStartCapabilityError,
} from "./errors";

type NotificationRouterOptions = {
  readonly notificationSchema: z.ZodType<CodexNotification>;
  readonly diagnosticSchema: z.ZodType<CodexDiagnostic>;
  readonly tmpDirectoryPath: string;
  readonly getState: () => string;
  readonly getThreadId: () => string | undefined;
  readonly setThreadSettingsNotification: (notification: ThreadSettingsNotification) => void;
  readonly recordDiagnosticLocally: (code: "connection_unknown_notification" | "connection_server_request_rejected", error: unknown) => void;
  readonly recordDiagnosticAndNotify: (code: "connection_protocol_error" | "connection_stderr" | "connection_listener_error" | "connection_stop_error", error: unknown) => void;
  readonly markSafetyViolation: (error: unknown, disposition: { kind: "record" } | { kind: "already_recorded" }) => void;
  readonly failActiveTurn: (error: unknown, turnError: CodexSessionTurnError) => void;
  readonly onProcessExit: (diagnostic: Extract<CodexDiagnostic, { kind: "process_exit" }>) => void;
  readonly onSkillsChanged: () => void;
  readonly onTurnNotification: (notification: CodexNotification) => void;
};

function isSafetyCriticalState(state: string): boolean {
  return state === "starting"
    || state === "authentication_required"
    || state === "ready"
    || state === "turning"
    || state === "restarting";
}

/** Codex接続からの通知と診断をセッションへ配送します。 */
export class CodexSessionNotificationRouter {
  public constructor(private readonly options: NotificationRouterOptions) {}

  /** Codex通知を検証してセッションへ配送します。 */
  public receiveNotification(notification: CodexNotification): void {
    const parsed = this.options.notificationSchema.safeParse(notification);
    if (!parsed.success) {
      this.handleProtocolError(parsed.error);
      return;
    }
    try {
      this.handleNotification(parsed.data);
    } catch (error: unknown) {
      this.handleProtocolError(error);
    }
  }

  /** Codex接続の診断を検証してセッションへ配送します。 */
  public receiveDiagnostic(diagnostic: CodexDiagnostic): void {
    const parsed = this.options.diagnosticSchema.safeParse(diagnostic);
    if (!parsed.success) {
      this.options.recordDiagnosticAndNotify("connection_protocol_error", parsed.error);
      if (isSafetyCriticalState(this.options.getState())) {
        this.options.markSafetyViolation(parsed.error, { kind: "already_recorded" });
      }
      return;
    }
    this.handleConnectionDiagnostic(parsed.data);
  }

  private handleProtocolError(error: unknown): void {
    this.options.recordDiagnosticAndNotify("connection_protocol_error", error);
    if (isSafetyCriticalState(this.options.getState())) {
      this.options.markSafetyViolation(error, { kind: "already_recorded" });
    } else {
      this.options.failActiveTurn(error, new CodexSessionTurnError(error));
    }
  }

  private handleConnectionDiagnostic(diagnostic: CodexDiagnostic): void {
    switch (diagnostic.kind) {
      case "unknown_notification":
        this.options.recordDiagnosticLocally("connection_unknown_notification", undefined);
        break;
      case "server_request_rejected":
        this.options.recordDiagnosticLocally("connection_server_request_rejected", undefined);
        break;
      case "protocol_error":
        this.options.recordDiagnosticAndNotify("connection_protocol_error", diagnostic.error);
        if (isSafetyCriticalState(this.options.getState())) {
          this.options.markSafetyViolation(diagnostic.error, { kind: "already_recorded" });
        }
        break;
      case "stderr":
        this.options.recordDiagnosticAndNotify("connection_stderr", new Error(diagnostic.line));
        break;
      case "listener_error":
        this.options.recordDiagnosticAndNotify("connection_listener_error", diagnostic.error);
        break;
      case "stop_error":
        this.options.recordDiagnosticAndNotify("connection_stop_error", diagnostic.error);
        break;
      case "process_exit":
        this.options.onProcessExit(diagnostic);
        break;
    }
  }

  private handleNotification(notification: CodexNotification): void {
    if (notification.method === "thread/settings/updated") {
      const activeProfile = notification.params.threadSettings.activePermissionProfile;
      const profileId = activeProfile == null ? undefined : activeProfile.id;
      const profileExtends = activeProfile == null ? undefined : activeProfile.extends;
      const sandboxValidation = validateSandboxPolicy(
        notification.params.threadSettings.sandboxPolicy,
        this.options.tmpDirectoryPath,
      );
      const threadSettingsNotification: ThreadSettingsNotification = {
        threadId: notification.params.threadId,
        profileId,
        profileExtends,
        sandboxValidation,
      };
      this.options.setThreadSettingsNotification(threadSettingsNotification);
      if (
        this.options.getThreadId() === notification.params.threadId
        && isSafetyCriticalState(this.options.getState())
        && !isValidThreadSettingsNotification(threadSettingsNotification)
      ) {
        if (sandboxValidation.kind !== "valid") {
          this.options.markSafetyViolation(
            new CodexThreadStartCapabilityError(sandboxValidation.failureCode),
            { kind: "record" },
          );
        } else {
          this.options.markSafetyViolation(
            new CodexSessionCapabilityError("Codexスレッドの権限制約が変更されました。"),
            { kind: "record" },
          );
        }
      }
      return;
    }
    if (notification.method === "skills/changed") {
      this.options.onSkillsChanged();
      return;
    }
    this.options.onTurnNotification(notification);
  }
}
