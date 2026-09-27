import { proposalExecutionTablesSql } from "./proposal-execution-schema";

export const storageSchemaVersion = 6;

export const storageLegacyTableNames = [
  "task_cache",
  "project_metadata_cache",
  "ranking_cache",
  "cleanup_items_cache",
  "sync_state",
  "device_settings",
  "vault_mappings",
  "application_journal",
  "diagnostic_log",
  "external_tool_definitions",
] as const;

export const storageTableNames = [
  ...storageLegacyTableNames,
  "proposal_executions",
  "proposal_execution_steps",
] as const;

export const applicationJournalTableSql = `
CREATE TABLE application_journal (
  proposal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  new_task_uuid TEXT,
  target_gid TEXT,
  target_temporary_ref TEXT,
  started_at TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (
    stage IN (
      'prepared',
      'started',
      'write_started',
      'task_created',
      'attributes_applied',
      'relations_applied',
      'read_back',
      'metadata_verified',
      'ranking_recalculated',
      'legacy_unresolved'
    )
  ),
  final_result TEXT CHECK (
    final_result IS NULL
    OR final_result IN ('applied', 'not_applied', 'unknown', 'failed')
  ),
  recovery_reason TEXT CHECK (
    recovery_reason IS NULL
    OR recovery_reason IN ('recovery_context_missing', 'journal_target_mismatch')
  ),
  group_id TEXT,
  group_order INTEGER CHECK (group_order IS NULL OR group_order >= 0),
  operation_order INTEGER CHECK (operation_order IS NULL OR operation_order >= 0),
  atomic INTEGER CHECK (atomic IS NULL OR atomic IN (0, 1)),
  project_gid TEXT,
  workspace_gid TEXT,
  section_gids_json TEXT,
  device_id TEXT,
  created_via TEXT,
  activity_date TEXT,
  temporary_ref_to_gid_json TEXT,
  baseline_source_json TEXT,
  operation_kind TEXT CHECK (
    operation_kind IS NULL
    OR operation_kind IN (
      'create_task',
      'update_title',
      'update_notes',
      'set_status',
      'set_importance',
      'set_due',
      'clear_due',
      'set_duration',
      'clear_duration',
      'set_area',
      'set_dependencies',
      'set_parent',
      'set_parent_work_mode',
      'link_obsidian',
      'unlink_obsidian',
      'complete',
      'withdraw'
    )
  ),
  operation_json TEXT,
  expected_before_json TEXT,
  expected_after_json TEXT,
  create_uuid TEXT,
  temporary_ref TEXT,
  PRIMARY KEY (proposal_id, operation_id),
  CHECK (
    (
      stage = 'legacy_unresolved'
      AND recovery_reason IS NOT NULL
    )
    OR (
      stage <> 'legacy_unresolved'
      AND recovery_reason IS NULL
    )
  ),
  CHECK (
    (
      new_task_uuid IS NOT NULL
      AND target_gid IS NULL
      AND target_temporary_ref IS NULL
    )
    OR (
      new_task_uuid IS NULL
      AND target_gid IS NOT NULL
      AND target_temporary_ref IS NULL
    )
    OR (
      new_task_uuid IS NULL
      AND target_gid IS NULL
      AND target_temporary_ref IS NOT NULL
    )
  ),
  CHECK (
    (
      operation_kind IS NULL
      AND group_id IS NULL
      AND group_order IS NULL
      AND operation_order IS NULL
      AND atomic IS NULL
      AND project_gid IS NULL
      AND workspace_gid IS NULL
      AND section_gids_json IS NULL
      AND device_id IS NULL
      AND created_via IS NULL
      AND activity_date IS NULL
      AND temporary_ref_to_gid_json IS NULL
      AND baseline_source_json IS NULL
      AND operation_json IS NULL
      AND expected_before_json IS NULL
      AND expected_after_json IS NULL
      AND create_uuid IS NULL
      AND temporary_ref IS NULL
      AND (
        (
          stage = 'legacy_unresolved'
          AND (final_result IS NULL OR final_result = 'unknown')
        )
        OR (
          final_result IS NOT NULL
          AND stage IN (
            'started',
            'task_created',
            'attributes_applied',
            'relations_applied',
            'read_back',
            'metadata_verified',
            'ranking_recalculated'
          )
        )
      )
    )
    OR (
      operation_kind IS NOT NULL
      AND group_id IS NOT NULL
      AND group_order IS NOT NULL
      AND operation_order IS NOT NULL
      AND atomic IS NOT NULL
      AND project_gid IS NOT NULL
      AND workspace_gid IS NOT NULL
      AND section_gids_json IS NOT NULL
      AND device_id IS NOT NULL
      AND created_via IS NOT NULL
      AND activity_date IS NOT NULL
      AND temporary_ref_to_gid_json IS NOT NULL
      AND baseline_source_json IS NOT NULL
      AND operation_json IS NOT NULL
      AND expected_before_json IS NOT NULL
      AND expected_after_json IS NOT NULL
      AND stage IN (
        'prepared',
        'write_started',
        'task_created',
        'attributes_applied',
        'relations_applied',
        'read_back',
        'metadata_verified',
        'ranking_recalculated'
      )
      AND (
        (
          operation_kind = 'create_task'
          AND new_task_uuid IS NOT NULL
          AND target_gid IS NULL
          AND target_temporary_ref IS NULL
          AND create_uuid IS NOT NULL
          AND temporary_ref IS NOT NULL
          AND create_uuid = new_task_uuid
        )
        OR (
          operation_kind <> 'create_task'
          AND new_task_uuid IS NULL
          AND (target_gid IS NOT NULL OR target_temporary_ref IS NOT NULL)
          AND NOT (target_gid IS NOT NULL AND target_temporary_ref IS NOT NULL)
          AND create_uuid IS NULL
          AND temporary_ref IS NULL
        )
      )
    )
  )
);
`;

