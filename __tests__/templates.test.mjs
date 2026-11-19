import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTemplates, expandTemplate } from '../templates.mjs';

const templates = { t: { cwd: 'C:/stage', write_files: ['{{out}}'], goal: 'make {{out}} from "{{prompt}}"', profile: 'light' } };

test('템플릿은 변수를 채우고 봉투에 준 필드가 템플릿 값보다 우선한다',()=>{
 const task=expandTemplate({message_id:'m',template:'t',vars:{out:'a.png',prompt:'p'},profile:'code'},templates);
 assert.deepEqual(task.write_files,['a.png']);
 assert.equal(task.goal,'make a.png from "p"');
 assert.equal(task.profile,'code');
 assert.equal(task.cwd,'C:/stage');
 assert.ok(!('template' in task) && !('vars' in task));
});

test('템플릿이 없는 봉투는 그대로 둔다',()=>{
 const input={message_id:'m',goal:'g'};
 assert.equal(expandTemplate(input,templates),input);
});

test('없는 템플릿, 빠진 변수, 쓰지 않은 변수는 거부한다',()=>{
 assert.throws(()=>expandTemplate({template:'none'},templates),/unknown template/);
 assert.throws(()=>expandTemplate({template:'t',vars:{out:'a.png'}},templates),/missing: prompt/);
 assert.throws(()=>expandTemplate({template:'t',vars:{out:'a.png',prompt:'p',typo:'x'}},templates),/unused template variable: typo/);
});

test('기본 이미지 템플릿은 저장소 밖 작업 폴더와 image 프로필로 펼쳐진다',()=>{
 const task=expandTemplate({message_id:'m',task_id:'IMG',template:'image-photo',vars:{out:'x.png',prompt:'a cat',work_dir:'C:/stage'}},loadTemplates());
 assert.equal(task.cwd,'C:/stage');
 assert.deepEqual(task.write_files,['x.png']);
 assert.equal(task.profile,'image');
 assert.match(task.goal,/"hyper realistic a cat"/);
 assert.ok(!task.goal.includes('{{'));
});
