import assert from "node:assert/strict";
import { test } from "node:test";
import { ExternalToolStatusEvidenceCollector } from "./status-evidence-collector";

void test("提出前の根拠参照では収集を終えず、終了時に同じ根拠を回収する", () => {
  const collector = new ExternalToolStatusEvidenceCollector();
  const signal = new AbortController().signal;
  collector.beginTurn("attempt-1", signal);
  collector.record(collector.captureAttempt(), {
    format: "json",
    value: { locator: "external:task-1", target_task_gid: "task-1", status: "completed" },
  });
  const expected = [{
    kind: "external_tool",
    locator: "external:task-1",
    target_task_gid: "task-1",
    status: "completed",
  }];
  assert.deepEqual(collector.snapshotTurn("attempt-1", signal), expected);
  assert.equal(collector.captureAttempt().kind, "active");
  collector.record(collector.captureAttempt(), {
    format: "json",
    value: { locator: "external:task-2", target_task_gid: "task-2", status: "cancelled" },
  });
  assert.deepEqual(collector.finishTurn("attempt-1", signal), [
    ...expected,
    {
      kind: "external_tool",
      locator: "external:task-2",
      target_task_gid: "task-2",
      status: "cancelled",
    },
  ]);
  assert.equal(collector.captureAttempt().kind, "inactive");
});
