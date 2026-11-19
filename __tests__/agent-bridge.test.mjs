import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPrompt, runCodexTask, runCodexWorker } from "../codex-runner.mjs";
import { BridgeStore, scopesOverlap, staleInputs, hashFile } from "../store.mjs";
import { fixtureLog } from "./fixtures/fixture-log.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.mjs");

test('review 프로필은 프롬프트·회신을 줄이면서 전체 결과와 실제 훅 이벤트를 저장한다',async(t)=>{
 const {store,runner,requests,task}=setup(t);
 store.sendTask(task({profile:'review',short_summary:'DO_NOT_FORWARD',handoff_ref:'OMITTED_HANDOFF'}));
 await runCodexWorker(store,{once:true,...runner()});
 const prompt=requests().find(r=>r.method==='turn/start').params.input[0].text;
 assert.doesNotMatch(prompt,/DO_NOT_FORWARD|OMITTED_HANDOFF/);
 assert.match(prompt,/a\.txt/);
 const receipt=store.listRuntime('msg-1')[0];
 assert.equal(receipt.config_verified,true);
 assert.equal(receipt.overrides['plugins."extra@test".enabled'],false);
 assert.equal(receipt.protected_hooks[0].key,'writer');
 assert.equal(receipt.hook_events[0].event,'userPromptSubmit');
 const [reply]=store.takeReplies('claude-code');
 assert.ok(reply.body.turn_id);
 assert.equal(reply.body.delivery.turn_id,undefined);
 assert.equal(reply.body.delivery.summary,'요약');
 assert.ok(reply.body.delivery.acceptance.length);
});

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-bridge-"));
  const dbPath = path.join(dir, "bridge.db");
  const log = fixtureLog(t, "requests.jsonl");
  writeFileSync(path.join(dir, "a.txt"), "원본");
  const store = new BridgeStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const runner = (env = {}, extra = {}) => ({
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_LOG: log, ...env },
    heartbeatMs: 50,
    cancelPollMs: 20,
    ...extra,
  });
  const requests = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const task = (overrides = {}) => ({
    message_id: "msg-1",
    task_id: "T1",
    sender: "claude-code",
    recipient: "codex",
    goal: "로그인 오류 원인 확인",
    acceptance: ["테스트 통과"],
    cwd: dir,
    file_refs: [{ path: "a.txt", lines: "1-3" }],
    ...overrides,
  });
  return { dir, dbPath, store, runner, requests, task };
}

test("같은 message_id를 다시 보내도 작업은 한 번만 실행된다", async (t) => {
  const { store, runner, requests, task } = setup(t);
  assert.equal(store.sendTask(task()).duplicate, false);
  const again = store.sendTask(task());
  assert.equal(again.duplicate, true);
  assert.equal(again.sameContent, true);
  assert.equal(store.sendTask(task({ goal: "다른 목표" })).sameContent, false);

  await runCodexWorker(store, { once: true, ...runner() });
  await runCodexWorker(store, { once: true, ...runner() });

  assert.equal(requests().filter((r) => r.method === "turn/start").length, 1);
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.get("msg-1").status, "ready");
});

test("결과는 보낸 쪽에 구조화된 형태로 돌아오고 모델·추론 강도·사용량이 기록된다", async (t) => {
  const { store, runner, requests, task } = setup(t);
  store.sendTask(task({ model: "gpt-test", effort: "low" }));
  await runCodexWorker(store, { once: true, ...runner() });

  const turnStart = requests().find((r) => r.method === "turn/start").params;
  assert.equal(turnStart.model, "gpt-test");
  assert.equal(turnStart.effort, "low");
  assert.ok(turnStart.outputSchema);
  assert.match(turnStart.input[0].text, /a\.txt \(줄 1-3\)/);
  assert.equal(requests().find((r) => r.method === "thread/start").params.sandbox, "read-only");

  const [reply] = store.takeReplies("claude-code");
  assert.equal(reply.kind, "result");
  assert.equal(reply.reply_to, "msg-1");
  assert.equal(reply.body.summary, "요약");
  assert.equal(reply.body.acceptance[0].result, "pass");
  assert.equal(reply.usage.turn.inputTokens, 1000);
  assert.equal(store.takeReplies("claude-code")[0].message_id, reply.message_id, "ACK 전에는 재전달한다");
  store.ackReplies("claude-code", [reply.message_id]);
  assert.deepEqual(store.takeReplies("claude-code"), [], "ACK한 회신은 다시 오지 않는다");
});

