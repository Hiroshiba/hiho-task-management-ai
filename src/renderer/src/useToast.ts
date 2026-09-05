import { ref, type Ref } from "vue";

export type ToastKind = "success" | "warning";

type ToastMessage = {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
};

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

/** トースト通知を管理します。 */
export function useToast(): {
  readonly messages: Readonly<Ref<readonly ToastMessage[]>>;
  readonly addToast: (kind: ToastKind, message: string) => void;
  readonly dismissToast: (id: number) => void;
} {
  return {
    messages,
    addToast,
    dismissToast,
  };
}
