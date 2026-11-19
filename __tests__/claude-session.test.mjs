import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {prepareClaudeSessionArgs,startClaudeSession,recordClaudeSessionUsage} from '../claude-session.mjs';
import {BridgeStore} from '../store.mjs';
import {PassThrough} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {buildClaudeArgs} from '../claude-runner.mjs';

test('MCP sessions retain deferred discovery with either custom tools syntax',()=>{
 for(const args of [['--tools','Bash,Read'],['--tools=Bash,Read']]){
  const result=prepareClaudeSessionArgs(args);
  assert.match(result.join(' '),/Bash,Read,ToolSearch/);
  assert.ok(!result.includes('--strict-mcp-config'));
 }
 assert.deepEqual(prepareClaudeSessionArgs(['--tools','default']),['--tools','default']);
 assert.deepEqual(prepareClaudeSessionArgs(['--tools','Read,ToolSearch']),['--tools','Read,ToolSearch']);
 assert.deepEqual(prepareClaudeSessionArgs(['--','--tools','literal']),['--','--tools','literal']);
});

test('Bridge-only sessions explicitly exclude MCP without changing permissions or hooks',()=>{
 const args=prepareClaudeSessionArgs(['--tools','Bash,Read','--permission-mode','auto'],{bridgeOnly:true});
 assert.equal(args[args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
 assert.ok(args.includes('--strict-mcp-config'));
 assert.equal(args[args.indexOf('--tools')+1],'Bash,Read');
 assert.equal(args[args.indexOf('--permission-mode')+1],'auto');
 for(const flag of ['--bare','--safe-mode','--dangerously-skip-permissions','--settings','--setting-sources'])assert.ok(!args.includes(flag));
 for(const flag of ['--mcp-config','--mcp-config={}'])assert.throws(()=>prepareClaudeSessionArgs([flag],{bridgeOnly:true}),/MCP/);
 const withPrompt=prepareClaudeSessionArgs(['--','literal prompt'],{bridgeOnly:true});
 assert.ok(withPrompt.indexOf('--strict-mcp-config')<withPrompt.indexOf('--'));
});

test('all read-only worker roles use the same explicit empty MCP config; ordinary write tasks retain MCP',()=>{
 for(const role of ['review','implement']){
  const args=buildClaudeArgs({role,sandbox:'read-only',write_files:[]});
  assert.equal(args[args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
  assert.ok(args.includes('--strict-mcp-config'));
 }
 const args=buildClaudeArgs({role:'implement',sandbox:'workspace-write',write_files:['a.js']});
 assert.ok(!args.includes('--strict-mcp-config'));
 assert.equal(args[args.indexOf('--permission-mode')+1],'auto');
});

test('session launcher preserves native execution and reports exit and spawn failure',async t=>{
 let invocation,fail=false;
 t.mock.method(childProcess,'spawn',(command,args,options)=>{
  invocation={command,args,options};const child=new EventEmitter();
  queueMicrotask(()=>fail?child.emit('error',new Error('cannot start')):child.emit('close',7,null));return child;
 });
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 assert.equal(await startClaudeSession(['--bridge-only','--model','haiku'],{command:process.execPath}),7);
 assert.equal(invocation.command,process.execPath);assert.equal(invocation.options.shell,false);
 assert.equal(invocation.options.stdio,'inherit');assert.ok(!invocation.args.includes('--bridge-only'));
 assert.ok(invocation.args.includes('--strict-mcp-config'));
 assert.equal(invocation.args[invocation.args.indexOf('--tools')+1],'Bash,Read');
 assert.equal(invocation.args[invocation.args.indexOf('--model')+1],'haiku');
 assert.equal(await startClaudeSession(['--version'],{command:process.execPath}),7);
 assert.deepEqual(invocation.args,['--version']);
 fail=true;await assert.rejects(startClaudeSession([],{command:process.execPath}),/cannot start/);
 await assert.rejects(startClaudeSession([],{command:'unsafe.cmd'}),/native/);
});

test('project session captures actual stream usage while preserving child output',async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'bridge-session-usage-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const previous=process.env.AGENT_BRIDGE_DB;process.env.AGENT_BRIDGE_DB=path.join(dir,'queue.db');
 t.after(()=>{if(previous===undefined)delete process.env.AGENT_BRIDGE_DB;else process.env.AGENT_BRIDGE_DB=previous;});
 t.mock.method(childProcess,'spawn',(_command,args,options)=>{
  assert.ok(!args.includes('--project'));assert.equal(args[args.indexOf('--output-format')+1],'stream-json');
  assert.deepEqual(options.stdio,['inherit','pipe','inherit']);
  const child=new EventEmitter();child.stdout=new PassThrough();
  queueMicrotask(()=>{
   child.stdout.end(JSON.stringify({type:'result',session_id:'captured',usage:{input_tokens:2,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:3}})+'\n');
   child.emit('close',0,null);
  });return child;
 });
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 assert.equal(await startClaudeSession(['--project','project','--bridge-only','-p','nonce'],{command:process.execPath}),0);
 const store=new BridgeStore();try{assert.equal(store.projectUsage('project').external_events,1);}finally{store.close();}
});

test('initiating Claude usage is recorded separately and deduplicated by native session ID',()=>{
 const store=new BridgeStore(':memory:');
 try{
  const result={session_id:'native-session',usage:{input_tokens:2,cache_creation_input_tokens:100,cache_read_input_tokens:50,output_tokens:3}};
  recordClaudeSessionUsage(store,'project',result);recordClaudeSessionUsage(store,'project',result);
  const usage=store.projectUsage('project');assert.equal(usage.external_events,1);assert.equal(usage.tokens.inputTokens.total,2);
  assert.equal(usage.coverage,'bridge-attempts-and-recorded-external-events');
  assert.equal(usage.tokens.totalTokens.total,155);assert.equal(usage.attempts,0);
  assert.throws(()=>recordClaudeSessionUsage(store,'project',{session_id:'unknown'}),/measured/);
 }finally{store.close();}
});