test("질문은 blocked로 멈추고, 같은 대화를 이어 쓴 후속 작업의 사용량은 차이로 계산된다", async (t) => {
  const { store, runner, requests, task } = setup(t);
  store.sendTask(task());
  await runCodexWorker(store, { once: true, ...runner({ FAKE_MODE: "question" }) });
  const asked = store.get("msg-1");
  assert.equal(asked.status, "blocked");
  assert.equal(asked.status_reason, "question");
  const [question] = store.takeReplies("claude-code");
  assert.equal(question.kind, "question");
  assert.equal(question.body.question, "어느 파일을 기준으로 할까요?");

  store.sendTask(task({ message_id: "msg-2", reply_to: question.message_id, goal: "a.txt 기준", thread_id: question.body.thread_id }));
  await runCodexWorker(store, { once: true, ...runner({ FAKE_TOTAL_BASE: "1000" }) });
  assert.ok(requests().some((r) => r.method === "thread/resume" && r.params.threadId === "thr-new"));
  assert.equal(store.get("msg-2").status, "ready");
  assert.equal(store.get("msg-2").usage.turn.inputTokens, 1000);
});

test("수정 범위가 겹치는 작업은 앞 작업이 끝날 때까지 맡지 않는다", async (t) => {
  const { store, task } = setup(t);
  const write = { sandbox: "workspace-write" };
  store.sendTask(task({ message_id: "A", write_files: ["src"], ...write }));
  store.sendTask(task({ message_id: "B", write_files: ["src/auth.ts"], ...write }));
  store.sendTask(task({ message_id: "C", write_files: ["docs/x.md"], ...write }));

  assert.equal(store.claimTask("codex", "manual:codex").message_id, "A");
  assert.equal(store.claimTask("codex", "manual:codex").message_id, "C");
  assert.equal(store.claimTask("codex", "manual:codex"), null);
  assert.match(store.get("B").status_reason, /overlap A/);

  store.finishTask("A", { claim: store.get("A"), outcome: "result", reply: { status: "done" } });
  assert.equal(store.claimTask("codex", "manual:codex").message_id, "B");
  assert.equal(scopesOverlap(["src/a.js"], ["src/ab.js"]), false);
});

test("재시작 후 대기 작업은 남고, 중단된 작업은 자동 재실행되지 않는다", async (t) => {
  const { store, dbPath, runner, requests, task } = setup(t);
  store.sendTask(task({ message_id: "running" }));
  store.sendTask(task({ message_id: "waiting", repeat: true }));
  store.claimTask("codex", "runner:codex:old");
  store.db.prepare("UPDATE messages SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE message_id = 'running'").run();
  store.close();

  const reopened = new BridgeStore(dbPath);
  try {
    assert.equal(reopened.get("waiting").status, "queued");
    await runCodexWorker(reopened, { once: true, ...runner() });

    assert.equal(reopened.get("running").status, "blocked");
    assert.match(reopened.get("running").status_reason, /check changed files/);
    assert.equal(reopened.get("waiting").status, "ready");
    assert.equal(requests().filter((r) => r.method === "turn/start").length, 1);
    assert.throws(() => reopened.requeue("running"), /cleanup is unconfirmed/);
    reopened.confirmStopped('running',reopened.get('running').attempt);
    assert.equal(reopened.requeue("running").status, "queued");
  } finally {
    reopened.close(); // before setup's cleanup removes the folder
  }
});

test("입력 파일이 바뀌면 이전 결과는 오래된 결과로 표시된다", async (t) => {
  const { store, dir, runner, task } = setup(t);
  store.sendTask(task());
  await runCodexWorker(store, { once: true, ...runner() });
  const [reply] = store.takeReplies("claude-code");
  assert.deepEqual(staleInputs(reply), []);
  writeFileSync(path.join(dir, "a.txt"), "수정됨");
  assert.deepEqual(staleInputs(reply), ["a.txt"]);
});

