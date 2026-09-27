import type {
  SetupCodexAvailability,
  SetupProject,
  SetupState,
} from "../../domain/setup-state";
import type { SetupValidationPort } from "./setup-ports";

/** 初回設定の状態とAsana参照を注入されたparserで検証します。 */
export function createSetupStateTools(validation: SetupValidationPort): {
  readonly parseProjectReference: (value: unknown) => SetupProject;
  readonly parseState: (value: unknown) => SetupState;
  readonly credentialsRequiredState: (
    codex: SetupCodexAvailability,
  ) => Extract<SetupState, { kind: "credentials_required" }>;
  readonly requireCodexAvailability: (
    availability: SetupCodexAvailability | undefined,
  ) => SetupCodexAvailability;
  readonly requireCodexAvailable: (
    availability: SetupCodexAvailability | undefined,
  ) => Extract<SetupCodexAvailability, { kind: "available" }>;
} {
  const parseState = (value: unknown): SetupState => validation.parseState(value);
  const requireCodexAvailability = (
    availability: SetupCodexAvailability | undefined,
  ): SetupCodexAvailability => {
    if (availability == null) {
      throw new Error("Codex状態が確定していません。");
    }
    return validation.parseCodexAvailability(availability);
  };
  return {
    parseProjectReference: (value) => validation.parseProjectReference(value),
    parseState,
    credentialsRequiredState: (codex) => {
      const state = parseState({ kind: "credentials_required", step: "credentials", codex });
      if (state.kind !== "credentials_required") {
        throw new Error("Client ID入力状態を生成できません。");
      }
      return state;
    },
    requireCodexAvailability,
    requireCodexAvailable: (availability) => {
      const parsed = requireCodexAvailability(availability);
      if (parsed.kind !== "available") {
        throw new Error("Codex CLIの利用可能状態が確定していません。");
      }
      return parsed;
    },
  };
}
