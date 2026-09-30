import { inject, ref, type InjectionKey, type Ref } from "vue";

export type ToastKind = "success" | "warning";

type ToastMessage = {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
  readonly duration: number;
};

export type PersistentToast = {
  readonly update: (message: string) => void;
  readonly dismiss: () => void;
};

type ToastStore = {
  readonly messages: Readonly<Ref<readonly ToastMessage[]>>;
  readonly addToast: (kind: ToastKind, message: string) => void;
  readonly addPersistentToast: (kind: ToastKind, message: string) => PersistentToast;
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

  function addToastMessage(kind: ToastKind, message: string, duration: number): number {
    if (message.trim().length === 0) {
      throw new Error("通知メッセージを空にできません。");
    }
    const toast: ToastMessage = {
      id: nextMessageId,
      kind,
      message,
      duration,
    };
    nextMessageId += 1;
    messages.value = [...messages.value, toast];
    return toast.id;
  }

  function addToast(kind: ToastKind, message: string): void {
    addToastMessage(kind, message, 5000);
  }

  function addPersistentToast(kind: ToastKind, message: string): PersistentToast {
    const id = addToastMessage(kind, message, Number.POSITIVE_INFINITY);
    return {
      update: (nextMessage) => {
        if (nextMessage.trim().length === 0) throw new Error("通知メッセージを空にできません。");
        messages.value = messages.value.map((toast) => toast.id === id ? { ...toast, message: nextMessage } : toast);
      },
      dismiss: () => dismissToast(id),
    };
  }

  function dismissToast(id: number): void {
    messages.value = messages.value.filter((toast) => toast.id !== id);
  }

  function clearToasts(): void {
    messages.value = [];
  }

  return { messages, addToast, addPersistentToast, dismissToast, clearToasts };
}

/** アプリのトースト通知を参照します。 */
export function useToast(): ToastStore {
  const store = inject(toastStoreInjectionKey);
  assertNonNullable(store, "トースト通知の状態が提供されていません。");
  return store;
}
