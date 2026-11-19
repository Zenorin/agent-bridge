import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { BridgeStore } from "../store.mjs";
import { runAgentTask, runAgentWorker } from "../runner-core.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeReviewConnector } from "./fixtures/fake-review-connector.mjs";
import { buildPrompt } from "../codex-runner.mjs";

const pass = {
  status: "done", verdict: "pass", summary: "fixture reviewed",
  criteria: [{ criterion: "fixture criterion", result: "pass", evidence: "fixture inspection" }],
  findings: [], boundary_review: { paths: "unchanged", exec: "unchanged", auth_permissions: "unchanged", notes: "" },
};
const reject = {
  ...pass, verdict: "reject",
  findings: [{ criterion: "fixture criterion", problem: "missing case", required_change: "handle empty value", files: ["fixture.mjs"] }],
};

function chainStore(t, overrides = {}) {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  store.sendTask(task({ chain: { review: true }, sandbox: "workspace-write",
    write_files: ["fixture.mjs"], model: "fixture-codex", effort: "high",
    handoff_ref: "original-plan.md", short_summary: "ORIGINAL PLAN",
    ...overrides }));
  return store;
}

function implement(store, overrides = {}) {
  const claim = store.claimTask("codex", "runner:fixture-implement");
  assert.ok(claim);
  store.setTurn(claim.message_id, "fixture-codex-session", "fixture-turn", claim);
  const reply = store.finishTask(claim.message_id, { claim, outcome: "result",
    reply: { status: "done", summary: "fixture implementation", acceptance: pass.criteria,
      changed_files: { observed: ["fixture.mjs"], reported: ["fixture.mjs"], outside_scope: [] }, ...overrides } });
  return { claim, reply };
}

async function review(store, reply = pass, calls = [], options = {}) {
  await runAgentWorker(store, { recipient: "claude-code", once: true,
    createConnector: () => fakeReviewConnector(reply, calls), ...options });
}

test("F1: sendTask rejects internal fields for plain tasks, chain roots and answers", (t) => {
  const store = chainStore(t);
  const claim = store.claimTask("codex", "runner:fixture");
  const question = store.finishTask("root", { claim, outcome: "question",
    reply: { status: "question", question: "which value?" } });
  for (const context of [{}, { chain: { review: true } }, { reply_to: question.message_id }]) {
    for (const field of ["pending_review", "findings", "implementation", "current"]) {
      for (const value of [{}, null, false]) {
        assert.throws(() => store.sendTask(task({ message_id: "injected", ...context, [field]: value })), /internal/i);
        assert.equal(store.get("injected"), null);
      }
    }
  }
});

test("F1: stored pending_review cannot change identity or root scope through requeue or stop", (t) => {
  const cases = [
    { message_id: "victim" },
    { root_id: "victim" },
    { cwd: path.dirname(process.cwd()) },
    { sandbox: "workspace-write" },
    { sandbox: "danger-full-access" },
    { write_files: ["../evil.txt"] },
    { write_files: ["fixture.mjs-extra"] },
    { write_files: [path.resolve("../evil.txt")] },
  ];
  for (const operation of ["requeue", "stop"]) {
    for (const change of cases) {
      const store = chainStore(t, change.sandbox === "workspace-write"
        ? { sandbox: "read-only", write_files: [] } : {});
      const { reply } = implement(store);
      store.sendTask(task({ message_id: "victim" }));
      const review = store.get("root:review:1");
      // Simulate a malformed packet persisted by an older store version.
      const pending = { ...review.body, ...change };
      store.db.prepare("UPDATE messages SET status = ?, body = ? WHERE message_id = ?")
        .run(operation === "requeue" ? "blocked" : "working",
          JSON.stringify({ ...review.body, pending_review: pending }), review.message_id);
      const before = store.db.prepare("SELECT * FROM messages ORDER BY message_id").all();
      assert.throws(() => operation === "requeue" ? store.requeue(review.message_id)
        : store.setStatus(review.message_id, "cancelled", "fixture stopped"), /chain.*(identity|scope|sandbox)/i);
      assert.deepEqual(store.db.prepare("SELECT * FROM messages ORDER BY message_id").all(), before);
      assert.equal(store.get(reply.message_id).body.current, true);
    }
  }
});