test("대기 작업 취소는 즉시, 진행 중 취소는 중단이 확인된 뒤 cancelled가 된다", async (t) => {
  const { store, runner, requests, task } = setup(t);
  store.sendTask(task({ message_id: "queued-one" }));
  assert.equal(store.requestCancel("queued-one"), "cancelled");

  store.sendTask(task({ message_id: "slow-one" }));
  const claimed = store.claimTask("codex", "runner:codex:test");
  const run = runCodexTask(store, claimed, runner({ FAKE_MODE: "slow" }));
  while (!store.get("slow-one").turn_id) await sleep(10);
  assert.equal(store.requestCancel("slow-one"), "requested");
  assert.equal(store.get("slow-one").status, "working", "중단 확인 전에는 취소 완료가 아니다");
  await run;

  assert.equal(store.get("slow-one").status, "cancelled");
  assert.ok(requests().some((r) => r.method === "turn/interrupt"));
  assert.equal(store.get("queued-one").status, "cancelled");
});

test("쓰기 작업은 --allow-write 실행기에서만 돌고, 실제 변경과 범위 밖 보고를 구분한다", async (t) => {
  const { store, dir, runner, requests, task } = setup(t);
  store.sendTask(task({ sandbox: "workspace-write", write_files: ["a.txt"] }));
  await runCodexWorker(store, { once: true, ...runner() });
  assert.equal(store.get("msg-1").status, "blocked");
  assert.equal(requests().length, 0, "권한이 없으면 Codex를 띄우지 않는다");

  store.requeue("msg-1");
  const env = { FAKE_WRITE: path.join(dir, "a.txt"), FAKE_REPORT: "other.txt" };
  await runCodexWorker(store, { once: true, allowWrite: true, ...runner(env) });
  const [reply] = store.takeReplies("claude-code");
  assert.deepEqual(reply.body.changed_files.observed, ["a.txt"]);
  assert.deepEqual(reply.body.changed_files.outside_scope, ["other.txt"]);
});

test("실행 오류와 형식 밖 답변은 결과를 꾸며내지 않는다", async (t) => {
  const { store, runner, task } = setup(t);
  // A crash with no work done is retried by itself (recovery.test.mjs); here it must stop as reported.
  store.sendTask(task({ message_id: "crash", recovery: false }));
  await runCodexWorker(store, { once: true, ...runner({ FAKE_MODE: "crash" }) });
  assert.equal(store.get("crash").status, "blocked");
  assert.match(store.get("crash").status_reason, /runner error: app-server exited/);

  store.sendTask(task({ message_id: "failed-turn" }));
  await runCodexWorker(store, { once: true, ...runner({ FAKE_MODE: "failed" }) });
  assert.match(store.get("failed-turn").status_reason, /turn failed: boom/);

  store.sendTask(task({ message_id: "plain" }));
  await runCodexWorker(store, { once: true, ...runner({ FAKE_MODE: "plain" }) });
  const [reply] = store.takeReplies("claude-code");
  assert.equal(reply.body.final_text, "그냥 문장으로 답함");
  assert.equal(reply.body.acceptance[0].result, "unverified");
});

test("작업 패킷에는 목표·조건·파일 참조만 담고 읽기 전용이면 수정 금지를 밝힌다", () => {
  const text = buildPrompt({
    task_id: "T1",
    message_id: "m",
    goal: "확인",
    acceptance: [],
    file_refs: [{ path: "src/a.js", symbol: "login" }],
    write_files: [],
  });
  assert.match(text, /src\/a\.js \(login\)/);
  assert.match(text, /읽기 전용 작업/);
  assert.match(text, /목표 달성 여부를 근거와 함께 보고/);
});

test("잘못된 봉투는 큐에 들어가지 않는다", (t) => {
  const { store, task } = setup(t);
  assert.throws(() => store.sendTask(task({ recipient: "codex", sender: "codex" })), /must differ/);
  assert.throws(() => store.sendTask(task({ write_files: ["a.txt"] })), /workspace-write/);
  assert.throws(() => store.sendTask(task({ goal: "" })), /goal is required/);
  assert.equal(store.listTasks().length, 0);
});

