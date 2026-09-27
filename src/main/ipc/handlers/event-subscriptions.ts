import type { IpcMain, IpcMainEvent, WebContents } from "electron";
import type { z } from "zod";

type EventName = "app-update:state" | "sync:state" | "ai:delta" | "ai:status" | "external-agent:state";

interface EventSubscriptionsOptions {
  readonly validateChannel: (channel: string) => string;
  readonly validateSender: (event: IpcMainEvent) => void;
  readonly validateRequest: (payload: unknown) => void;
  readonly record: (error: unknown, channel: string) => void;
}

/** IPCのイベント購読と送信、登録解除を管理します。 */
export class IpcEventSubscriptions {
  private readonly subscribers = new Map<EventName, Set<WebContents>>();
  private readonly removers: (() => void)[] = [];
  private disposed = false;

  public constructor(private readonly options: EventSubscriptionsOptions) {
    for (const name of [
      "app-update:state",
      "sync:state",
      "ai:delta",
      "ai:status",
      "external-agent:state",
    ] satisfies readonly EventName[]) {
      this.subscribers.set(name, new Set());
    }
  }

  /** 購読チャンネルを登録します。 */
  public register(ipcMain: IpcMain): void {
    this.disposed = false;
    for (const name of this.subscribers.keys()) {
      this.registerSubscription(ipcMain, `${name}:subscribe`, name, true);
      this.registerSubscription(ipcMain, `${name}:unsubscribe`, name, false);
    }
  }

  /** サービス側の状態通知を購読します。 */
  public bind<T>(
    name: EventName,
    schema: z.ZodType<T>,
    subscribe: ((listener: (value: T) => void) => () => void) | undefined,
  ): void {
    if (subscribe == null) {
      return;
    }
    const remove = subscribe((value) => this.send(name, schema, value));
    this.removers.push(remove);
  }

  /** 停止処理中のイベント送信を止めます。 */
  public stopSending(): void {
    this.disposed = true;
  }

  /** IPCとサービス側の購読を解除します。 */
  public dispose(): void {
    this.stopSending();
    for (const remove of this.removers.splice(0)) {
      remove();
    }
    for (const subscribers of this.subscribers.values()) {
      subscribers.clear();
    }
  }

  private registerSubscription(
    ipcMain: IpcMain,
    channel: string,
    name: EventName,
    subscribe: boolean,
  ): void {
    const validatedChannel = this.options.validateChannel(channel);
    const listener = (event: IpcMainEvent, payload: unknown): void => {
      try {
        this.options.validateSender(event);
        this.options.validateRequest(payload);
        const subscribers = this.subscribers.get(name);
        if (subscribers == null) {
          throw new Error("IPCイベントの購読先がありません。");
        }
        if (subscribe) {
          subscribers.add(event.sender);
        } else {
          subscribers.delete(event.sender);
        }
      } catch (error: unknown) {
        this.options.record(error, validatedChannel);
      }
    };
    ipcMain.on(validatedChannel, listener);
    this.removers.push(() => ipcMain.removeListener(validatedChannel, listener));
  }

  private send<T>(name: EventName, schema: z.ZodType<T>, value: T): void {
    if (this.disposed) {
      return;
    }
    try {
      const parsed = schema.parse(value);
      const subscribers = this.subscribers.get(name);
      if (subscribers == null) {
        throw new Error("IPCイベントの購読先がありません。");
      }
      for (const webContents of subscribers) {
        if (!webContents.isDestroyed()) {
          webContents.send(name, parsed);
        }
      }
    } catch (error: unknown) {
      this.options.record(error, name);
    }
  }
}