test("F1: failed root with stored out-of-scope pending_review cannot requeue", (t) => {
  const store = chainStore(t);
  implement(store, { status: "failed" });
  const root = store.get("root");
  const pending = { ...root.body, cwd: path.dirname(root.body.cwd),
    write_files: [path.resolve("../evil.txt")],
    parent: { message_id: "root" } };
  store.db.prepare("UPDATE messages SET body = ? WHERE message_id = 'root'")
    .run(JSON.stringify({ ...root.body, pending_review: pending }));
  const before = store.db.prepare("SELECT * FROM messages ORDER BY message_id").all();
  assert.throws(() => store.requeue("root"), /chain.*scope/i);
  assert.deepEqual(store.db.prepare("SELECT * FROM messages ORDER BY message_id").all(), before);
});

test("fixture chain 1: implementation, one review, one final, internal replies ACKed", async (t) => {
  const store = chainStore(t);
  const { claim, reply } = implement(store);
  assert.equal(store.get("root:review:1").body.sandbox, "read-only");
  assert.deepEqual(store.get("root:review:1").write_files, []);
  assert.ok(reply.delivered_at);
  assert.equal(store.get("root").scope_held, 1);
  assert.deepEqual(store.takeReplies("claude-code"), []);
  store.finishTask("root", { claim, outcome: "result", reply: { status: "done" } });
  await review(store);
  const reviewClaim = store.get("root:review:1");
  store.finishTask(reviewClaim.message_id, { claim: reviewClaim, outcome: "result", reply: pass });
  assert.deepEqual(store.takeReplies("claude-code").map(r => r.message_id), ["root:final"]);
  assert.equal(store.get("root").scope_held, 0);
  assert.equal(store.getChain("root").verdict, "pass");
});

test("fixture chain 2: findings-only rework resumes both sessions and preserves execution scope", async (t) => {
  const store = chainStore(t);
  const calls = [];
  implement(store);
  await review(store, reject, calls);
  const rework = store.get("root:rework:2").body;
  assert.deepEqual(rework.findings, reject.findings);
  assert.equal(rework.thread_id, "fixture-codex-session");
  assert.equal(rework.round, 2);
  assert.deepEqual(rework.write_files, ["fixture.mjs"]);
  assert.equal(rework.model, "fixture-codex");
  assert.equal(rework.handoff_ref, undefined);
  assert.equal(rework.short_summary, undefined);
  assert.deepEqual(rework.file_refs.map(r => r.path), ["fixture.mjs"]);
  const prompt = buildPrompt(rework);
  assert.match(prompt, /handle empty value/);
  assert.doesNotMatch(prompt, /ORIGINAL PLAN|original-plan.md/);
  implement(store);
  await review(store, pass, calls);
  assert.equal(calls.filter(c => c.method === "resume").length, 1);
  assert.equal(store.get("root:final").body.verdict, "pass");
});

test("fixture chain 3: exhaustion at max_rounds produces no third implementation or review", async (t) => {
  const store = chainStore(t);
  implement(store);
  await review(store, reject);
  implement(store);
  await review(store, reject);
  assert.equal(store.get("root:final").body.status, "exhausted");
  assert.deepEqual(store.get("root:final").body.findings, reject.findings);
  assert.equal(store.get("root:rework:3"), null);
  assert.equal(store.get("root:review:3"), null);
  assert.equal(store.get("root").scope_held, 0);
});

test("fixture chain 4: question holds scope; answer inherits chain and session", async (t) => {
  const store = chainStore(t);
  const claim = store.claimTask("codex", "runner:fixture");
  store.setTurn("root", "fixture-codex-session", "turn", claim);
  const question = store.finishTask("root", { claim, outcome: "question", reply: { status: "question", question: "which value?" } });
  assert.equal(store.get("root").status, "blocked");
  assert.equal(store.get("root").scope_held, 1);
  assert.deepEqual(store.takeReplies("claude-code").map(r => r.message_id), [question.message_id]);
  const answer = store.sendTask(task({ message_id: "answer", reply_to: question.message_id,
    thread_id: "fixture-codex-session", goal: "use zero" })).message;
  assert.equal(answer.root_id, "root");
  assert.equal(answer.round, 1);
  assert.deepEqual(answer.write_files, ["fixture.mjs"]);
  implement(store);
  await review(store);
  assert.ok(store.get("root:final"));
});

