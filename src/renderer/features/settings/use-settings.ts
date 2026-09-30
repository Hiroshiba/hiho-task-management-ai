import { ref, watch } from "vue";
import type { SettingsApi } from "../../../shared/ipc-contracts/settings";
import type { SetupState } from "../../../shared/ipc-contracts/setup-schemas";
import { useSettingsApi } from "../../shared/api/feature-apis";
import { useAsanaReauthentication } from "./use-asana-reauthentication";
import { useSetup } from "./use-setup";

type SynchronizationResult = Extract<Awaited<ReturnType<SettingsApi["completeAsanaReauthentication"]>>, { readonly kind: "ok" }>["value"];
type FeedbackKind = "success" | "progress" | "warning" | "failure";
type Feedback = { readonly kind: FeedbackKind; readonly message: string };

type SettingsOptions = {
  readonly onSetupState: (state: SetupState) => void;
  readonly onFeedback: (kind: FeedbackKind, message: string) => void;
  readonly onToast: (kind: "success" | "warning", message: string) => void;
  readonly onCodexAuthentication: () => Promise<void>;
  readonly onDialogOpen: () => void;
  readonly authenticationRequired: () => boolean;
  readonly onAuthenticationRequired: () => void;
  readonly onAuthenticationIdle: () => Promise<void>;
  readonly onAuthenticationFailure: () => Promise<void>;
  readonly onSynchronized: (result: SynchronizationResult) => Promise<boolean>;
  readonly onNormalizationNotifications: (result: SynchronizationResult) => void;
};

/** 設定画面、初回設定、Asana認証の状態を所有します。 */
export function useSettings(options: SettingsOptions) {
  const api = useSettingsApi();
  const dialogVisible = ref(false);
  const dialogFeedback = ref<Feedback>();
  const setup = useSetup(api, {
    onState: (state) => {
      if (state.kind !== "ready") {
        authentication.reset();
      }
      options.onSetupState(state);
    },
    onFeedback: (feedback) => options.onFeedback(feedback.kind, feedback.message),
    onToast: options.onToast,
    onReady: () => authentication.load(),
    onCodexAuthentication: options.onCodexAuthentication,
  });
  const authentication = useAsanaReauthentication(api, {
    configured: () => setup.configured.value,
    authenticationRequired: options.authenticationRequired,
    onFeedback: options.onFeedback,
    onToast: options.onToast,
    onAuthenticationRequired: options.onAuthenticationRequired,
    onAuthenticationIdle: options.onAuthenticationIdle,
    onAuthenticationFailure: options.onAuthenticationFailure,
    onSynchronized: options.onSynchronized,
    onNormalizationNotifications: options.onNormalizationNotifications,
  });

  watch(dialogVisible, (open) => {
    if (open) {
      options.onDialogOpen();
    }
  });

  function closeDialog(): void {
    dialogVisible.value = false;
  }

  function setDialogFeedback(value: Feedback | undefined): void {
    dialogFeedback.value = value;
  }

  return { setup, authentication, dialogVisible, dialogFeedback, closeDialog, setDialogFeedback };
}
