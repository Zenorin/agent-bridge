import {readdirSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,lstatSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function buildRelease(source,output,{node=process.execPath}={}) {
 if(process.platform!=='win32')throw new Error('This builder packages the Windows x64 runtime');
 const probe=spawnSync(node,['-p','JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'],{encoding:'utf8',windowsHide:true});
 if(probe.status!==0)throw new Error('Node runtime probe failed');
 const runtime=JSON.parse(probe.stdout);
 if(runtime.platform!=='win32'||runtime.arch!=='x64')throw new Error('A Windows x64 Node runtime is required');
 const [major,minor]=runtime.version.slice(1).split('.').map(Number);
 if(major<22||(major===22&&minor<13))throw new Error('Node 22.13 or newer is required');
 const license=path.join(path.dirname(node),'LICENSE');
 if(!existsSync(license))throw new Error('Node LICENSE must accompany the runtime');
 const root=path.join(path.resolve(output),'agent-bridge-win-x64'),zip=root+'.zip';
 if(existsSync(root)||existsSync(zip))throw new Error('Release output already exists; select a new output directory');
 mkdirSync(root,{recursive:true});mkdirSync(path.join(root,'app'));mkdirSync(path.join(root,'runtime'));
 const modules=readdirSync(source).filter(file=>file.endsWith('.mjs')&&file!=='build-release.mjs');
 const files=[...modules,'profiles.json','templates.json','distribution-text.ko.json',
  ...['app.js','index.html','style.css','copy.ko.json'].map(file=>'ui/'+file),'programs/check-files.mjs',
  '__tests__/portable.test.mjs','__tests__/connection-check.test.mjs','__tests__/fixtures/fake-app-server.mjs','__tests__/fixtures/fake-general-cli.mjs','__tests__/fixtures/fake-connection-cli.mjs','__tests__/fixtures/gemini-auth.mjs'];
 for(const file of files){
  const from=path.join(source,file),to=path.join(root,'app',file);
  if(!lstatSync(from).isFile()||lstatSync(from).isSymbolicLink())throw new Error('Release input must be a regular file: '+file);
  mkdirSync(path.dirname(to),{recursive:true});copyFileSync(from,to);
 }
 copyFileSync(node,path.join(root,'runtime','node.exe'));copyFileSync(license,path.join(root,'runtime','Node-LICENSE.txt'));
 if(existsSync(path.join(source,'LICENSE')))copyFileSync(path.join(source,'LICENSE'),path.join(root,'LICENSE.txt'));
 writeFileSync(path.join(root,'agent-bridge.cmd'),'@echo off\r\nsetlocal\r\n"%~dp0runtime\\node.exe" "%~dp0app\\portable.mjs" %*\r\n');
 writeFileSync(path.join(root,'Start Dashboard.cmd'),'@echo off\r\ncall "%~dp0agent-bridge.cmd" serve %*\r\nif errorlevel 1 pause\r\n');
 writeFileSync(path.join(root,'Self Test.cmd'),'@echo off\r\n"%~dp0runtime\\node.exe" --test "%~dp0app\\__tests__\\portable.test.mjs" "%~dp0app\\__tests__\\connection-check.test.mjs"\r\npause\r\n');
 writeFileSync(path.join(root,'Check Connections.cmd'),'@echo off\r\nsetlocal\r\ncall "%~dp0agent-bridge.cmd" check-connections\r\nset "BRIDGE_CHECK_EXIT=%ERRORLEVEL%"\r\npause\r\nexit /b %BRIDGE_CHECK_EXIT%\r\n');
 const text=JSON.parse(readFileSync(path.join(source,'distribution-text.ko.json'),'utf8'));
 writeFileSync(path.join(root,'QUICKSTART.ko.md'),text.quickStartMarkdown);
 const hashes={};
 function hashTree(dir,relative=''){
  for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   const rel=relative+entry.name,absolute=path.join(dir,entry.name);
   if(entry.isDirectory())hashTree(absolute,rel+'/');
   else hashes[rel]=createHash('sha256').update(readFileSync(absolute)).digest('hex');
  }
 }
 hashTree(root);
 const manifest={name:'agent-bridge',version:'0.1.0',platform:'win32',arch:'x64',runtime,files:hashes};
 writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2));
 const packed=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Compress-Archive -LiteralPath $env:BRIDGE_RELEASE_FOLDER -DestinationPath $env:BRIDGE_RELEASE_ZIP'],
  {env:{...process.env,BRIDGE_RELEASE_FOLDER:root,BRIDGE_RELEASE_ZIP:zip},encoding:'utf8',windowsHide:true});
 if(packed.status!==0)throw new Error('ZIP creation failed: '+(packed.stderr||packed.error?.message||packed.status));
 const sha256=createHash('sha256').update(readFileSync(zip)).digest('hex');
 writeFileSync(zip+'.sha256',sha256+'  '+path.basename(zip)+'\n');
 return {zip,sha256,files:Object.keys(hashes).length,runtime};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const [source,output]=process.argv.slice(2);
 if(!source||!output){console.error('Usage: node build-release.mjs <clean bridge source directory> <new output directory>');process.exitCode=1;}
 else try{console.log(JSON.stringify(buildRelease(path.resolve(source),path.resolve(output))));}catch(error){console.error(error.message);process.exitCode=1;}
}