test("fixture chain 5: root cancellation stops queued and running descendants before unlocking", async (t) => {
  const store = chainStore(t);
  implement(store);
  store.requestCancel("root");
  assert.equal(store.get("root:review:1").status, "cancelled");
  assert.equal(store.get("root").scope_held, 0);
  assert.equal(store.get("root:final"), null);

  const active = chainStore(t, { message_id: "active" });
  implement(active);
  const claim = active.claimTask("claude-code", "runner:fixture");
  const calls = [];
  const connector = fakeReviewConnector("wait", calls);
  const originalClose = connector.close;
  connector.close = async () => {
    assert.equal(active.get("active:review:1").status, "working");
    assert.equal(active.get("active").scope_held, 1);
    await originalClose();
  };
  const running = runAgentTask(active, claim, connector, { cancelPollMs: 5 });
  active.requestCancel("active");
  assert.equal(active.get("active:review:1").status, "working");
  await running;
  assert.ok(calls.some(c => c.method === "interrupt"));
  assert.equal(active.get("active:review:1").status, "cancelled");
  assert.equal(active.get("active").scope_held, 0);
  assert.throws(() => active.finishTask(claim.message_id, { claim, outcome: "result", reply: pass }), /no longer working/);
  assert.equal(active.get("active:final"), null);
});

test("fixture chain 6: crashed reviewer blocks without auto retry; explicit requeue completes", async (t) => {
  const store = chainStore(t);
  implement(store);
  await review(store, "crash");
  assert.equal(store.get("root:review:1").status, "blocked");
  assert.equal(store.get("root").scope_held, 1);
  assert.equal(store.claimTask("claude-code", "runner:other"), null);
  store.requeue("root:review:1");
  const calls = [];
  await review(store, pass, calls);
  assert.equal(calls[0].method, "resume");
  assert.equal(store.get("root:review:1").attempt, 2);
  assert.ok(store.get("root:final"));
});

test("fixture chain 7: newer implementation waits for the old review to stop before reusing its ID", async (t) => {
  const store = chainStore(t);
  const first = implement(store);
  const oldReview = store.claimTask("claude-code", "runner:old-review");
  store.setStatus("root", "blocked", "fixture inspected before retry");
  store.requeue("root");
  assert.equal(store.claimTask('codex','runner:new-implementation'),null);
  store.setStatus(oldReview.message_id,'cancelled','fixture termination confirmed',oldReview);
  const second = implement(store);
  assert.throws(() => store.finishTask("root", { claim: first.claim, outcome: "result", reply: { status: "done" } }), /stale or invalid/);
  assert.throws(() => store.finishTask(oldReview.message_id, { claim: oldReview, outcome: "result", reply: pass }), /stale or invalid/);
  assert.equal(store.get("root:final"), null);
  const updated = store.get("root:review:1");
  assert.equal(updated.status, "queued");
  assert.equal(updated.body.parent.reply_id, second.reply.message_id);
  assert.equal(updated.attempt, oldReview.attempt);
  await review(store);
  assert.equal(store.get("root:review:1").attempt, 2);
  assert.ok(store.get("root:final"));
});

test("fixture chain 8: two database connections claim a review only once", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-chain-"));
  const store = new BridgeStore(path.join(dir, "test.db"));
  const other = new BridgeStore(path.join(dir, "test.db"));
  t.after(() => { store.close(); other.close(); rmSync(dir, { recursive: true, force: true }); });
  store.sendTask(task({ chain: { review: true } }));
  implement(store);
  assert.ok(store.claimTask("claude-code", "runner:one"));
  assert.equal(other.claimTask("claude-code", "runner:two"), null);
});

