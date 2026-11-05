import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
import { sourceFiles } from './router-boundaries.mjs';

const BODY='apps/body/src/';
const LINK=BODY+'live-link.ts';
const MACHINE=BODY+'machine-link.ts';
const SERVER='apps/server/src/machine-connection.ts';
const TIMER_NAMES=new Set(['setTimeout','setInterval','setImmediate','sleep']);
const member=node=>ts.isPropertyAccessExpression(node)?node.name.text:
  ts.isElementAccessExpression(node)&&ts.isStringLiteralLike(node.argumentExpression)?node.argumentExpression.text:undefined;
const name=node=>ts.isIdentifier(node)||ts.isPrivateIdentifier(node)?node.text:member(node);
function method(node){
  for(let parent=node.parent;parent;parent=parent.parent)
    if(ts.isMethodDeclaration(parent)||ts.isFunctionDeclaration(parent)||ts.isGetAccessor(parent))return name(parent.name);
}
function typeOnly(node){for(let parent=node.parent;parent;parent=parent.parent)if(ts.isTypeNode(parent))return true;return false;}

/** Capability inspection, independent of counts: the physical machine socket
 * cannot escape its connection owner. Timers have zero inventory allowance. */
export function inspectMachineConnectionSource(file,text){
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const errors=[];
  const deny=(node,reason)=>errors.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line+1}: machine connection boundary: ${reason}`);
  const timerAliases=new Set(TIMER_NAMES);
  let warmCountdownSites=0;
  const warmCountdown=node=>{
    if(file!==BODY+'agent-process.ts'||name(node.expression)!=='setTimeout'||method(node)!=='workChanged')return false;
    for(let parent=node.parent;parent;parent=parent.parent)if(ts.isClassDeclaration(parent))return parent.name?.text==='AgentProcesses';
    return false;
  };
  function visit(node){
    if(file.startsWith(BODY)){
      if(ts.isIdentifier(node)&&['setTimeout','setInterval','setImmediate'].includes(node.text)&&!typeOnly(node)&&
        !(ts.isCallExpression(node.parent)&&node.parent.expression===node&&warmCountdown(node.parent)))
        deny(node,'helper timer references and destructured aliases are forbidden');
      if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||name(node.expression)==='require')&&
        node.arguments[0]&&ts.isStringLiteralLike(node.arguments[0])&&/^(?:node:)?timers(?:\/promises)?$/.test(node.arguments[0].text))
        deny(node,'dynamic helper timer imports are forbidden');

      if(ts.isImportDeclaration(node)&&/^node:timers(?:\/promises)?$|^timers(?:\/promises)?$/.test(node.moduleSpecifier.text)&&!node.importClause?.isTypeOnly)
        deny(node,'helper timers are forbidden; use the actual completion or activity event');
      if(ts.isVariableDeclaration(node)&&node.initializer&&timerAliases.has(name(node.initializer))){
        if(ts.isIdentifier(node.name))timerAliases.add(node.name.text);
        deny(node,'helper timer aliases are forbidden');
      }
      if(ts.isCallExpression(node)&&(timerAliases.has(name(node.expression))||name(node.expression)==='timeout'&&name(node.expression.expression)==='AbortSignal')){
        // The sole product countdown: a completed agent process stays warm
        // for N minutes. No second timer is allowed, even in this method.
        if(warmCountdown(node)){if(++warmCountdownSites>1)deny(node,'AgentProcesses.workChanged may own only one stay-warm countdown');}
        else deny(node,'helper timers are forbidden; only AgentProcesses.workChanged owns the stay-warm countdown');
      }
      // Generated plugin/bridge code is executable too, not a place to hide a timer.
      if(ts.isStringLiteralLike(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node)){
        const value=ts.isTemplateExpression(node)?node.getText(source):node.text;
        if(/\b(?:setTimeout|setInterval|setImmediate)\s*\(|\bAbortSignal\s*\.\s*timeout\s*\(/.test(value))deny(node,'generated helper code contains a timer');
      }
      if(ts.isIdentifier(node)&&/^(?:reconnectNow|reconnectAfterDiscoveryFailure|reconnectAfterFailure|suspect)$/.test(node.text)&&!typeOnly(node))
        deny(node,'only actual socket close may reconnect the machine');
      if((ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node))&&member(node)==='link'&&file!==MACHINE&&
        !(ts.isBinaryExpression(node.parent)&&node.parent.operatorToken.kind===ts.SyntaxKind.EqualsEqualsEqualsToken&&node.parent.right.kind===ts.SyntaxKind.TrueKeyword)){
        const observed=member(node.parent);
        const publicView=file===BODY+'daemon-api-client.ts'&&ts.isReturnStatement(node.parent)&&method(node)==='link';
        if(!publicView&&!['state','isOpen','onOpen','reconnects'].includes(observed))deny(node,'raw machine connection cannot escape its owner');
      }
      if(ts.isImportDeclaration(node)&&node.moduleSpecifier.text.replace(/\.js$/,'').endsWith('/live-link')&&file!==MACHINE){
        const clause=node.importClause;
        if(clause&&!clause.isTypeOnly&&(clause.name||!clause.namedBindings||!ts.isNamedImports(clause.namedBindings)||
          clause.namedBindings.elements.some(item=>!item.isTypeOnly&&(item.propertyName??item.name).text==='LiveLink')))
          deny(node,'only the machine connection may construct LiveLink');
      }
      if(ts.isStringLiteralLike(node)&&node.text.includes('/v1/phone/live')&&file!==MACHINE)
        deny(node,'the machine live endpoint belongs to machine-link.ts');
      if(file===BODY+'machine-helper.ts'&&ts.isCallExpression(node)&&['send','reconnectNow','suspect'].includes(name(node.expression)))
        deny(node,'machine lifecycle may observe or stop its connection, never send or replace it');
      if(file===LINK&&ts.isCallExpression(node)&&name(node.expression)==='#connect'){
        let closeHandler=false;
        for(let parent=node.parent;parent;parent=parent.parent)
          if(ts.isBinaryExpression(parent)&&member(parent.left)==='onclose')closeHandler=true;
        if(method(node)!=='start'&&!closeHandler)deny(node,'a second connect trigger is forbidden');
      }
    }
    if(file==='apps/server/src/daemon-live.ts'&&ts.isCallExpression(node)&&['drop','evict'].includes(name(node.expression))) {
      // Only a new authenticated login supersedes an existing session. Intake,
      // provider/database failure and backpressure never revoke a machine.
      if(!['claim','#settle','evict'].includes(method(node)))deny(node,'a server request cannot drop a machine registration');
    }
    ts.forEachChild(node,visit);
  }
  visit(source);return errors;
}

/** The owner's sink counts also shrink: another close/send or constructor
 * hidden in an otherwise trusted owner file still fails CI. */
export const MACHINE_SINKS='architecture/machine-connection-sinks.json';
export function machineConnectionSites(file,text){
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),sites=new Map();
  const add=id=>sites.set(id,(sites.get(id)??0)+1);
  function visit(node){
    if(file===LINK&&ts.isNewExpression(node)&&name(node.expression)==='WebSocket')add(`${file}::${method(node)??'<module>'}::new WebSocket`);
    if([LINK,MACHINE,SERVER,'apps/server/src/server.ts'].includes(file)&&ts.isCallExpression(node)&&
      ['send','close','terminate','#connect'].includes(name(node.expression)))
      add(`${file}::${method(node)??'<module>'}::${name(node.expression)}`);
    ts.forEachChild(node,visit);
  }
  visit(source);return sites;
}
export function checkMachineConnections(root,base){
  const errors=[],sites=new Map();
  for(const file of sourceFiles(root)){
    if(!file.startsWith(BODY)&&!file.startsWith('apps/server/src/'))continue;
    const text=readFileSync(path.join(root,file),'utf8');
    errors.push(...inspectMachineConnectionSource(file,text));
    for(const [id,count] of machineConnectionSites(file,text))sites.set(id,count);
  }
  const inventory=JSON.parse(readFileSync(path.join(root,MACHINE_SINKS),'utf8'));
  let baseline;
  if(base){try{baseline=JSON.parse(execFileSync('git',['show',`${base}:${MACHINE_SINKS}`],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}));}catch{}}
  return [...errors,...judgeMachineSites(sites,inventory,baseline)];
}
export function judgeMachineSites(sites,inventory,baseline){
  const errors=[];
  for(const [id,count]of sites){
    const allowed=inventory[id];
    if(!allowed||!allowed.reason||count>allowed.count)errors.push(`machine connection boundary: ${id} has ${count} sinks; only ${allowed?.count??0} owned sinks admitted`);
  }
  for(const [id,entry]of Object.entries(inventory))
    if(!sites.has(id)||entry.count!==sites.get(id))errors.push(`machine connection boundary: remove or lower stale inventory ${id}`);
  if(baseline)for(const [id,entry]of Object.entries(inventory)){
    if(!baseline[id]||entry.count>baseline[id].count)errors.push(`machine connection boundary: inventory may only shrink: ${id}`);
  }
  return errors;
}