export const storageSchemaSql = `
CREATE TABLE task_cache (
  gid TEXT PRIMARY KEY NOT NULL,
  asana_response_json TEXT NOT NULL,
  task_json TEXT NOT NULL,
  custom_external_data_json TEXT,
  cached_at TEXT NOT NULL
);
CREATE TABLE project_metadata_cache (
  project_gid TEXT PRIMARY KEY NOT NULL,
  project_json TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  cached_at TEXT NOT NULL
);
CREATE TABLE ranking_cache (
  cache_key INTEGER PRIMARY KEY NOT NULL CHECK (cache_key = 1),
  app_version TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  ranked_tasks_json TEXT NOT NULL,
  excluded_tasks_json TEXT NOT NULL
);
CREATE TABLE cleanup_items_cache (
  cache_key INTEGER PRIMARY KEY NOT NULL CHECK (cache_key = 1),
  cleanup_items_json TEXT NOT NULL
);
CREATE TABLE sync_state (
  project_gid TEXT PRIMARY KEY NOT NULL,
  events_token TEXT,
  last_successful_sync_at TEXT,
  last_full_sync_at TEXT
);
CREATE TABLE device_settings (
  settings_key INTEGER PRIMARY KEY NOT NULL CHECK (settings_key = 1),
  device_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  workspace_gid TEXT NOT NULL,
  project_gid TEXT NOT NULL,
  not_started_section_gid TEXT NOT NULL,
  in_progress_section_gid TEXT NOT NULL,
  completed_section_gid TEXT NOT NULL,
  withdrawn_section_gid TEXT NOT NULL
);
CREATE TABLE vault_mappings (
  vault_id TEXT PRIMARY KEY NOT NULL,
  absolute_path TEXT NOT NULL
);
${applicationJournalTableSql}
CREATE TABLE diagnostic_log (
  id INTEGER PRIMARY KEY NOT NULL,
  occurred_at TEXT NOT NULL,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  http_status INTEGER,
  asana_gid TEXT,
  proposal_id TEXT,
  operation_id TEXT,
  app_version TEXT,
  codex_version TEXT
);
CREATE TABLE external_tool_definitions (
  tool_id TEXT PRIMARY KEY NOT NULL,
  definition_json TEXT NOT NULL,
  credential_reference_names_json TEXT NOT NULL
);
${proposalExecutionTablesSql}
`;

export interface TableNameRow {
  readonly name: string;
}

export interface TableInfoRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

export interface TableRowCount {
  readonly row_count: number;
}

export interface ExpectedTableColumn {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly pk: number;
}

export const applicationJournalV3Columns: readonly ExpectedTableColumn[] = [
  { name: "proposal_id", type: "TEXT", notnull: 1, pk: 1 },
  { name: "operation_id", type: "TEXT", notnull: 1, pk: 2 },
  { name: "new_task_uuid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "target_gid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "started_at", type: "TEXT", notnull: 1, pk: 0 },
  { name: "stage", type: "TEXT", notnull: 1, pk: 0 },
  { name: "final_result", type: "TEXT", notnull: 0, pk: 0 },
];

export const applicationJournalV5Columns: readonly ExpectedTableColumn[] = [
  { name: "proposal_id", type: "TEXT", notnull: 1, pk: 1 },
  { name: "operation_id", type: "TEXT", notnull: 1, pk: 2 },
  { name: "new_task_uuid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "target_gid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "target_temporary_ref", type: "TEXT", notnull: 0, pk: 0 },
  { name: "started_at", type: "TEXT", notnull: 1, pk: 0 },
  { name: "stage", type: "TEXT", notnull: 1, pk: 0 },
  { name: "final_result", type: "TEXT", notnull: 0, pk: 0 },
  { name: "recovery_reason", type: "TEXT", notnull: 0, pk: 0 },
  { name: "group_id", type: "TEXT", notnull: 0, pk: 0 },
  { name: "group_order", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "operation_order", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "atomic", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "project_gid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "workspace_gid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "section_gids_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "device_id", type: "TEXT", notnull: 0, pk: 0 },
  { name: "created_via", type: "TEXT", notnull: 0, pk: 0 },
  { name: "activity_date", type: "TEXT", notnull: 0, pk: 0 },
  { name: "temporary_ref_to_gid_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "baseline_source_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "operation_kind", type: "TEXT", notnull: 0, pk: 0 },
  { name: "operation_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "expected_before_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "expected_after_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "create_uuid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "temporary_ref", type: "TEXT", notnull: 0, pk: 0 },
];

export const applicationJournalV4ColumnsWithoutRecoveryReason =
  applicationJournalV5Columns.filter((column) => column.name !== "recovery_reason");
