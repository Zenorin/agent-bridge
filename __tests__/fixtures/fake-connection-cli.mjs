import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2),login=args.includes('login'),agent=args.includes('exec')?'codex':'gemini';
const mode=process.env.CONNECTION_FIXTURE_MODE ?? 'pass';
if(process.env.CONNECTION_FIXTURE_LOG)appendFileSync(process.env.CONNECTION_FIXTURE_LOG,JSON.stringify({args,login,agent,hasGeminiKey:!!process.env.GEMINI_API_KEY,cwd:process.cwd()})+'\n');
if(mode==='timeout'){setInterval(()=>{},1000);}
else if(login){console.log(mode==='logged-out'?'Not logged in':'Logged in using ChatGPT. private-value-must-not-be-reported');process.exitCode=mode==='logged-out'?1:0;}
else {
 let input='';process.stdin.on('data',chunk=>input+=chunk).on('end',()=>{
  const send=event=>console.log(JSON.stringify(event));
  if(mode==='model-conflict'){send({event:'result',result:{status:'ERROR',error:'invalid model selection: --model gemini-4-argon-medium conflicts with --effort=low; request 1401; person@example.test; Bearer private-secret',usage:{input_tokens:0,output_tokens:0}}});process.exitCode=1;return;}
  if(mode==='auth-failed'||mode==='quota'){console.error(mode==='quota'?'429 quota exceeded':'401 authentication required private-secret');process.exitCode=1;return;}
  if(mode==='tool'){send(agent==='codex'?{type:'item.started',item:{type:'command_execution'}}:{event:'step_update',step_update:{step_type:'tool',tool_name:'run_command'}});setInterval(()=>{},1000);return;}
  const nonce=(input || args[args.indexOf('--print')+1] || '').match(/BRIDGE_[a-f0-9]+/)?.[0];
  const reply=JSON.stringify({echo:mode==='wrong'?'wrong':nonce});
  if(agent==='codex'){send({type:'item.completed',item:{type:'agent_message',text:reply}});send({type:'turn.completed',usage:{input_tokens:80,cached_input_tokens:40,output_tokens:12}});}
  else send({event:'result',result:{status:'SUCCESS',response:'',structured_output:JSON.parse(reply),usage:{input_tokens:70,cache_read_tokens:30,output_tokens:10,total_tokens:80}}});
 });
}