test("fixture chain 9: same task_id is not a chain; scope held throughout review and rework", async (t) => {
  const store = chainStore(t);
  implement(store);
  store.sendTask(task({ message_id: "unrelated", sandbox: "workspace-write", write_files: ["fixture.mjs"] }));
  assert.equal(store.claimTask("codex", "runner:other"), null);
  await review(store, reject);
  assert.equal(store.claimTask("codex", "runner:rework").message_id, "root:rework:2");
  store.requestCancel("root");
  assert.equal(store.get("root").scope_held, 1);
  const active = store.get("root:rework:2");
  store.setStatus(active.message_id, "cancelled", "fixture stopped", active);
  assert.equal(store.claimTask("codex", "runner:other").message_id, "unrelated");
});

test("fixture chain 10: missing or unreviewed boundary converts stored pass to reject", async (t) => {
  for (const boundary of [undefined, { ...pass.boundary_review, auth_permissions: "changed_unreviewed" }]) {
    const store = chainStore(t, { chain: { review: true, max_rounds: 1 } });
    implement(store);
    await review(store, { ...pass, boundary_review: boundary });
    const reply = store.get("root:review:1:attempt:1:result");
    assert.equal(reply.body.verdict, "reject");
    assert.ok(reply.body.findings.length);
    assert.equal(store.get("root:final").body.status, "exhausted");
  }
});

test("fixture same-root retry waits for the old writer to stop", async (t) => {
  const store = chainStore(t);
  implement(store);
  await review(store, reject);
  const oldWriter = store.claimTask("codex", "runner:old-writer");
  store.setStatus("root", "blocked", "fixture retry requested");
  store.requeue("root");
  assert.equal(store.claimTask("codex", "runner:new-writer"), null);
  store.setStatus(oldWriter.message_id, "cancelled", "fixture termination confirmed", oldWriter);
  assert.equal(store.claimTask("codex", "runner:new-writer").message_id, "root");
});

test("fixture rework cannot expand file references or accept forged chain membership", async (t) => {
  const store = chainStore(t);
  assert.throws(() => store.sendTask(task({ message_id: "forged", root_id: "root" })), /descendants/);
  implement(store);
  await review(store, { ...reject, findings: [{ ...reject.findings[0], files: ["fixture.mjs", "../outside.txt", "."] }] });
  assert.deepEqual(store.get("root:rework:2").body.file_refs.map(r => r.path), ["fixture.mjs"]);
});

test("fixture result and child creation roll back together on deterministic ID collision", (t) => {
  const store = chainStore(t);
  store.sendTask(task({ message_id: "root:review:1" }));
  const claim = store.claimTask("codex", "runner:fixture");
  assert.throws(() => store.finishTask("root", { claim, outcome: "result", reply: { status: "done" } }), /collision/);
  assert.equal(store.get("root").status, "working");
  assert.equal(store.get("root:attempt:1:result"), null);
});

test("fixture review timeout closes before blocking and retains the chain lock", async (t) => {
  const store = chainStore(t, { chain: { review: true, review_timeout_ms: 25 } });
  implement(store);
  const claim = store.claimTask("claude-code", "runner:fixture");
  const calls = [];
  const connector = fakeReviewConnector("wait", calls);
  const close = connector.close;
  connector.close = async () => {
    assert.equal(store.get(claim.message_id).status, "working");
    await close();
  };
  await runAgentTask(store, claim, connector, { heartbeatMs: 5 });
  assert.ok(calls.some(c => c.method === "close"));
  assert.equal(store.get(claim.message_id).status_reason, "review timeout");
  assert.equal(store.get("root").scope_held, 1);
  assert.notEqual(store.get(claim.message_id).heartbeat_at, claim.heartbeat_at);
  assert.equal(store.get("root:final"), null);
});

test("fixture stale heartbeat and queued superseded review never auto-run", async (t) => {
  const store = chainStore(t);
  implement(store);
  const claim = store.claimTask("claude-code", "runner:fixture");
  store.db.prepare("UPDATE messages SET heartbeat_at = ? WHERE message_id = ?").run("2000-01-01T00:00:00Z", claim.message_id);
  assert.equal(store.recoverStale(100), 1);
  assert.equal(store.claimTask("claude-code", "runner:other"), null);
  assert.equal(store.get("root").scope_held, 1);
  store.confirmStopped(claim.message_id,claim.attempt);
  store.requeue(claim.message_id);
  store.setStatus("root", "blocked", "fixture newer attempt");
  assert.equal(store.claimTask("claude-code", "runner:other"), null);
  assert.equal(store.get(claim.message_id).status_reason, "superseded");
  store.requeue("root");
  implement(store);
  await review(store);
  assert.ok(store.get("root:final"));
});

