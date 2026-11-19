#!/usr/bin/env node
import path from 'node:path';
import {hashFile} from '../store.mjs';
import {receiptFor,verifyWire} from '../contracts.mjs';
let text='';
for await (const chunk of process.stdin)text+=chunk;
const task=JSON.parse(text),files=task.file_refs.map(ref=>({path:ref.path,expected:ref.hash,actual:hashFile(task.cwd,ref.path)}));
if(task.contract)verifyWire(task,task);
const valid=files.length>0&&files.every(file=>file.actual&&(!file.expected||file.actual===file.expected));
const acceptance=task.acceptance.map(criterion=>({criterion,
  result:criterion==='모든 참조 파일이 존재하고 요청된 해시와 일치한다.'?(valid?'pass':'fail'):'unverified',
  evidence:criterion==='모든 참조 파일이 존재하고 요청된 해시와 일치한다.'?JSON.stringify(files):'파일 검사 프로그램으로 이 조건의 충족 여부를 판정할 수 없습니다.'}));
process.stdout.write(JSON.stringify({status:valid?'done':'failed',summary:`파일 ${files.length}개 검사: ${valid?'일치':'누락 또는 불일치'}`,question:null,acceptance,changed_files:[],
  ...(task.contract?{contract_receipt:receiptFor(task,task.contract_environment,acceptance)}:{})}));
