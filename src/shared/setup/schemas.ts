import { z } from "zod";
import {
  createUtf8ByteLimitedStringSchema,
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
} from "../domain";
import { createSetupSchemas } from "../ipc-contracts/setup-schemas";
import { deviceSectionGidsSchema, vaultMappingSchema } from "../storage";

const schemas = createSetupSchemas({
  createUtf8ByteLimitedStringSchema,
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
  deviceSectionGidsSchema,
  vaultMappingSchema,
});

export const setupSchemas = schemas;

export const {
  asanaClientSecretSchema,
  configuredTagGidsSchema,
  setupAsanaAuthorizationBeginInputSchema,
  setupAsanaAuthorizationCancelInputSchema,
  setupAsanaAuthorizationCompleteInputSchema,
  setupCodexAvailabilitySchema,
  setupCodexAuthenticationStateSchema,
  codexUnavailableReasonSchema,
  setupDiscordExternalToolConfigurationInputSchema,
  setupExternalToolChoiceInputSchema,
  setupExternalToolSelectionSchema,
  setupExternalToolUnavailableReasonSchema,
  setupFullSyncInputSchema,
  setupProjectSchema,
  setupProjectSelectionInputSchema,
  setupResourceIssueSchema,
  setupSafeNameSchema,
  setupStateSchema,
  setupVaultChoiceInputSchema,
  setupWorkspaceSchema,
  setupWorkspaceSelectionInputSchema,
} = schemas;

export type SetupState = z.infer<typeof setupStateSchema>;
export type SetupCodexAvailability = z.infer<typeof setupCodexAvailabilitySchema>;
export type SetupCodexAuthenticationState = z.infer<typeof setupCodexAuthenticationStateSchema>;
export type SetupFullSyncInput = z.infer<typeof setupFullSyncInputSchema>;
export type SetupCodexUnavailableReason = z.infer<typeof codexUnavailableReasonSchema>;
export type SetupAsanaAuthorizationBeginInput = z.infer<typeof setupAsanaAuthorizationBeginInputSchema>;
export type SetupAsanaAuthorizationCompleteInput = z.infer<typeof setupAsanaAuthorizationCompleteInputSchema>;
export type SetupAsanaAuthorizationCancelInput = z.infer<typeof setupAsanaAuthorizationCancelInputSchema>;
export type SetupDiscordExternalToolConfigurationInput = z.infer<typeof setupDiscordExternalToolConfigurationInputSchema>;
export type SetupExternalToolChoiceInput = z.infer<typeof setupExternalToolChoiceInputSchema>;
export type SetupExternalToolSelection = z.infer<typeof setupExternalToolSelectionSchema>;
export type SetupExternalToolUnavailableReason = z.infer<typeof setupExternalToolUnavailableReasonSchema>;
export type SetupProject = z.infer<typeof setupProjectSchema>;
export type SetupProjectSelectionInput = z.infer<typeof setupProjectSelectionInputSchema>;
export type SetupResourceIssue = z.infer<typeof setupResourceIssueSchema>;
export type SetupVaultChoiceInput = z.infer<typeof setupVaultChoiceInputSchema>;
export type SetupWorkspace = z.infer<typeof setupWorkspaceSchema>;
export type SetupWorkspaceSelectionInput = z.infer<typeof setupWorkspaceSelectionInputSchema>;
