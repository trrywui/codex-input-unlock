import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { source, url, launchProbe, until, manifestFor, sleep } from './fixtures.mjs';
import { browserFixture } from './browser-fixture.mjs';
if (!process.env.CODEX_UNLOCK_TEST_ROOT) throw new Error('必须显式指定工作区测试目录');
const root = path.resolve(process.env.CODEX_UNLOCK_TEST_ROOT), created = !fs.existsSync(root);
fs.mkdirSync(root, { recursive: true }); const scratch = fs.mkdtempSync(path.join(root, 'r-')); let seq = 0;
const directory = () => path.join(scratch, String(++seq));
test.after(() => { fs.rmSync(scratch, { recursive: true, force: true }); if (created) { try { fs.rmdirSync(root); } catch {} } });
test('只允许回环 CDP；不连接远程主机', async () => {
  const probe = await launchProbe(directory(), 'ws://example.com:1234/page');
  try { await until(() => probe.child.exitCode !== null); assert.equal(probe.state().state, 'failed'); assert.match(probe.state().error, /回环/); }
  finally { await probe.stop(); }
});
test('WebSocket 分片和 Ping/Pong；控制令牌错误不能停止；断点位置失效时退出', async () => {
  const browser = await browserFixture(source, url, { fragmented: true }); let probe;
  try {
    probe = await launchProbe(directory(), browser.ws, manifestFor(), ['--browser']);
    await until(() => probe.state().state === 'ready');
    await until(() => browser.pongCount() > 0);
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(path.join(probe.data, 'control.sock'), () => socket.end(JSON.stringify({ token: 'wrong', command: 'stop' }) + '\n'));
      socket.on('close', resolve); socket.on('error', reject);
    });
    await sleep(80); assert.equal(probe.child.exitCode, null); assert.equal(probe.state().state, 'ready');
    browser.mode.noBreakpoints = true;
    browser.event('Runtime.executionContextsCleared', {}, 's-one');
    browser.event('Debugger.scriptParsed', { scriptId: '2', url }, 's-one');
    await until(() => probe.child.exitCode !== null);
    assert.equal(probe.state().state, 'failed'); assert.match(probe.state().error, /没有可执行断点/);
  } finally { await probe?.stop(); await browser.close(); }
});
test('对方不响应清理命令时，停止也会在有界时间内完成', async () => {
  const browser = await browserFixture(source, url); let probe;
  try {
    probe = await launchProbe(directory(), browser.ws, manifestFor(), ['--browser']); await until(() => probe.state().state === 'ready');
    browser.mode.ignoreCleanup = true; const start = Date.now(); await probe.stop();
    assert.ok(Date.now() - start < 4000); assert.equal(probe.state().state, 'stopped');
  } finally { await probe?.stop(); await browser.close(); }
});
