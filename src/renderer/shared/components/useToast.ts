import { inject, ref, type InjectionKey, type Ref } from "vue";

export type ToastKind = "success" | "warning";

type ToastMessage = {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
};

type ToastStore = {
  readonly messages: Readonly<Ref<readonly ToastMessage[]>>;
  readonly addToast: (kind: ToastKind, message: string) => void;
  readonly dismissToast: (id: number) => void;
  readonly clearToasts: () => void;
};

export const toastStoreInjectionKey: InjectionKey<ToastStore> = Symbol("toastStore");

function assertNonNullable<T>(value: T | undefined, message: string): asserts value is T {
  if (value == null) {
    throw new Error(message);
  }
}

/** アプリごとのトースト通知を生成します。 */
export function createToastStore(): ToastStore {
  const messages = ref<readonly ToastMessage[]>([]);
  let nextMessageId = 1;

  function addToast(kind: ToastKind, message: string): void {
    if (message.trim().length === 0) {
      throw new Error("通知メッセージを空にできません。");
    }
    const toast: ToastMessage = {
      id: nextMessageId,
      kind,
      message,
    };
    nextMessageId += 1;
    messages.value = [...messages.value, toast];
  }

  function dismissToast(id: number): void {
    messages.value = messages.value.filter((toast) => toast.id !== id);
  }

  function clearToasts(): void {
    messages.value = [];
  }

  return { messages, addToast, dismissToast, clearToasts };
}

/** アプリのトースト通知を参照します。 */
export function useToast(): ToastStore {
  const store = inject(toastStoreInjectionKey);
  assertNonNullable(store, "トースト通知の状態が提供されていません。");
  return store;
}
