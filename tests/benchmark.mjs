import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { source, url, launchFixture, launchProbe, manifestFor, until, sleep } from './fixtures.mjs';
import { browserFixture } from './browser-fixture.mjs';
const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('必须显式指定工作区内较短的测试目录');
const root = path.resolve(process.argv[2]);
if (fs.existsSync(root)) throw new Error('测试目录已存在，拒绝覆盖');
fs.mkdirSync(root, { recursive: true });
const text = source + '\n/*' + 'padding '.repeat(300000) + '*/', manifest = manifestFor(text);
const backends = [
  ...(process.env.CODEX_UNLOCK_SWIFT_BASELINE ? [['Swift', path.resolve(process.env.CODEX_UNLOCK_SWIFT_BASELINE)]] : []),
  ['Rust', path.join(tool, 'Codex Input Unlock.app/Contents/Helpers/CodexUnlockAgent')],
];
function sample(pid) {
  const [rss, cpu] = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'rss=,time='], { encoding: 'utf8' }).trim().split(/\s+/);
  return { rssMiB: +rss / 1024, cpuSeconds: cpu.split(':').map(Number).reduce((a, b) => a * 60 + b, 0) };
}
const results = [];
try {
  for (const [backend, executable] of backends) {
    const d = path.join(root, backend === 'Rust' ? 'r' : 's');
    const fixture = await launchFixture(path.join(d, 'f'), text); let probe;
    const result = { backend, payloadBytes: Buffer.byteLength(text) };
    try {
      probe = await launchProbe(path.join(d, 'i'), fixture.ws, manifest, [], executable);
      await until(() => probe.state().state === 'ready' || probe.child.exitCode !== null);
      if (probe.state().state !== 'ready') throw new Error(probe.errors());
      await sleep(1500); const first = sample(probe.child.pid), readings = [first], began = Date.now();
      for (let i = 0; i < 5; i++) { await sleep(2000); readings.push(sample(probe.child.pid)); }
      const last = readings.at(-1), duration = (Date.now() - began) / 1000;
      Object.assign(result, { idleSeconds: duration, rssMiB: +last.rssMiB.toFixed(2), rssRangeMiB: [Math.min(...readings.map(x => x.rssMiB)), Math.max(...readings.map(x => x.rssMiB))].map(x => +x.toFixed(2)), idleCPUSeconds: +(last.cpuSeconds - first.cpuSeconds).toFixed(3) });
    } finally { await probe?.stop(); await fixture.stop(); }
    const browser = await browserFixture(text, url); probe = undefined;
    try {
      probe = await launchProbe(path.join(d, 'a'), browser.ws, manifest, ['--browser'], executable);
      await until(() => probe.state().state === 'ready' || probe.child.exitCode !== null);
      if (probe.state().state !== 'ready') throw new Error(probe.errors());
      const first = sample(probe.child.pid), began = Date.now();
      for (let i = 0; i < 20; i++) {
        browser.event('Runtime.executionContextsCleared', {}, 's-one');
        browser.event('Debugger.scriptParsed', { scriptId: String(i + 2), url }, 's-one');
        await until(() => browser.requests.filter(x => x.method === 'Debugger.setBreakpoint').length >= i + 2 && probe.state().state === 'ready');
      }
      const last = sample(probe.child.pid);
      Object.assign(result, { reloadCount: 20, reloadWallSeconds: +((Date.now() - began) / 1000).toFixed(3), reloadCPUSeconds: +(last.cpuSeconds - first.cpuSeconds).toFixed(3), rssAfterReloadMiB: +last.rssMiB.toFixed(2) });
    } finally { await probe?.stop(); await browser.close(); }
    results.push(result); console.log(JSON.stringify(result));
  }
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(results, null, 2) + '\n');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
