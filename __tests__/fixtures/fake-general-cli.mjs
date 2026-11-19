import {writeFileSync,appendFileSync} from 'node:fs';
import {receiptFor} from '../../contracts.mjs';
let input='';
process.stdin.on('data',chunk=>{input+=chunk;});
process.stdin.on('end',()=>{
  const args=process.argv.slice(2), gemini=args.includes('--input-format');
  if(gemini)input=JSON.parse(input).message.content;
  if(process.env.FAKE_GENERAL_LOG)appendFileSync(process.env.FAKE_GENERAL_LOG,JSON.stringify({args,input,hasApiKey:!!process.env.GEMINI_API_KEY})+'\n');
  const send=event=>process.stdout.write(JSON.stringify(event)+'\n');
  if(!gemini&&process.env.FAKE_GENERAL_MODE!=='no-hooks')send({type:'system',subtype:'hook_response',hook_name:'UserPromptSubmit',exit_code:0,outcome:'success'});
  if(process.env.FAKE_GENERAL_MODE==='classifier-denial'){
    send({type:'system',subtype:'permission_denied',tool_name:'Bash',decision_reason:'Blocked by classifier',decision_reason_type:'classifier'});
    send({type:'result',subtype:'success',is_error:true,result:'',permission_denials:[{tool_name:'Bash',decision_reason:'Blocked by classifier'}]});return;
  }
  send({type:gemini?'init':'system',session_id:'12345678-1234-1234-1234-123456789abc'});
  if(process.env.FAKE_GENERAL_MODE==='slow'){setInterval(()=>{},1000);return;}
  if(gemini && process.env.FAKE_GENERAL_MODE?.startsWith('denial-')){
    const message=process.env.FAKE_DENIAL_MESSAGE;
    const event={event:'step_update',step_update:{state:'ERROR',step_type:'tool',tool_name:'read_file',tool_info:{error:{type:'TOOL_ERROR',message}}}};
    send(event);send(event);
    if(!['denial-recovered','denial-failed'].includes(process.env.FAKE_GENERAL_MODE)){
      send({event:'result',result:{status:process.env.FAKE_GENERAL_MODE==='denial-error'?'ERROR':'SUCCESS',response:process.env.FAKE_GENERAL_MODE==='denial-text'?'The read was denied.':'',usage:{input_tokens:3,output_tokens:5}}});
      if(process.env.FAKE_GENERAL_MODE==='denial-exit')process.exitCode=1;
      return;
    }
  }
  if(gemini && process.env.FAKE_GENERAL_MODE==='empty-reply'){send({event:'result',result:{status:'SUCCESS',response:''}});return;}
  if(process.env.FAKE_GENERAL_MODE==='malformed'){send({type:'result',status:'success',result:'invalid'});return;}
  if(['quota','quota-after-tool'].includes(process.env.FAKE_GENERAL_MODE)){
    if(process.env.FAKE_GENERAL_MODE==='quota-after-tool')send({type:'tool_use',tool_name:'write_file'});
    process.stderr.write('429 RESOURCE_EXHAUSTED: quota exceeded\n');process.exitCode=1;return;
  }
  const writes=input.includes('a.txt') && input.includes('workspace-write');
  if(writes)writeFileSync('a.txt','written by fixture');
  const result={status:process.env.FAKE_GENERAL_MODE==='question'?'question':process.env.FAKE_GENERAL_MODE==='denial-failed'?'failed':'done',summary:'fixture reply',question:process.env.FAKE_GENERAL_MODE==='question'?'Which input?':null,
    acceptance:[{criterion:'reply',result:'pass',evidence:'fixture'}],changed_files:writes?['a.txt']:[]};
  const line=input.split('\n').find(line=>line.startsWith('CONTRACT_JSON:'));
  if(line){const packet=JSON.parse(line.slice('CONTRACT_JSON:'.length));result.acceptance=packet.step.acceptance.map(criterion=>({criterion,result:'pass',evidence:'fake actual packet'}));
    result.contract_receipt=receiptFor({...packet,...packet.step},packet.contract_environment,result.acceptance);}
  if(gemini){
    if(process.env.FAKE_GENERAL_MODE==='preamble'){
      send({type:'message',role:'assistant',content:'I will inspect the input.'});
      send({type:'tool_use',tool_name:'read_file'});send({type:'tool_result',status:'success'});
    }
    if(['steps','steps-unmeasured'].includes(process.env.FAKE_GENERAL_MODE)){
      const step=(step_index,state,step_type,extra)=>send({event:'step_update',step_update:{conversation_id:'12345678-1234-1234-1234-123456789abc',step_index,state,step_type,...extra}});
      step(0,'DONE','user_input');
      step(1,'DONE','agent_response',{usage:{input_tokens:12478,output_tokens:124,thinking_tokens:0,cache_read_tokens:0,total_tokens:12602}});
      step(2,'ACTIVE','tool',{tool_name:'read_file'});step(2,'DONE','tool',{tool_name:'read_file'});
      step(3,'ACTIVE','agent_response',{text_delta:'x'});
      step(3,'DONE','agent_response',process.env.FAKE_GENERAL_MODE==='steps'?{usage:{input_tokens:2271,output_tokens:8,thinking_tokens:0,cache_read_tokens:10424,total_tokens:2279}}:{});
    }
    const text=JSON.stringify(result);
    send({type:'message',role:'assistant',content:text.slice(0,20)});send({type:'message',role:'assistant',content:text.slice(20)});
    send({event:'result',conversation_id:'12345678-1234-1234-1234-123456789abc',result:{status:process.env.FAKE_GENERAL_MODE==='native-canceled'?'CANCELED':'SUCCESS',response:JSON.stringify(result),structured_output:result,usage:{input_tokens:3,output_tokens:5}}});
  }
  else send({type:'result',subtype:'success',structured_output:result,usage:{input_tokens:3,output_tokens:5},permission_denials:[]});
});
