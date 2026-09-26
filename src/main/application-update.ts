import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppUpdater } from "electron-updater";
import type { AppUpdaterEvents } from "electron-updater/out/AppUpdater.js";
import { parse } from "yaml";
import { z } from "zod";
import {
  ipcAppUpdateStateSchema,
  type IpcAppUpdateState,
} from "../shared/ipc";
import {
  captureSecurePersistentFile,
  normalizeSecurePersistentFilePath,
  readSecurePersistentTextFileWithByteLimit,
  removeSecurePersistentFile,
  writeSecurePersistentTextFileAtomically,
} from "./local-storage-path";

const latestReleaseAssetsUrl =
  "https://github.com/Hiroshiba/hiho-task-management-ai/releases/latest/download/";
const taggedReleaseAssetsUrl =
  "https://github.com/Hiroshiba/hiho-task-management-ai/releases/download/";
const publisherNameSchema = z.object({
  publisherName: z.union([
    z.string().trim().min(1),
    z.array(z.string().trim().min(1)).min(1),
  ]),
}).passthrough();
const updateProviderSchema = z.object({
  provider: z.string(),
}).passthrough();
const genericUpdateProviderSchema = z.object({
  provider: z.literal("generic"),
  url: z.url(),
}).passthrough();
const stableVersionSchema = z.string().max(64).regex(/^\d+\.\d+\.\d+$/);
const stableVersionPartsSchema = z.tuple([z.coerce.bigint(), z.coerce.bigint(), z.coerce.bigint()]);
const applicationUpdateAttemptSchema = z.object({
  targetVersion: stableVersionSchema,
  status: z.enum(["pending", "failed"]),
}).strict();

type ApplicationUpdateAttempt = z.infer<typeof applicationUpdateAttemptSchema>;

function hasReachedVersion(currentVersion: string, targetVersion: string): boolean {
  const current = stableVersionPartsSchema.parse(stableVersionSchema.parse(currentVersion).split("."));
  const target = stableVersionPartsSchema.parse(stableVersionSchema.parse(targetVersion).split("."));
  if (current[0] !== target[0]) {
    return current[0] > target[0];
  }
  if (current[1] !== target[1]) {
    return current[1] > target[1];
  }
  return current[2] >= target[2];
}

/** アプリ本体の更新試行を安全なファイルへ保存します。 */
class ApplicationUpdateAttemptStore {
  private readonly filePath: string;

  public constructor(userDataPath: string) {
    this.filePath = normalizeSecurePersistentFilePath(join(userDataPath, "application-update-attempt.json"));
    captureSecurePersistentFile(this.filePath, "アプリ本体の更新試行");
  }

  /** 保存済みの更新試行を読み出します。 */
  public load(): ApplicationUpdateAttempt | undefined {
    const serialized = readSecurePersistentTextFileWithByteLimit(
      this.filePath,
      "アプリ本体の更新試行",
      1_024,
    );
    if (serialized == null) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(serialized);
    return applicationUpdateAttemptSchema.parse(parsed);
  }

  /** 更新試行を原子的に保存します。 */
  public save(attempt: ApplicationUpdateAttempt): void {
    writeSecurePersistentTextFileAtomically(
      this.filePath,
      JSON.stringify(applicationUpdateAttemptSchema.parse(attempt)),
      "アプリ本体の更新試行",
    );
  }

  /** 保存済みの更新試行を削除します。 */
  public clear(): void {
    removeSecurePersistentFile(this.filePath, "アプリ本体の更新試行");
  }
}

type ApplicationUpdater = Pick<
  AppUpdater,
  | "autoDownload"
  | "autoInstallOnAppQuit"
  | "autoRunAppAfterInstall"
  | "disableWebInstaller"
  | "previousBlockmapBaseUrlOverride"
  | "setFeedURL"
  | "checkForUpdates"
  | "quitAndInstall"
> & {
  on<Event extends keyof AppUpdaterEvents>(
    event: Event,
    listener: AppUpdaterEvents[Event],
  ): void;
};

