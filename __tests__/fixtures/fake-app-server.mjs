// Stand-in for `codex app-server` in tests: same JSON-RPC shapes, no model.
// FAKE_MODE: done | question | plain | failed | slow | crash | startup-slow ; FAKE_LOG: append received messages
// FAKE_WRITE: file to modify during the turn ; FAKE_TOTAL_BASE: thread token total before this process
// FAKE_ERROR: message of a failed turn ; FAKE_TOOL: report one command run before the turn ends
// FAKE_NO_ARTIFACT_WRITER: behave like a PC without the Artifact Writer server or plugin
import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";
import {receiptFor} from '../../contracts.mjs';

const mode = process.env.FAKE_MODE ?? "done";
const base = Number(process.env.FAKE_TOTAL_BASE ?? 0);
let turnSeq = 0;
let pending = null;
let contractPacket;
let artifactWriter = process.env.FAKE_NO_ARTIFACT_WRITER ? null : { command: process.execPath, args: [] };
const contextConfig={};
const plugins={'artifact-writer@local-artifact-tools':{enabled:true},'ponytail@ponytail':{enabled:true},'github@openai-curated':{enabled:true},'extra@test':{enabled:true}};
for(let i=2;i<process.argv.length;i++) {
  if(process.argv[i]!=='-c') continue;
  const arg=process.argv[++i];
  if(arg.startsWith('project_doc_max_bytes='))contextConfig.project_doc_max_bytes=Number(arg.split('=')[1]);
  if(arg.startsWith('skills.include_instructions='))contextConfig.skills={include_instructions:arg.split('=')[1]==='true'};
  if (arg.startsWith('mcp_servers.artifact_writer=')) {
    artifactWriter = {
      command: JSON.parse(arg.match(/"command" = ("(?:\\.|[^"\\])*")/)[1]),
      args: JSON.parse(arg.match(/"args" = (\[(?:"(?:\\.|[^"\\])*"(?:,)?)*\])/)[1]),
    };
  }
  if(arg.startsWith('plugins=')) for(const match of arg.matchAll(/("[^"\r\n]+") = \{ enabled = (true|false) \}/g)) {
    plugins[JSON.parse(match[1])]={enabled:match[2]==='true'};
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function finalText() {
  const reply = {
    status: mode === "question" ? "question" : "done",
    summary: "요약",
    question: mode === "question" ? "어느 파일을 기준으로 할까요?" : null,
    acceptance: [{ criterion: "테스트 통과", result: "pass", evidence: "fake" }],
    changed_files: process.env.FAKE_WRITE ? [process.env.FAKE_REPORT ?? "a.txt"] : [],
  };
  if(contractPacket){reply.acceptance=contractPacket.step.acceptance.map(criterion=>({criterion,result:'pass',evidence:'fake actual packet'}));
    reply.contract_receipt=receiptFor({...contractPacket,...contractPacket.step},contractPacket.contract_environment,reply.acceptance);}
  return mode === "plain" ? "그냥 문장으로 답함" : JSON.stringify(reply);
}

function complete(threadId, turnId, status) {
  if (status === "completed") {
    send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "m", text: finalText() } } });
  }
  const total = { inputTokens: base + 1000 * turnSeq, cachedInputTokens: 0, outputTokens: 10 * turnSeq, reasoningOutputTokens: 0, totalTokens: base + 1010 * turnSeq };
  send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last: total, total } } });
  const error = status === "failed" ? { message: process.env.FAKE_ERROR ?? "boom" } : null;
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, error, items: [] } } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${line}\n`);
  const { id, method, params = {} } = msg;
  if (method === "initialize") return mode === "startup-slow" ? undefined : send({ id, result: { userAgent: "fake" } });
  if (method === "initialized") return;
  if (method === 'thread/read') return send({id,result:{thread:{id:params.threadId,originator:process.env.FAKE_ORIGINATOR ?? 'agent-bridge',status:{type:'notLoaded'}},readState:process.env.FAKE_NO_READ_STATE?null:{firstUnread:{type:'turn',turnId:'turn-1'},revision:'seen-revision'}}});
  if (method === 'thread/turns/list') return send({id,result:{data:[{id:process.env.FAKE_LATEST_TURN ?? 'turn-1',status:'completed'}],nextCursor:null}});
  if (method === 'thread/readState/update') return process.env.FAKE_READ_ERROR
    ? send({id,error:{code:-32000,message:process.env.FAKE_READ_ERROR}})
    : send({id,result:{readState:{firstUnread:null,revision:'read-revision'}}});
  if (method === 'config/read') return send({id,result:{config:{...contextConfig,plugins,mcp_servers:artifactWriter?{artifact_writer:artifactWriter}:{}}}});
  if (method === 'plugin/installed') return send({id,result:{marketplaces:[]}});
  if (method === 'hooks/list') return send({id,result:{data:[{cwd:process.cwd(),errors:[],hooks:[{key:'writer',pluginId:'artifact-writer@local-artifact-tools',enabled:plugins['artifact-writer@local-artifact-tools'].enabled,currentHash:'sha256:test',trustStatus:'trusted'}]}]}});
  if (method === "thread/start") return send({ id, result: { thread: { id: "thr-new" } } });
  if (method === "thread/resume") return send({ id, result: { thread: { id: params.threadId } } });
  if (method === "turn/start") {
    const line=params.input?.[0]?.text?.split('\n').find(line=>line.startsWith('CONTRACT_JSON:'));
    contractPacket=line?JSON.parse(line.slice('CONTRACT_JSON:'.length)):null;
    const turnId = `turn-${++turnSeq}`;
    send({ id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    send({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
    send({ method: 'hook/completed', params: {threadId:params.threadId,turnId,run:{id:'hook-1',eventName:'userPromptSubmit',status:'completed'}} });
    if (process.env.FAKE_TOOL) send({ method: "item/started", params: { threadId: params.threadId, turnId, item: { type: "commandExecution", id: "cmd-1" } } });
    if (mode === "crash") process.exit(3);
    if (mode === "slow") {
      pending = { threadId: params.threadId, turnId };
      return;
    }
    if (process.env.FAKE_WRITE) {
      send({ method: "item/started", params: { threadId: params.threadId, turnId, item: { type: "fileChange", id: "fc-1" } } });
      writeFileSync(process.env.FAKE_WRITE, `changed ${Date.now()}`);
    }
    return complete(params.threadId, turnId, mode === "failed" ? "failed" : "completed");
  }
  if (method === "turn/interrupt") {
    send({ id, result: {} });
    if (pending) complete(pending.threadId, pending.turnId, "interrupted");
    pending = null;
    return;
  }
  if (id !== undefined && method) send({ id, error: { code: -32601, message: `unknown ${method}` } });
});
