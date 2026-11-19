import test from 'node:test';
import assert from 'node:assert/strict';
import { callAdapter } from '../adapters.mjs';
test('어댑터는 선택한 입력만 보내고 필요한 결과와 오류 정보를 반환한다',async()=>{
 const config={required_plugins:[],profiles:{x:{plugins:'*',input_fields:[],output_fields:[],adapters:['echo']}},adapters:{echo:{command:process.execPath,args:['-e',"let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{console.log(JSON.stringify({value:JSON.parse(s),private:'omit'}))})"],input_fields:['brief.title'],output_fields:['value']}}};
 const result=await callAdapter(config,'x','echo',{brief:{title:'yes',secret:'no'},control:'no'});
 assert.deepEqual(result.output,{value:{brief:{title:'yes'}}});
 assert.deepEqual(result.omitted_output_fields,['private']);
 assert.equal(result.full_output.private,'omit');
 await assert.rejects(callAdapter(config,'x','missing',{}),/adapter/i);
});
