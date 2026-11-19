import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { artifactScopes, checkArtifactCall, artifactRuntime } from "../artifact-runtime.mjs";
import { fixtureLog } from "./fixtures/fixture-log.mjs";

test("Codex runner installs the scoped transport while retaining hooks and approvalPolicy never", async (t) => {
  const { BridgeStore } = await import("../store.mjs");
  const { runCodexWorker } = await import("../codex-runner.mjs");
  const { readFileSync } = await import("node:fs");
  const cwd = setup(t);
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const log = fixtureLog(t, "requests.jsonl");
  store.sendTask({ message_id: "doc", task_id: "doc", sender: "claude-code", recipient: "codex",
    cwd, goal: "create document", acceptance: [], sandbox: "workspace-write", write_files: ["guide.md"] });
  await runCodexWorker(store, { once: true, allowWrite: true, command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url))], env: { FAKE_LOG: log } });
  assert.equal(store.get("doc").status, "ready", store.get("doc").status_reason);
  const receipt = store.listRuntime("doc")[0];
  assert.equal(receipt.artifact_writer.tools.includes("write_artifact"), true);
  assert.ok(receipt.protected_hooks.length);
  const calls = readFileSync(log,"utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.find(c=>c.method==="thread/start").params.approvalPolicy, "never");
});

test("Codex runner finishes a document task on a PC without Artifact Writer", async (t) => {
  const { BridgeStore } = await import("../store.mjs");
  const { runCodexWorker } = await import("../codex-runner.mjs");
  const cwd = setup(t);
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  store.sendTask({ message_id: "doc-plain", task_id: "doc-plain", sender: "claude-code", recipient: "codex",
    cwd, goal: "create document", acceptance: [], sandbox: "workspace-write", write_files: ["guide.md"] });
  await runCodexWorker(store, { once: true, allowWrite: true, command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url))],
    env: { FAKE_NO_ARTIFACT_WRITER: "1", FAKE_WRITE: path.join(cwd, "guide.md") } });
  assert.equal(store.get("doc-plain").status, "ready", store.get("doc-plain").status_reason);
  assert.equal(store.listRuntime("doc-plain")[0].artifact_writer, undefined);
});

const guard = fileURLToPath(new URL("../artifact-runtime.mjs", import.meta.url));
function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-artifact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("document runtime permits the writer without changing general approvals or loading it for read-only work", async (t) => {
  const cwd = setup(t);
  const task = { cwd, sandbox: "workspace-write", write_files: ["guide.md"] };
  const server = { command: process.execPath, args: ["installed-writer.mjs"] };
  const client = { request: async method => {
    assert.equal(method, "config/read");
    return { config: { mcp_servers: { artifact_writer: server } } };
  } };
  const result = await artifactRuntime(client, task, true);
  assert.equal(result.config.command, process.execPath);
  assert.deepEqual(result.config.enabled_tools, ["register_artifact", "write_artifact", "artifact_status"]);
  assert.equal(result.config.tools.write_artifact.approval_mode, "approve");
  assert.equal(result.flags.some(f => f.includes("approval_policy")), false);
  assert.equal(await artifactRuntime(client, task, false), null);
  assert.equal(await artifactRuntime(client, { ...task, sandbox: "read-only" }, true), null);
  assert.equal(await artifactRuntime(client, { ...task, write_files: ["a.mjs"] }, true), null);
});

test("document writes run without the writer transport when Artifact Writer is not installed", async (t) => {
  const cwd = setup(t);
  const task = { cwd, sandbox: "workspace-write", write_files: ["guide.md"] };
  const asked = [];
  const client = { request: async method => {
    asked.push(method);
    if (method === "config/read") return { config: {} };
    if (method === "plugin/installed") return { marketplaces: [] };
    throw new Error("unexpected request " + method);
  } };
  assert.equal(await artifactRuntime(client, task, true), null);
  assert.deepEqual(asked, ["config/read", "plugin/installed"]);
});

test("an installed but misconfigured Artifact Writer is still rejected", async (t) => {
  const cwd = setup(t);
  const task = { cwd, sandbox: "workspace-write", write_files: ["guide.md"] };
  const client = { request: async () => ({ config: { mcp_servers: { artifact_writer: { url: "http://127.0.0.1:9" } } } }) };
  await assert.rejects(artifactRuntime(client, task, true), /enabled local stdio server/);
});

