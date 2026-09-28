import { z } from "zod";
import {
  completedSchema,
  emptyRequestSchema,
  responseSchema,
  subscriptionEventSchema,
  subscriptionRequestSchema,
  type IpcResult,
  type IpcSubscription,
} from "./common";

export const systemChannels = {
  getVersion: "system:get-version",
  waitForStartup: "system:wait-for-startup",
  getUpdateState: "system:get-update-state",
  subscribeUpdateState: "system:update-state:subscribe",
  unsubscribeUpdateState: "system:update-state:unsubscribe",
  updateState: "system:update-state",
} satisfies Record<string, string>;

export const systemUpdateStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable") }).strict(),
  z.object({ kind: z.literal("idle") }).strict(),
  z.object({ kind: z.literal("checking") }).strict(),
  z.object({ kind: z.literal("current") }).strict(),
  z
    .object({
      kind: z.literal("downloading"),
      version: z.string().min(1).max(64),
      percent: z.number().min(0).max(100),
    })
    .strict(),
  z.object({ kind: z.literal("ready"), version: z.string().min(1).max(64) }).strict(),
  z
    .object({
      kind: z.literal("failed"),
      phase: z.enum(["release_source", "publisher_name", "check", "download", "install"]),
    })
    .strict(),
]);

export const systemContracts = {
  getVersion: {
    channel: systemChannels.getVersion,
    request: emptyRequestSchema,
    response: responseSchema(z.string().min(1).max(64)),
  },
  waitForStartup: {
    channel: systemChannels.waitForStartup,
    request: emptyRequestSchema,
    response: responseSchema(completedSchema),
  },
  getUpdateState: {
    channel: systemChannels.getUpdateState,
    request: emptyRequestSchema,
    response: responseSchema(systemUpdateStateSchema),
  },
  subscribeUpdateState: {
    channel: systemChannels.subscribeUpdateState,
    request: subscriptionRequestSchema,
  },
  unsubscribeUpdateState: {
    channel: systemChannels.unsubscribeUpdateState,
    request: subscriptionRequestSchema,
  },
  updateState: {
    channel: systemChannels.updateState,
    event: subscriptionEventSchema(systemUpdateStateSchema),
  },
};

export type SystemApi = {
  readonly getVersion: () => Promise<IpcResult<string>>;
  readonly waitForStartup: () => Promise<IpcResult<z.infer<typeof completedSchema>>>;
  readonly getUpdateState: () => Promise<IpcResult<z.infer<typeof systemUpdateStateSchema>>>;
  readonly onUpdateState: IpcSubscription<z.infer<typeof systemUpdateStateSchema>>;
};

export type SystemUpdateState = z.infer<typeof systemUpdateStateSchema>;