test("실패 후 재시도는 새 회신을 전달하며 이전 시도의 회신을 보존한다", (t) => {
  const { store, task } = setup(t);
  store.sendTask(task());
  const first = store.claimTask("codex", "runner:first");
  const old = store.finishTask("msg-1", { claim: first, outcome: "result", reply: { status: "failed", summary: "old" } });
  store.setStatus("msg-1", "blocked", "failed");
  store.takeReplies("claude-code");
  store.ackReplies("claude-code", [old.message_id]);
  store.requeue("msg-1");
  const second = store.claimTask("codex", "runner:second");
  const current = store.finishTask("msg-1", { claim: second, outcome: "result", reply: { status: "done", summary: "new" } });
  assert.notEqual(current.message_id, old.message_id);
  assert.equal(current.body.summary, "new");
  assert.equal(store.get(old.message_id).body.summary, "old");
  assert.equal(store.takeReplies("claude-code")[0].message_id, current.message_id);
  assert.equal(second.attempt, first.attempt + 1);
});

test("재할당된 작업은 이전 실행기의 완료와 상태 변경을 거절한다", (t) => {
  const { store, task } = setup(t);
  store.sendTask(task());
  const old = store.claimTask("codex", "runner:old");
  store.setStatus("msg-1", "blocked", "stale");
  store.requeue("msg-1");
  const current = store.claimTask("codex", "runner:new");
  assert.throws(() => store.finishTask("msg-1", { claim: old, outcome: "result", reply: { status: "done" } }), /claim|attempt/i);
  assert.throws(() => store.finishTask("msg-1", { claim: { ...current, claimed_by: "wrong" }, outcome: "result", reply: {} }), /claim|attempt/i);
  store.setStatus("msg-1", "blocked", "old error", old);
  store.setTurn("msg-1", "old-thread", "old-turn", old);
  assert.equal(store.get("msg-1").status, "working");
  assert.equal(store.get("msg-1").turn_id, null);
  assert.deepEqual(store.takeReplies("claude-code"), []);
});

test("파일 잠금은 cwd와 정규화된 실제 경로를 비교한다", (t) => {
  const { store, dir, task } = setup(t);
  const other = path.join(dir, "other");
  mkdirSync(other);
  const write = { sandbox: "workspace-write" };
  store.sendTask(task({ message_id: "A", ...write, write_files: ["a.txt"] }));
  store.sendTask(task({ message_id: "B", ...write, write_files: ["sub/../a.txt"] }));
  store.sendTask(task({ message_id: "C", ...write, cwd: other, file_refs: [], write_files: ["a.txt"] }));
  assert.equal(store.claimTask("codex", "runner:a").message_id, "A");
  assert.equal(store.claimTask("codex", "runner:c").message_id, "C");
  assert.equal(store.claimTask("codex", "runner:b"), null);
});

test("junction 또는 symlink 아래의 아직 없는 파일도 같은 쓰기 범위이다", (t) => {
  const { store, dir, task } = setup(t);
  const actual = path.join(dir, "actual");
  mkdirSync(actual);
  symlinkSync(actual, path.join(dir, "alias"), process.platform === "win32" ? "junction" : "dir");
  const write = { sandbox: "workspace-write", file_refs: [] };
  store.sendTask(task({ message_id: "A", ...write, write_files: ["actual/new/file.txt"] }));
  store.sendTask(task({ message_id: "B", ...write, write_files: ["alias/new/file.txt"] }));
  store.claimTask("codex", "runner:a");
  assert.equal(store.claimTask("codex", "runner:b"), null);
});