test("writer target guard rejects other files, unspecified targets, directories and non-writer tools", (t) => {
  const cwd = setup(t);
  const scopes = artifactScopes({ cwd, sandbox: "workspace-write", write_files: ["guide.md"] }, true);
  for (const name of ["register_artifact", "write_artifact", "artifact_status"]) {
    assert.doesNotThrow(() => checkArtifactCall({ name, arguments: { target: path.join(cwd, "guide.md") } }, scopes));
    for (const target of [undefined, "guide.md", path.join(cwd, "other.md"), cwd]) {
      assert.throws(() => checkArtifactCall({ name, arguments: { target } }, scopes));
    }
  }
  assert.throws(() => checkArtifactCall({ name: "exec", arguments: { target: path.join(cwd, "guide.md") } }, scopes));
  assert.throws(() => checkArtifactCall({ name: "write_artifact", arguments: { target: path.join(cwd, "guide.md") } }, []));
});

test("directory scope permits document children but not siblings or a remapped junction", (t) => {
  const cwd = setup(t);
  mkdirSync(path.join(cwd, "docs"));
  const scopes = artifactScopes({ cwd, sandbox: "workspace-write", write_files: ["docs"] }, true);
  assert.doesNotThrow(() => checkArtifactCall({ name: "register_artifact", arguments: { target: path.join(cwd, "docs", "new.md") } }, scopes));
  assert.throws(() => checkArtifactCall({ name: "register_artifact", arguments: { target: path.join(cwd, "docs-other", "new.md") } }, scopes));
  assert.throws(() => checkArtifactCall({ name: "write_artifact", arguments: { target: path.join(cwd, "docs", "x.exe") } }, scopes));
  renameSync(path.join(cwd, "docs"), path.join(cwd, "old-docs"));
  mkdirSync(path.join(cwd, "outside"));
  symlinkSync(path.join(cwd, "outside"), path.join(cwd, "docs"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => checkArtifactCall({ name: "write_artifact", arguments: { target: path.join(cwd, "docs", "new.md") } }, scopes));
});

test("stdio guard forwards original hook token and brief, refuses outside writes before the writer sees them", (t) => {
  const cwd = setup(t);
  const fixture = path.join(cwd, "writer.mjs");
  const target = path.join(cwd, "검증.md");
  // Fake only the upstream model provider: real guard process, real JSON-RPC, real filesystem output.
  writeFileSync(fixture, `import readline from "node:readline";
import {writeFileSync} from "node:fs";
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);
 if(m.method==="tools/call"){
   if(m.params.name==="write_artifact") writeFileSync(m.params.arguments.target,JSON.stringify(m.params.arguments));
   process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"ok"}]}})+"\\n");
 }
});`);
  const config = { upstream: { command: process.execPath, args: [fixture] },
    scopes: artifactScopes({ cwd, sandbox: "workspace-write", write_files: ["검증.md"] }, true) };
  const brief = { audience: "tester", purpose: "test", language: "ko", requirements: [], source_material: ["fixture"] };
  const calls = [
    { id: 1, name: "write_artifact", arguments: { target, brief, _hook_token: "fixture-original-token" } },
    { id: 2, name: "write_artifact", arguments: { target: path.join(cwd, "outside.md"), brief } },
    { id: 3, name: "artifact_status", arguments: {} },
  ];
  const child = spawnSync(process.execPath, [guard, JSON.stringify(config)], { cwd, encoding: "utf8",
    input: calls.map(({id,...params}) => JSON.stringify({jsonrpc:"2.0",id,method:"tools/call",params})).join("\n")+"\n" });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies.find(r=>r.id===1).result.isError, undefined);
  assert.equal(replies.find(r=>r.id===2).result.isError, true);
  assert.equal(replies.find(r=>r.id===3).result.isError, true);
  return import("node:fs").then(({readFileSync,existsSync})=>{
    assert.deepEqual(JSON.parse(readFileSync(target,"utf8")), { target, brief, _hook_token: "fixture-original-token" });
    assert.equal(existsSync(path.join(cwd,"outside.md")), false);
  });
});