/** アプリ本体の更新候補となる実行環境か判定します。 */
export function isApplicationUpdateCandidate(
  isPackaged: boolean,
  platform: NodeJS.Platform,
  architecture: string,
  version: string,
  resourcesPath: string,
): boolean {
  return isPackaged
    && (platform === "darwin" || platform === "win32")
    && architecture === "x64"
    && /^\d+\.\d+\.\d+$/.test(version)
    && existsSync(join(resourcesPath, "app-update.yml"));
}

/** 同梱された更新先が現在版の通常Releaseを指すか確認します。 */
export function hasTaggedReleaseUpdateProvider(
  currentVersion: string,
  resourcesPath: string,
): boolean {
  const configuration: unknown = parse(readFileSync(join(resourcesPath, "app-update.yml"), "utf8"));
  const provider = updateProviderSchema.parse(configuration);
  if (provider.provider !== "generic") {
    return false;
  }
  const genericProvider = genericUpdateProviderSchema.parse(configuration);
  const expectedUrl = `${taggedReleaseAssetsUrl}v${currentVersion}`;
  const configuredUrl = new URL(genericProvider.url).href;
  if (configuredUrl !== expectedUrl && configuredUrl !== `${expectedUrl}/`) {
    throw new Error("更新設定の公開先が現在版の通常Releaseと一致しません。");
  }
  return true;
}

/** Windows更新に必要な署名者名が配布設定にあることを確認します。 */
export function assertWindowsUpdatePublisherName(
  platform: NodeJS.Platform,
  resourcesPath: string,
): void {
  if (platform !== "win32") {
    return;
  }
  const configuration: unknown = parse(readFileSync(join(resourcesPath, "app-update.yml"), "utf8"));
  const result = publisherNameSchema.safeParse(configuration);
  if (!result.success) {
    throw new Error("Windows更新に必要な署名者名が配布設定にありません。", {
      cause: result.error,
    });
  }
}

/** アプリ本体の更新を監視し、画面に公開する状態を保持します。 */
export class ApplicationUpdateService {
  private state: IpcAppUpdateState;
  private restoredInstallFailure: IpcAppUpdateState | undefined;
  private readonly attemptStore: ApplicationUpdateAttemptStore;
  private readonly listeners = new Set<(state: IpcAppUpdateState) => void>();
  private started = false;
  private installing = false;
  private attemptedVersion: string | undefined;
  private quitAfterUpdateFailure: (() => void) | undefined;

  public constructor(
    private readonly updater: ApplicationUpdater,
    private readonly currentVersion: string,
    private readonly candidate: boolean,
    private readonly platform: NodeJS.Platform,
    private readonly resourcesPath: string,
    userDataPath: string,
    private readonly reportError: (error: unknown) => void,
  ) {
    this.state = candidate ? { kind: "idle" } : { kind: "unavailable" };
    this.attemptStore = new ApplicationUpdateAttemptStore(userDataPath);
    this.restoreInstallAttempt();
  }

  /** 現在の更新状態を返します。 */
  public getState(): IpcAppUpdateState {
    return this.restoredInstallFailure ?? this.state;
  }

