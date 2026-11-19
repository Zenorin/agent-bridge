import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProfiles, resolveProfile, planRuntime, verifyRuntime, runtimeFlags, projectFields, taskPacket, replyPacket } from '../profiles.mjs';

const hook={key:'keep',pluginId:'required@test',enabled:true,currentHash:'sha256:a',trustStatus:'trusted'};
const runtime={plugins:{'required@test':{enabled:true},'extra@test':{enabled:true},'wanted@test':{enabled:true}},hooks:[hook],errors:[]};
test('프로필은 기존 활성 훅과 필수 플러그인을 보존하고 선택한 옵션만 바꾼다',()=>{
 const cfg={required_plugins:['required@test'],profiles:{review:{plugins:['wanted@test'],input_fields:['goal'],output_fields:['summary']}}};
 const p=resolveProfile(cfg,'review'); const plan=planRuntime(p,runtime);
 assert.equal(plan.overrides['plugins."required@test".enabled'],true);
 assert.equal(plan.overrides['plugins."wanted@test".enabled'],true);
 assert.equal(plan.overrides['plugins."extra@test".enabled'],false);
 assert.ok(!Object.keys(plan.overrides).some(k=>k.startsWith('hooks.')));
 const applied={...runtime,plugins:{...runtime.plugins,'extra@test':{enabled:false}}};
 assert.equal(verifyRuntime(plan,applied).config_verified,true);
 assert.throws(()=>verifyRuntime(plan,{...applied,hooks:[]}),/hook/i);
 assert.throws(()=>verifyRuntime(plan,{...applied,hooks:[{...hook,currentHash:'changed'}]}),/hook/i);
 assert.throws(()=>verifyRuntime(plan,runtime),/plugin/i);
});

test('CLI 설정은 따옴표·점을 포함한 플러그인과 훅 이름을 값 안에서 보존한다',()=>{
 const plan={overrides:{'plugins."a.b@test".enabled':false,'hooks.state."hook.a".enabled':true}};
 assert.deepEqual(runtimeFlags(plan),['-c','plugins={ "a.b@test" = { enabled = false } }','-c','hooks.state={ "hook.a" = { enabled = true } }']);
});

test('프로필 codex_config는 호출 맥락을 줄이는 허용 설정만 CLI로 넘기고 적용 여부를 확인한다',()=>{
 const lean={plugins:[],input_fields:[],output_fields:[],codex_config:{project_doc_max_bytes:0,'skills.include_instructions':false}};
 const plan=planRuntime(resolveProfile({required_plugins:[],profiles:{lean}},'lean'),{plugins:{},hooks:[],errors:[]});
 assert.deepEqual(runtimeFlags(plan),['-c','project_doc_max_bytes=0','-c','skills.include_instructions=false']);
 const applied={plugins:{},hooks:[],errors:[],config:{project_doc_max_bytes:0,skills:{include_instructions:false}}};
 assert.equal(verifyRuntime(plan,applied).config_verified,true);
 assert.throws(()=>verifyRuntime(plan,{...applied,config:{project_doc_max_bytes:32768}}),/codex config override not applied: project_doc_max_bytes/);
 for(const codex_config of [{sandbox_mode:'danger-full-access'},{project_doc_max_bytes:-1},{'skills.include_instructions':'no'},[]])
  assert.throws(()=>resolveProfile({required_plugins:[],profiles:{lean:{...lean,codex_config}}},'lean'),/invalid profile codex_config/);
});

test('선택 훅만 끌 수 있으며 다시 켤 때 해당 플러그인도 켠다',()=>{
 const config={required_plugins:['required@test'],optional_hooks:['optional','keep'],profiles:{x:{plugins:[],input_fields:[],output_fields:[],hooks:{optional:true}}}};
 const baseline={...runtime,hooks:[hook,{key:'optional',pluginId:'extra@test',enabled:false}]};
 const plan=planRuntime(resolveProfile(config,'x'),baseline);
 assert.equal(plan.overrides['plugins."extra@test".enabled'],true);
 assert.equal(plan.overrides['hooks.state."optional".enabled'],true);
 config.profiles.x.hooks={keep:false};
 assert.throws(()=>planRuntime(resolveProfile(config,'x'),baseline),/required hook/);
 config.profiles.x.hooks={optional:false};
 const optionalPlan=planRuntime(resolveProfile(config,'x'),baseline);
 const applied={...baseline,plugins:{'required@test':{enabled:true},'extra@test':{enabled:false},'wanted@test':{enabled:false}}};
 assert.equal(verifyRuntime(optionalPlan,applied).config_verified,true);
 assert.throws(()=>verifyRuntime(optionalPlan,{...applied,hooks:[hook,{key:'optional',enabled:true}]}),/hook override/);
 assert.throws(()=>planRuntime(resolveProfile(config,'x'),{...baseline,hooks:[hook,{key:'optional',enabled:false,isManaged:true}]}),/required hook/);
});
test('프로필 필드 선택은 허용 필드만 복사하며 필수 작업 의미와 실패 근거를 보존한다',()=>{
 const p=resolveProfile({required_plugins:[],profiles:{x:{plugins:'*',input_fields:[],output_fields:['summary']}}},'x');
 const task={goal:'check',acceptance:['test'],write_files:[],sandbox:'read-only',secret:'do not send',short_summary:'optional'};
 assert.deepEqual(taskPacket(task,p),{goal:'check',acceptance:['test'],write_files:[],sandbox:'read-only'});
 const out=replyPacket({status:'failed',summary:'bad',question:null,acceptance:[{result:'fail'}],changed_files:{},raw:'secret'},p);
 assert.equal(out.raw,undefined); assert.equal(out.status,'failed'); assert.equal(out.acceptance[0].result,'fail');
 assert.deepEqual(projectFields({brief:{title:'a',secret:'b'},secret:'c'},['brief.title']),{brief:{title:'a'}});
 assert.throws(()=>projectFields({},['__proto__.x']),/field/i);
});
test('기본 프로필과 잘못된 설정을 검증한다',()=>{
 const cfg=loadProfiles();
 for(const id of ['standard','review','code','document']) assert.equal(resolveProfile(cfg,id).id,id);
 assert.deepEqual(resolveProfile(cfg,'light').codex_config,{project_doc_max_bytes:0,'skills.include_instructions':false});
 for(const id of ['standard','review','code','document','image']) assert.equal(resolveProfile(cfg,id).codex_config,undefined);
 assert.throws(()=>resolveProfile(cfg,'missing'),/profile/i);
 assert.throws(()=>resolveProfile({required_plugins:[],profiles:{x:{plugins:[],input_fields:['not_allowed'],output_fields:[]}}},'x'),/field/i);
});


test('image profile inherits the default Codex home and authentication', () => {
  assert.equal(resolveProfile(loadProfiles(), 'image').env?.CODEX_HOME, undefined);
});
