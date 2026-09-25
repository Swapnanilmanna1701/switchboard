"use strict";
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync, execSync } = require('node:child_process');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-global-test-')));
const home = path.join(root, 'home');
fs.mkdirSync(home, {recursive:true});
process.env.SWITCHBOARD_HOME = home;
const G = require('../src/global-installers');
const W = require('../src/workspace');
const C = require('../src/core');
const { Store } = require('../src/store');
const opts = {home, env:{}};
const cli = path.resolve(__dirname, '../bin/switchboard.js');
const env = {...process.env, HOME:home, USERPROFILE:home, SWITCHBOARD_HOME:home,
  CODEX_HOME:path.join(home,'.codex'), CLAUDE_CONFIG_DIR:path.join(home,'.claude')};
const folder = name => {const p=path.join(root,name);fs.mkdirSync(p,{recursive:true});return p;};
const json = p => JSON.parse(fs.readFileSync(p,'utf8'));
const writeJson = (p,value) => {fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(value));};
const peers=[];
after(async () => {await Promise.all(peers.map(p=>p.stop())); fs.rmSync(root,{recursive:true,force:true});});

function client(agent,cwd) {
  const child=spawn(process.execPath,[path.resolve(__dirname,'../bin/switchboard-mcp.js')],{cwd,env,stdio:['pipe','pipe','pipe']});
  let seq=0, buf='', errors=''; const waiting=new Map();
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.stderr.on('data',d=>errors+=d);
  child.on('error',err=>{for(const v of waiting.values())v.reject(err);});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buf+=chunk; let n;
    while((n=buf.indexOf('\n'))>=0){
      const line=buf.slice(0,n);buf=buf.slice(n+1);if(!line.trim())continue;
      const msg=JSON.parse(line), p=waiting.get(msg.id);if(!p)continue;
      waiting.delete(msg.id);clearTimeout(p.timer);
      msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);
    }
  });
  const request=(method,params)=>new Promise((resolve,reject)=>{
    const id=++seq;
    const timer=setTimeout(()=>{waiting.delete(id);reject(new Error(`Timeout: ${method}; ${errors}`));},5000);
    waiting.set(id,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  const c={request, init:()=>request('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:agent,version:'test'},capabilities:{}}),
    call:async(name,args={})=>(await request('tools/call',{name,arguments:args})).content[0].text,
    stop:async()=>{if(child.exitCode!==null)return;child.stdin.end();await exited;}};
  peers.push(c);return c;
}

test('global setup preserves settings, is idempotent, and restores managed values',()=>{
  const claude=path.join(home,'.claude.json'), codex=path.join(home,'.codex/config.toml');
  const old={command:'prior-command',args:['old']};
  writeJson(claude,{oauthAccount:{keep:true},mcpServers:{other:{command:'other'},switchboard:old}});
  fs.mkdirSync(path.dirname(codex),{recursive:true});
  fs.writeFileSync(codex,'model = "keep-model"\n[mcp_servers.other]\ncommand = "other"\n');
  const settings=path.join(home,'.claude/settings.json');
  writeJson(settings,{permissions:{allow:['Read']},hooks:{Stop:[{hooks:[{type:'command',command:'echo existing'}]}]}});
  const before=fs.readFileSync(claude,'utf8');G.plan(opts);assert.equal(fs.readFileSync(claude,'utf8'),before);
  assert.ok(G.apply(opts).written.length>0);assert.equal(G.apply(opts).written.length,0);
  assert.deepEqual(json(claude).oauthAccount,{keep:true});assert.equal(json(claude).mcpServers.other.command,'other');
  assert.ok(fs.readFileSync(codex,'utf8').includes('keep-model'));
  assert.equal(json(settings).hooks.Stop.length,2);
  // A new user hook and instruction added after installation survive uninstall.
  const cfg=json(settings);cfg.hooks.Stop.push({hooks:[{type:'command',command:'echo later'}]});writeJson(settings,cfg);
  fs.appendFileSync(path.join(home,'.codex/AGENTS.md'),'\nUser instructions added later.\n');
  const result=G.revert(opts);assert.equal(result.skipped.length,0);
  assert.deepEqual(json(claude).mcpServers.switchboard,old);
  assert.equal(json(settings).hooks.Stop.length,2);
  assert.ok(fs.readFileSync(path.join(home,'.codex/AGENTS.md'),'utf8').includes('User instructions added later.'));
  assert.equal(W.globalEnabled(),false);
  G.apply(opts);
});

test('malformed global JSON fails without discarding settings',()=>{
  const h=folder('bad-home');fs.writeFileSync(path.join(h,'.claude.json'),'{broken');
  assert.throws(()=>G.apply({home:h,env:{}}));
  assert.equal(fs.readFileSync(path.join(h,'.claude.json'),'utf8'),'{broken');
  assert.equal(fs.existsSync(path.join(h,'.codex/config.toml')),false);
});

test('outside directories share a private store while nested Git roots stay isolated',()=>{
  const a=folder('ordinary-a'),b=folder('ordinary-b'),repo=folder('repo');
  fs.mkdirSync(path.join(repo,'.git'));const sub=path.join(repo,'sub');fs.mkdirSync(sub);
  assert.equal(W.resolveWorkspace(a),W.resolveWorkspace(b));
  assert.equal(W.resolveWorkspace(a),W.terminalWorkspace());
  assert.equal(W.storePath(W.terminalWorkspace()),path.join(home,'.switchboard/terminals/state.db'));
  assert.equal(W.resolveWorkspace(sub),repo);
  assert.equal(fs.existsSync(path.join(a,'.switchboard')),false);
  const linked=folder('linked-worktree');fs.writeFileSync(path.join(linked,'.git'),'gitdir: /unused');
  assert.equal(W.resolveWorkspace(linked),linked);
});

test('real MCP processes: Claude and Codex discover, attach, message, claim and disconnect across ordinary folders',async()=>{
  const a=folder('terminal-a'),b=folder('terminal-b'),repo=folder('isolated-repo');fs.mkdirSync(path.join(repo,'.git'));
  const claude=client('Claude Code',a),codex=client('Codex CLI',b),isolated=client('isolated-client',repo);
  await claude.init();const init=await codex.init();await isolated.init();
  assert.match(init.instructions,/local terminals/);
  assert.match(await claude.call('sb_name',{task:'review terminal notes'}),/review-terminal-notes/);assert.match(await codex.call('sb_name',{task:'prepare terminal reply'}),/prepare-terminal-reply/);
  await isolated.call('sb_name',{task:'isolated repository work'});
  const listing=await codex.call('sb_peers');assert.match(listing,/review-terminal-notes/);assert.doesNotMatch(listing,/isolated-repository-work/);
  await claude.call('sb_note',{text:'The shared terminal finding is ready.'});
  const attached=await codex.call('sb_attach',{name:'review-terminal-notes'});
  assert.match(attached,/shared terminal finding/);assert.ok(attached.includes(a));assert.match(attached,/STILL RUNNING/);
  await codex.call('sb_message',{target:'review-terminal-notes',text:'Please review my terminal result.'});
  assert.match(await claude.call('sb_inbox'),/Please review/);assert.match(await claude.call('sb_inbox'),/No unread/);
  await claude.call('sb_message',{target:'prepare-terminal-reply',text:'Reviewed your result.'});
  assert.match(await codex.call('sb_inbox'),/Reviewed your result/);
  assert.match(await isolated.call('sb_inbox'),/No unread/);
  await claude.call('sb_claim',{paths:['notes.txt']});
  const store=new Store(W.storePath(W.terminalWorkspace()));
  assert.equal(store._get('SELECT path FROM claims').path,path.join(a,'notes.txt'));store.close();
  await claude.call('sb_release',{paths:['notes.txt']});
  assert.match(await codex.call('sb_diff',{name:'review-terminal-notes'}),/outside Git/);
  await claude.stop();assert.doesNotMatch(await codex.call('sb_peers'),/Exact session name: review-terminal-notes/);
  await codex.stop();await isolated.stop();
});

test('Claude global hooks and MCP share one identity in either startup order', async()=>{
  const hook=(cwd,id,event,prompt)=>execSync(json(path.join(home,'.claude/settings.json')).hooks[event]
    .flatMap(group=>group.hooks).find(h=>h.command.endsWith(' --global')).command,{
    cwd,env,encoding:'utf8',input:JSON.stringify({session_id:id,cwd,hook_event_name:event,prompt})});
  for(const first of ['hook','mcp']) {
    const cwd=folder(`identity-${first}`), id=`native-${first}`;
    if(first==='hook')hook(cwd,id,'SessionStart');
    const claude=client('Claude Code',cwd);await claude.init();
    if(first==='mcp')hook(cwd,id,'SessionStart');
    hook(cwd,id,'UserPromptSubmit',`inspect ${first} terminal`);
    const store=new Store(W.storePath(W.terminalWorkspace()));
    const rows=store._all("SELECT * FROM sessions WHERE cwd=? AND status!='ended'",cwd);
    assert.equal(rows.length,1);
    assert.match(await claude.call('sb_name',{task:'unrelated later task'}),new RegExp(`inspect-${first}-terminal`));
    assert.doesNotMatch(await claude.call('sb_peers'),new RegExp(`Exact session name: inspect-${first}-terminal`));
    store.close();await claude.stop();
  }
});

test('queued context reaches an MCP-only terminal once', async()=>{
  const ws=W.terminalWorkspace(),store=new Store(W.storePath(ws));
  store.upsertSession({session_id:'queue-source',name:'queue-source',named:1,workspace:ws,cwd:home,agent_pid:process.pid});
  store.addNote({session_id:'queue-source',workspace:ws,text:'Context queued for a Codex terminal.'});
  store.queueAttach({workspace:ws,target_id:'queue-source',target_name:'queue-source',ttlMs:60000});
  const one=client('Codex CLI',folder('queued-one'));
  assert.match((await one.init()).instructions,/Context queued for a Codex terminal/);
  const two=client('Codex CLI',folder('queued-two'));
  assert.doesNotMatch((await two.init()).instructions,/Context queued for a Codex terminal/);
  store.endSession('queue-source');store.close();await one.stop();await two.stop();
});

test('several processes can initialize a new SQLite store at the same time', async()=>{
  const db=path.join(folder('fresh-store'),'state.db');
  const modulePath=path.resolve(__dirname,'../src/store.js');
  const results=await Promise.all(Array.from({length:6},()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-e',`const {Store}=require(${JSON.stringify(modulePath)}); const s=new Store(${JSON.stringify(db)});if(!s.ok){console.error(s.error);process.exitCode=1;}s.close();`],{env});
    let err='';child.stderr.on('data',d=>err+=d);child.once('error',reject);child.once('exit',code=>resolve({code,err}));
  })));
  for(const r of results)assert.equal(r.code,0,r.err);
});

test('global hooks keep refreshing peer context after five prompts',()=>{
  const H=require('../src/hook'), ws=W.terminalWorkspace(), cwd=folder('prompt-test');
  const store=new Store(W.storePath(ws));
  store.upsertSession({session_id:'refresh-peer',name:'refresh-peer',named:1,workspace:ws,cwd:home,agent:'other',agent_pid:process.pid});
  H.handle({session_id:'prompt-session',cwd,hook_event_name:'SessionStart'});
  let updates=0;
  for(let i=0;i<10;i++)if(H.handle({session_id:'prompt-session',cwd,hook_event_name:'UserPromptSubmit',prompt:'inspect refresh behavior'}).output)updates++;
  assert.equal(updates,2);
  H.handle({session_id:'prompt-session',cwd,hook_event_name:'SessionEnd'});store.endSession('refresh-peer');store.close();
});

test('MCP task names do not persist a recognizable API key',async()=>{
  const c=client('Codex CLI',folder('redaction'));await c.init();
  const secret='sk-'+'a'.repeat(24);await c.call('sb_name',{task:'inspect '+secret});
  const store=new Store(W.storePath(W.terminalWorkspace()));
  const row=store._get('SELECT name,intent FROM sessions WHERE cwd=?',path.join(root,'redaction'));
  assert.ok(!JSON.stringify(row).includes(secret));store.close();await c.stop();
});

test('global CLI works from ordinary directories, supports dry-run, custom homes and uninstall',()=>{
  const h=folder('cli-home'),cwd=folder('cli-cwd');
  const e={...env,HOME:h,USERPROFILE:h,SWITCHBOARD_HOME:h,CODEX_HOME:path.join(h,'custom-codex'),CLAUDE_CONFIG_DIR:path.join(h,'custom-claude')};
  const run=(...args)=>execFileSync(process.execPath,[cli,...args],{cwd,env:e,encoding:'utf8'});
  assert.match(run('init','--global','--dry-run'),/nothing written/);assert.equal(fs.existsSync(path.join(h,'custom-codex')),false);
  assert.match(run(),/Restart Claude and Codex/);
  assert.ok(json(path.join(h,'custom-claude/.claude.json')).mcpServers.switchboard);
  assert.ok(fs.existsSync(path.join(h,'custom-codex/config.toml')));
  assert.match(run('doctor','--global'),/Global setup is ready/);
  assert.match(run('status','--global'),/No local terminal sessions/);
  assert.equal(fs.existsSync(path.join(cwd,'.mcp.json')),false);
  assert.match(run('uninstall','--global'),/Restored/);
  assert.equal(json(path.join(h,'.switchboard/global.json')).terminalSharing,undefined);
});

test('handoff liveness and ambiguous prefixes stay safe in the shared terminal group',()=>{
  const ws=W.terminalWorkspace(),store=new Store(W.storePath(ws));
  for(const [id,name] of [['a','review-auth'],['b','review-api']])store.upsertSession({session_id:id,name,named:1,workspace:ws,cwd:home,agent_pid:process.pid});
  store._run('UPDATE sessions SET last_seen=? WHERE session_id=?',Date.now()-180000,'a');
  assert.equal(C.attachContext(store,ws,'a').session.live,true);
  assert.equal(C.findTarget(store,ws,'review',null),null);
  assert.equal(C.findTarget(store,ws,'review-auth',null).session_id,'a');
  store.close();
});
