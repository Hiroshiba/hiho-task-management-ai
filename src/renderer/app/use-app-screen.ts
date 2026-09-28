import { shallowRef, type ShallowRef } from "vue";
import { z } from "zod";

const appScreenSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("loading") }).strict(),
  z.object({ kind: z.literal("setup") }).strict(),
  z.object({ kind: z.literal("dashboard") }).strict(),
  z.object({ kind: z.literal("error"), message: z.string().min(1) }).strict(),
]);

type AppScreen = z.infer<typeof appScreenSchema>;

type AppScreenController = {
  readonly screen: Readonly<ShallowRef<AppScreen>>;
  readonly showSetup: () => void;
  readonly showDashboard: () => void;
  readonly showError: (message: string) => void;
};

/** 起動画面の状態と遷移を所有します。 */
export function useAppScreen(): AppScreenController {
  const screen = shallowRef<AppScreen>(appScreenSchema.parse({ kind: "loading" }));
  return {
    screen,
    showSetup: () => {
      screen.value = appScreenSchema.parse({ kind: "setup" });
    },
    showDashboard: () => {
      screen.value = appScreenSchema.parse({ kind: "dashboard" });
    },
    showError: (message) => {
      screen.value = appScreenSchema.parse({ kind: "error", message });
    },
  };
}
