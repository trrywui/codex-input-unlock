import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

export const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const helper = process.env.CODEX_UNLOCK_HELPER ? path.resolve(process.env.CODEX_UNLOCK_HELPER) : path.join(tool, 'Codex Input Unlock.app/Contents/Helpers/CodexUnlockAgentRust');
const require = createRequire(import.meta.url);
export const oldGate = require('./reference/quota-gate.cjs');
export const sha = value => createHash('sha256').update(value).digest('hex');
export const source = '(()=>{const K={},A={},B={};function Xl(){return {}}let XP=Xl(K,({get:e})=>{let t=e(A),n=e(B);if(t.authMethod!==`chatgpt`||n.rate_limit?.allowed!==!1)return!1;return!0});let quota=true;function X(v){return v?quota:false}function render({busy=false,empty=false}={}){let bt=`local`,vn=X(bt===`local`&&XP);let Zn=busy||empty||vn,Qn;return {submitDisabled:Zn}}return {render}})()';
export const url = 'app://-/assets/fixture.js';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const command = (action, ...args) => execFileSync(helper, [action, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const jsonCommand = (action, ...args) => JSON.parse(command(action, ...args));
export async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error('测试等待超时'); await sleep(25); }
}
export function manifestFor(text = source) {
  const location = oldGate.locate(text, url);
  return { url, location, condition: oldGate.condition(location), bundleSha256: sha(text) };
}
export async function launchProbe(directory, ws, manifest = manifestFor(), extra = [], executable = helper) {
  directory = path.resolve(directory);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'manifest-input.json'); fs.writeFileSync(file, JSON.stringify(manifest));
  const data = path.join(directory, 'd');
  const child = spawn(executable, ['probe', '--ws', ws, '--manifest', file, '--data-dir', data, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  const state = () => {
    try { return JSON.parse(fs.readFileSync(path.join(data, 'state.json'))); } catch { return {}; }
  };
  return { child, data, state, errors: () => errors, async stop() {
    if (child.exitCode === null && child.signalCode === null) {
      try { execFileSync(executable, ['stop', '--data-dir', data], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { child.kill('SIGTERM'); }
      try { await until(() => child.exitCode !== null || child.signalCode !== null, 4000); }
      catch { child.kill('SIGKILL'); await until(() => child.exitCode !== null || child.signalCode !== null, 2000); }
    }
  } };
}
export async function launchFixture(directory, text = source) {
  directory = path.resolve(directory);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'fixture.cjs');
  fs.writeFileSync(file, `const vm=require('node:vm');globalThis.fixture=vm.runInThisContext(${JSON.stringify(text)},{filename:${JSON.stringify(url)}});setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', file], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  await until(() => /ws:\/\/127\.0\.0\.1:\d+\/\S+/.test(stderr) || child.exitCode !== null);
  const ws = /ws:\/\/127\.0\.0\.1:\d+\/\S+/.exec(stderr)?.[0];
  if (!ws) throw new Error(stderr);
  return { child, ws, async stop() { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null); } } };
}