  /** 更新状態の変化を購読します。 */
  public onState(listener: (state: IpcAppUpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 業務停止後に取得済みの更新を適用して終了します。 */
  public installOnQuit(quitWithoutUpdate: () => void): boolean {
    if (this.installing) {
      return true;
    }
    if (this.state.kind !== "ready") {
      return false;
    }
    this.installing = true;
    this.quitAfterUpdateFailure = quitWithoutUpdate;
    try {
      this.attemptStore.save({ targetVersion: this.state.version, status: "pending" });
      this.attemptedVersion = this.state.version;
      this.updater.quitAndInstall(true, false);
    } catch (error) {
      this.fail(error);
    }
    return true;
  }

  /** 対象の配布版で一度だけ更新を確認します。 */
  public start(): void {
    if (this.started || !this.candidate) {
      return;
    }
    this.started = true;
    try {
      if (!hasTaggedReleaseUpdateProvider(this.currentVersion, this.resourcesPath)) {
        this.publish({ kind: "unavailable" });
        return;
      }
    } catch (error) {
      this.publish({ kind: "failed", phase: "release_source" });
      this.reportError(error);
      return;
    }
    try {
      assertWindowsUpdatePublisherName(this.platform, this.resourcesPath);
    } catch (error) {
      this.publish({ kind: "failed", phase: "publisher_name" });
      this.reportError(error);
      return;
    }
    try {
      this.updater.autoDownload = true;
      this.updater.autoInstallOnAppQuit = false;
      this.updater.autoRunAppAfterInstall = false;
      this.updater.disableWebInstaller = true;
      this.updater.previousBlockmapBaseUrlOverride =
        `${taggedReleaseAssetsUrl}v${this.currentVersion}/`;
      this.updater.on("checking-for-update", () => {
        this.publish({ kind: "checking" });
      });
      this.updater.on("update-not-available", () => {
        this.publish({ kind: "current" });
      });
      this.updater.on("update-available", (info) => {
        this.publish({ kind: "downloading", version: info.version, percent: 0 });
      });
      this.updater.on("download-progress", (progress) => {
        const current = this.state;
        if (current.kind !== "downloading") {
          throw new Error("ダウンロード中ではない状態で更新の進捗を受け取りました。");
        }
        this.publish({
          kind: "downloading",
          version: current.version,
          percent: progress.percent,
        });
      });
      this.updater.on("error", (error) => {
        this.fail(error);
      });
      this.updater.setFeedURL(latestReleaseAssetsUrl);
      void this.checkForUpdates();
    } catch (error) {
      this.fail(error);
    }
  }

  private async checkForUpdates(): Promise<void> {
    try {
      const result = await this.updater.checkForUpdates();
      if (result == null) {
        throw new Error("更新対象版で更新機能が無効です。");
      }
      if (result.downloadPromise != null) {
        await result.downloadPromise;
        if (this.state.kind !== "failed") {
          this.publish({ kind: "ready", version: result.updateInfo.version });
        }
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private publish(state: IpcAppUpdateState): void {
    this.state = ipcAppUpdateStateSchema.parse(state);
    if (this.state.kind === "ready") {
      this.restoredInstallFailure = undefined;
    }
    for (const listener of this.listeners) {
      listener(this.getState());
    }
  }

  private restoreInstallAttempt(): void {
    const attempt = this.attemptStore.load();
    if (attempt == null) {
      return;
    }
    if (!stableVersionSchema.safeParse(this.currentVersion).success) {
      return;
    }
    if (hasReachedVersion(this.currentVersion, attempt.targetVersion)) {
      this.attemptStore.clear();
      return;
    }
    this.restoredInstallFailure = { kind: "failed", phase: "install" };
    if (attempt.status === "pending") {
      this.reportError(new Error(`更新版 ${attempt.targetVersion} を適用できず、実行版は ${this.currentVersion} のままです。`));
      this.attemptStore.save({ ...attempt, status: "failed" });
    }
  }

  private fail(error: unknown): void {
    if (this.state.kind === "failed") {
      return;
    }
    let phase: "install" | "download" | "check" = "check";
    if (this.installing) {
      phase = "install";
    } else if (this.state.kind === "downloading" || this.state.kind === "ready") {
      phase = "download";
    }
    this.publish({ kind: "failed", phase });
    this.reportError(error);
    if (this.attemptedVersion != null) {
      try {
        this.attemptStore.save({ targetVersion: this.attemptedVersion, status: "failed" });
      } catch (saveError) {
        this.reportError(saveError);
      }
    }
    const quitAfterUpdateFailure = this.quitAfterUpdateFailure;
    if (quitAfterUpdateFailure != null) {
      this.quitAfterUpdateFailure = undefined;
      quitAfterUpdateFailure();
    }
  }
}
