import { z } from "zod";
import { externalAgentProtocolVersion } from "../../shared/external-agent";

export { externalAgentProtocolVersion };
export const externalAgentMaxRequestBytes = 1024 * 1024;
export const externalAgentMaxResponseBytes = 2_400_000;
export const externalAgentRequestTimeoutMilliseconds = 35_000;
export const externalAgentMaxConnections = 8;
export const externalAgentUnixSocketMaxBytes = 103;

const capabilitySchema = z.string().regex(/^[0-9a-f]{64}$/u);
const instanceIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const requestIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const endpointSchema = z.union([
  z.string().regex(/^\\\\\.\\pipe\\taskhub-agent-[0-9a-f]{32}$/u),
  z.string().refine((value) => {
    return /^\/(?:private\/)?tmp\/taskhub-agent-[0-9]+-[0-9a-f]{24}\/bridge\.sock$/u.test(value)
      && Buffer.byteLength(value, "utf8") <= externalAgentUnixSocketMaxBytes;
  }, "Unixソケットの接続先が不正です。"),
]);

export const externalAgentConfigSchema = z.object({
  enabled: z.boolean(),
}).strict();

export const externalAgentDescriptorSchema = z.object({
  version: z.literal(externalAgentProtocolVersion),
  endpoint: endpointSchema,
  capability: capabilitySchema,
  instanceId: instanceIdSchema,
}).strict();

export const externalAgentRequestEnvelopeSchema = z.object({
  version: z.literal(externalAgentProtocolVersion),
  endpoint: endpointSchema,
  instanceId: instanceIdSchema,
  capability: capabilitySchema,
  requestId: requestIdSchema,
  input: z.unknown(),
}).strict();

const externalAgentErrorSchema = z.object({
  code: z.enum([
    "invalid_request",
    "capability_invalid",
    "connection_limit",
    "broker_stopped",
    "execution_timeout",
    "response_too_large",
    "internal_error",
  ]),
  message: z.string().min(1).max(240),
}).strict();

export const externalAgentSuccessResponseSchema = z.object({
  version: z.literal(externalAgentProtocolVersion),
  requestId: requestIdSchema,
  ok: z.literal(true),
  output: z.unknown(),
}).strict();

export const externalAgentFailureResponseSchema = z.object({
  version: z.literal(externalAgentProtocolVersion),
  requestId: requestIdSchema,
  ok: z.literal(false),
  error: externalAgentErrorSchema,
}).strict();

export const externalAgentResponseSchema = z.discriminatedUnion("ok", [
  externalAgentSuccessResponseSchema,
  externalAgentFailureResponseSchema,
]);

export type ExternalAgentConfig = z.infer<typeof externalAgentConfigSchema>;
export type ExternalAgentDescriptor = z.infer<typeof externalAgentDescriptorSchema>;
export type ExternalAgentRequestEnvelope = z.infer<typeof externalAgentRequestEnvelopeSchema>;
export type ExternalAgentResponse = z.infer<typeof externalAgentResponseSchema>;
