import type { DurationUnit, ProposalOperation } from "./proposal-presentation";

export type CreateTaskOperation = Extract<ProposalOperation, { operation: "create_task" }>;
export type ProposalTarget = Extract<ProposalOperation, { operation: "update_title" }>["target"];
export type ProposalParentValue = Extract<ProposalOperation, { operation: "set_parent" }>["after"];
export type ProposalDueValue = Extract<ProposalOperation, { operation: "set_due" }>["after"];
export type ProposalDurationValue = Extract<ProposalOperation, { operation: "set_duration" }>["after"];
export type ProposalDependency = Extract<ProposalOperation, { operation: "set_dependencies" }>["after"][number];

export type TargetOption = {
  readonly key: string;
  readonly label: string;
};

export type DependencyDraft = {
  readonly id: number;
  targetKey: string;
  scope: ProposalDependency["scope"];
  source: string;
};

export type ObsidianDraft = {
  readonly id: number;
  vaultId: string;
  path: string;
  title: string;
  confidence: number | string;
};

export type FormState = {
  title: string;
  notes: string;
  notesSpecified: boolean;
  status: "not_started" | "in_progress";
  statusSpecified: boolean;
  importance: number;
  importanceSpecified: boolean;
  area: string;
  areaSpecified: boolean;
  dueKind: "due_on" | "due_at";
  dueValue: string;
  originalDueAt: string | undefined;
  dueSpecified: boolean;
  durationUnit: DurationUnit;
  durationValue: string;
  durationSpecified: boolean;
  parentKey: string;
  parentSpecified: boolean;
  parentWorkMode: Extract<ProposalOperation, { operation: "set_parent_work_mode" }>["after"];
  parentWorkModeSpecified: boolean;
  dependencies: DependencyDraft[];
  dependenciesSpecified: boolean;
  obsidianLinks: ObsidianDraft[];
  obsidianLinksSpecified: boolean;
  evidenceLocator: string;
  error: string;
};
