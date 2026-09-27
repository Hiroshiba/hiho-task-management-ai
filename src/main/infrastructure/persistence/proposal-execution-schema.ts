export const proposalExecutionTablesSql = `
CREATE TABLE proposal_executions (
  execution_id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT,
  retry_of_execution_id TEXT,
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  origin TEXT NOT NULL CHECK (origin IN ('proposal', 'gui-edit')),
  plan_json TEXT NOT NULL,
  plan_fingerprint TEXT NOT NULL,
  context_json TEXT,
  context_fingerprint TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned', 'running', 'succeeded', 'failed', 'confirmation_required')),
  error_id TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((origin = 'proposal' AND proposal_id IS NOT NULL) OR (origin = 'gui-edit' AND proposal_id IS NULL)),
  CHECK ((origin = 'proposal' AND context_json IS NOT NULL AND context_fingerprint IS NOT NULL)
    OR (origin = 'gui-edit' AND context_json IS NULL AND context_fingerprint IS NULL)),
  CHECK ((state IN ('failed', 'confirmation_required') AND error_id IS NOT NULL)
    OR (state IN ('planned', 'running', 'succeeded') AND error_id IS NULL)),
  CHECK ((state = 'succeeded' AND result_json IS NOT NULL)
    OR (state <> 'succeeded' AND result_json IS NULL)),
  CHECK (retry_of_execution_id IS NULL OR retry_of_execution_id <> execution_id)
);
CREATE UNIQUE INDEX proposal_executions_active_proposal
  ON proposal_executions (proposal_id)
  WHERE proposal_id IS NOT NULL AND state IN ('planned', 'running');
CREATE TABLE proposal_execution_steps (
  execution_id TEXT NOT NULL REFERENCES proposal_executions(execution_id) ON DELETE RESTRICT,
  step_id TEXT NOT NULL,
  step_order INTEGER NOT NULL CHECK (step_order >= 0),
  kind TEXT NOT NULL,
  executor_version INTEGER NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned', 'running', 'succeeded', 'failed', 'confirmation_required')),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  receipt_json TEXT,
  error_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, step_id),
  UNIQUE (execution_id, step_order),
  CHECK ((state = 'planned' AND attempt = 0 AND receipt_json IS NULL AND error_id IS NULL)
    OR (state = 'running' AND attempt > 0 AND receipt_json IS NULL AND error_id IS NULL)
    OR (state = 'succeeded' AND attempt > 0 AND receipt_json IS NOT NULL AND error_id IS NULL)
    OR (state IN ('failed', 'confirmation_required') AND attempt > 0 AND receipt_json IS NULL AND error_id IS NOT NULL))
);
`;

export const proposalExecutionColumns = [
  { name: "execution_id", type: "TEXT", notnull: 1, pk: 1 },
  { name: "proposal_id", type: "TEXT", notnull: 0, pk: 0 },
  { name: "retry_of_execution_id", type: "TEXT", notnull: 0, pk: 0 },
  { name: "format_version", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "origin", type: "TEXT", notnull: 1, pk: 0 },
  { name: "plan_json", type: "TEXT", notnull: 1, pk: 0 },
  { name: "plan_fingerprint", type: "TEXT", notnull: 1, pk: 0 },
  { name: "context_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "context_fingerprint", type: "TEXT", notnull: 0, pk: 0 },
  { name: "state", type: "TEXT", notnull: 1, pk: 0 },
  { name: "error_id", type: "TEXT", notnull: 0, pk: 0 },
  { name: "result_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
  { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
] as const;

export const proposalExecutionStepColumns = [
  { name: "execution_id", type: "TEXT", notnull: 1, pk: 1 },
  { name: "step_id", type: "TEXT", notnull: 1, pk: 2 },
  { name: "step_order", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "kind", type: "TEXT", notnull: 1, pk: 0 },
  { name: "executor_version", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "payload_fingerprint", type: "TEXT", notnull: 1, pk: 0 },
  { name: "state", type: "TEXT", notnull: 1, pk: 0 },
  { name: "attempt", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "receipt_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "error_id", type: "TEXT", notnull: 0, pk: 0 },
  { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
] as const;