test("fixture malformed or failed review blocks without creating a rework or final", async (t) => {
  for (const output of [{ ...reject, findings: [] }, { ...pass, status: "failed" }, { status: "question" }]) {
    const store = chainStore(t);
    implement(store);
    await review(store, output);
    assert.equal(store.get("root:review:1").status, "blocked");
    assert.equal(store.get("root:rework:2"), null);
    assert.equal(store.get("root:final"), null);
    assert.equal(store.get("root").scope_held, 1);
  }
});

test("fixture abort before chain start releases scope without executing a model", async (t) => {
  const store = chainStore(t);
  const claim = store.claimTask("codex", "runner:fixture");
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  await runAgentTask(store, claim, fakeReviewConnector("wait", calls), { allowWrite: true, signal: controller.signal });
  assert.equal(store.get("root").status, "cancelled");
  assert.equal(store.get("root").scope_held, 0);
  assert.equal(calls.some(c => c.method === "execute"), false);
});

test("fixture failed termination never unlocks or starts a pending review", async (t) => {
  const store = chainStore(t);
  implement(store);
  const claim = store.claimTask("claude-code", "runner:fixture");
  const connector = fakeReviewConnector("wait");
  connector.close = async () => { throw new Error("fixture process still alive"); };
  const running = runAgentTask(store, claim, connector, { cancelPollMs: 5 });
  store.requestCancel("root");
  await running;
  assert.equal(store.get(claim.message_id).status, "blocked");
  assert.match(store.get(claim.message_id).status_reason, /cleanup failed/);
  assert.equal(store.get("root").scope_held, 1);
  store.requestCancel("root");
  assert.equal(store.get("root").scope_held, 1);
});

function task(overrides = {}) {
  return {
    message_id: "root",
    task_id: "AB01-fixture",
    sender: "claude-code",
    recipient: "codex",
    cwd: process.cwd(),
    goal: "fixture implementation",
    acceptance: ["fixture criterion"],
    ...overrides,
  };
}

test("fixture core executes and resumes through the connector without a model", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const calls = [];
  const createConnector = () => ({
    execute: async () => { calls.push("execute"); return "fixture"; },
    resume: async () => { calls.push("resume"); return "fixture"; },
    interrupt: async () => { calls.push("interrupt"); },
    parse: () => ({ outcome: "result", reply: { status: "done", summary: "fixture" } }),
    close: async () => { calls.push("close"); },
  });
  store.sendTask(task());
  store.sendTask(task({ message_id: "resume", thread_id: "fixture-thread" }));
  await runAgentWorker(store, { recipient: "codex", createConnector, once: true });
  assert.deepEqual(calls, ["execute", "close", "resume", "close"]);
  assert.equal(store.get("root").status, "ready");
  assert.equal(store.get("resume").status, "ready");
});

test("fixture core waits for interruption before marking a running task cancelled", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  store.sendTask(task());
  const claim = store.claimTask("codex", "runner:fixture");
  let finish;
  let closed = false;
  const connector = {
    execute: () => new Promise(resolve => { finish = resolve; }),
    resume: () => { throw new Error("unexpected resume"); },
    interrupt: async () => {
      assert.equal(store.get("root").status, "working");
      await sleep(15);
      finish({ interrupted: true });
    },
    parse: () => ({ status: "cancelled", reason: "fixture interruption confirmed" }),
    close: async () => { closed = true; },
  };
  const running = runAgentTask(store, claim, connector, { heartbeatMs: 5, cancelPollMs: 5 });
  await sleep(10);
  store.requestCancel("root");
  await running;
  assert.equal(closed, true);
  assert.equal(store.get("root").status, "cancelled");
});