test("디렉터리 쓰기 범위는 실행 가능하고 내부 변경을 관찰한다", async (t) => {
  const { store, dir, runner, task } = setup(t);
  mkdirSync(path.join(dir, "src"));
  const file = path.join(dir, "src", "new.txt");
  store.sendTask(task({ sandbox: "workspace-write", write_files: ["src"] }));
  await runCodexWorker(store, { once: true, allowWrite: true, ...runner({ FAKE_WRITE: file, FAKE_REPORT: "src/new.txt" }) });
  assert.equal(store.get("msg-1").status, "ready");
  const [reply] = store.takeReplies("claude-code");
  assert.deepEqual(reply.body.changed_files.observed, ["src/new.txt"]);
  assert.deepEqual(reply.body.changed_files.outside_scope, []);
});

test("최상위 junction 쓰기 범위는 대상 변경을 해시하고 내부 순환 링크는 따라가지 않는다", (t) => {
  const { dir } = setup(t);
  const actual = path.join(dir, "actual");
  mkdirSync(actual);
  writeFileSync(path.join(actual, "a.txt"), "before");
  symlinkSync(actual, path.join(dir, "alias"), process.platform === "win32" ? "junction" : "dir");
  symlinkSync(actual, path.join(actual, "loop"), process.platform === "win32" ? "junction" : "dir");
  const before = hashFile(dir, "alias");
  writeFileSync(path.join(actual, "a.txt"), "after");
  assert.notEqual(hashFile(dir, "alias"), before);
  assert.equal(hashFile(dir, "alias"), hashFile(dir, "actual"));
});

test("회신은 재시작 후에도 ACK 전까지 남고 다른 수신자가 ACK할 수 없다", (t) => {
  const { store, dbPath, task } = setup(t);
  store.sendTask(task());
  const claim = store.claimTask("codex", "runner:test");
  const reply = store.finishTask("msg-1", { claim, outcome: "result", reply: { status: "done" } });
  store.takeReplies("claude-code");
  store.close();
  const reopened = new BridgeStore(dbPath);
  try {
    assert.equal(reopened.takeReplies("claude-code").length, 1);
    assert.throws(() => reopened.ackReplies("codex", [reply.message_id]), /recipient|receiver/i);
    reopened.ackReplies("claude-code", [reply.message_id]);
    reopened.ackReplies("claude-code", [reply.message_id]);
    assert.deepEqual(reopened.takeReplies("claude-code"), []);
  } finally { reopened.close(); }
});

test("실패와 취소 턴도 사용량을 보존한다", async (t) => {
  const { store, runner, task } = setup(t);
  store.sendTask(task({ message_id: "failed" }));
  await runCodexWorker(store, { once: true, ...runner({ FAKE_MODE: "failed" }) });
  assert.equal(store.get("failed").usage?.turn?.inputTokens, 1000);
  store.sendTask(task({ message_id: "cancelled" }));
  const claimed = store.claimTask("codex", "runner:test");
  const running = runCodexTask(store, claimed, runner({ FAKE_MODE: "slow" }, { turnTimeoutMs: 2000 }));
  while (!store.get("cancelled").turn_id) await sleep(10);
  store.requestCancel("cancelled");
  await running;
  assert.equal(store.get("cancelled").status, "cancelled");
  assert.equal(store.get("cancelled").usage?.turn?.inputTokens, 1000);
});

test("실행기 종료 신호가 진행 중인 턴을 중단하고 다음 작업을 시작하지 않는다", async (t) => {
  const { store, runner, requests, task } = setup(t);
  store.sendTask(task());
  store.sendTask(task({ message_id: "next", repeat: true }));
  const controller = new AbortController();
  const running = runCodexWorker(store, { once: true, signal: controller.signal, ...runner({ FAKE_MODE: "slow" }, { turnTimeoutMs: 15000 }) });
  while (!store.get("msg-1").turn_id && store.get("msg-1").status!=='blocked') await sleep(10);
  assert.ok(store.get("msg-1").turn_id,store.get("msg-1").status_reason);
  controller.abort();
  await running;
  assert.equal(store.get("msg-1").status, "cancelled");
  assert.equal(store.get("next").status, "queued");
  assert.equal(requests().filter((r) => r.method === "turn/interrupt").length, 1);
});

test("재시도 후에도 실패 시도의 사용량과 새 시도의 사용량을 함께 조회한다", async (t) => {
  const { store, runner, task } = setup(t);
  store.sendTask(task());
  const first = store.claimTask("codex", "runner:first");
  const failed = await runCodexTask(store, first, runner({ FAKE_MODE: "failed" }));
  assert.equal(failed.usage?.turn?.inputTokens, 1000);
  store.requeue("msg-1");
  await runCodexWorker(store, { once: true, ...runner() });
  assert.deepEqual(store.listUsage("msg-1").map((u) => [u.attempt, u.turn.inputTokens]), [[1, 1000], [2, 1000]]);
  // The fake server makes one model request per turn.
  assert.deepEqual(store.listUsage("msg-1").map((u) => u.calls.model_calls), [1, 1]);
  assert.ok(store.listUsage("msg-1").every((u) => u.calls.peak_call_input_tokens > 0));
});

test("기존 DB를 열 때 작업과 회신 및 사용량을 보존하며 마이그레이션한다", (t) => {
  const { store, dbPath, task } = setup(t);
  store.sendTask(task());
  const claim = store.claimTask("codex", "runner:legacy");
  const usage = { thread_total: { inputTokens: 7 }, turn: { inputTokens: 7 } };
  const reply = store.finishTask("msg-1", { claim, outcome: "result", reply: { status: "done" }, usage });
  store.db.exec("ALTER TABLE messages DROP COLUMN attempt; DROP TABLE attempt_usage;");
  store.close();
  for (let i = 0; i < 2; i++) {
    const reopened = new BridgeStore(dbPath);
    try {
      assert.equal(reopened.get("msg-1").attempt, 0);
      assert.equal(reopened.get(reply.message_id).body.status, "done");
      assert.equal(reopened.listUsage("msg-1").length, 1);
      assert.equal(reopened.listUsage("msg-1")[0].turn.inputTokens, 7);
    } finally { reopened.close(); }
  }
});

test("CLI는 실행 시도 번호를 전달하고 늦은 수동 회신을 거절하며 ACK를 지원한다", (t) => {
  const { store, dbPath, task } = setup(t);
  const cli = path.join(path.dirname(FAKE), "..", "..", "cli.mjs");
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args, "--db", dbPath], { encoding: "utf8", windowsHide: true });
  store.sendTask(task({ sender: "codex", recipient: "claude-code", profile:'review', short_summary:'omit-this-input', private_data:'not-forwarded' }));
  const received = invoke("receive", "--as", "claude-code", "--take-tasks");
  assert.equal(received.status, 0, received.stderr);
  const claim = JSON.parse(received.stdout);
  assert.equal(claim.attempt, 1);
  assert.equal(claim.profile,'review');
  assert.equal(claim.private_data,undefined);
  assert.equal(claim.short_summary,undefined);
  assert.equal(claim.file_refs[0].path,'a.txt');
  assert.notEqual(invoke("reply", "--to", "msg-1", "--attempt", "0", "--summary", "old").status, 0);
  const replied = invoke("reply", "--to", "msg-1", "--attempt", String(claim.attempt), "--summary", "done");
  assert.equal(replied.status, 0, replied.stderr);
  const reply = JSON.parse(replied.stdout);
  assert.equal(reply.projection.profile,'review');
  assert.equal(JSON.parse(invoke("receive", "--as", "codex").stdout).message_id, reply.message_id);
  assert.equal(JSON.parse(invoke("receive", "--as", "codex").stdout).message_id, reply.message_id);
  assert.equal(invoke("ack", reply.message_id, "--as", "codex").status, 0);
  assert.equal(invoke("receive", "--as", "codex").stdout, "");
});

test("초기화 응답 대기 중 종료 신호도 실행기를 정리한다", async (t) => {
  const { store, runner, requests, task } = setup(t);
  store.sendTask(task());
  const controller = new AbortController();
  const running = runCodexWorker(store, { once: true, signal: controller.signal, ...runner({ FAKE_MODE: "startup-slow" }) });
  while (!requests().some((r) => r.method === "initialize")) await sleep(10);
  controller.abort();
  await running;
  assert.equal(store.get("msg-1").status, "blocked");
  assert.equal(requests().some((r) => r.method === "turn/start"), false);
});
