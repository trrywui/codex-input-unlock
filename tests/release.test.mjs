import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tool, helper, source, url, launchProbe, manifestFor, until } from './fixtures.mjs';
import { browserFixture } from './browser-fixture.mjs';

if (!process.env.CODEX_UNLOCK_TEST_ROOT) throw new Error('必须显式指定工作区测试目录');
const root = path.resolve(process.env.CODEX_UNLOCK_TEST_ROOT), created = !fs.existsSync(root);
fs.mkdirSync(root, { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, 'v-'));
test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  if (created) { try { fs.rmdirSync(root); } catch {} }
});
const app = path.join(tool, 'Codex Input Unlock.app');
const bootstrap = path.join(app, 'Contents/Helpers/CodexUnlockBootstrap');
const invoke = (exe, action, data) => execFileSync(exe, [action, '--data-dir', data], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('正式包的应用身份、版本、图标、许可和签名一致', () => {
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }));
  assert.equal(info.CFBundleIdentifier, 'io.github.trrywui.codex-input-unlock');
  assert.equal(info.CFBundleName, 'Codex Input Unlock');
  assert.equal(info.CFBundleDisplayName, 'Codex Input Unlock');
  assert.equal(info.CFBundleShortVersionString, '0.3.2');
  assert.equal(info.CFBundleVersion, '6');
  assert.deepEqual(fs.readdirSync(path.join(app, 'Contents/Helpers')).sort(), ['CodexUnlockAgent', 'CodexUnlockBootstrap']);
  assert.deepEqual(fs.readFileSync(path.join(app, 'Contents/Resources/ChatGPT.icns')), fs.readFileSync(path.join(tool, 'resources/ChatGPT.icns')));
  for (const file of ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-LICENSES.txt']) {
    assert.deepEqual(fs.readFileSync(path.join(app, 'Contents/Resources', file)), fs.readFileSync(path.join(tool, file)));
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
});

test('正式版：Swift 控制可查询和停止 Rust，双方拒绝旧版数据目录', async () => {
  const browser = await browserFixture(source, url); let probe;
  try {
    probe = await launchProbe(path.join(scratch, 'p'), browser.ws, manifestFor(), ['--browser']);
    await until(() => probe.state().state === 'ready' || probe.child.exitCode !== null);
    assert.equal(probe.state().state, 'ready', probe.errors());
    assert.equal(probe.state().backend, 'Rust');
    assert.equal(probe.state().version, '0.3.2');
    const processPath = execFileSync('/bin/ps', ['-p', String(probe.child.pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
    assert.equal(path.basename(processPath), 'CodexUnlockAgent');
    assert.equal(JSON.parse(invoke(bootstrap, 'status', probe.data)).running, true);
    const owner = JSON.parse(fs.readFileSync(path.join(probe.data, 'owner.json')));
    assert.equal(owner.tool, 'io.github.trrywui.codex-input-unlock');
    assert.equal(JSON.parse(invoke(bootstrap, 'stop', probe.data)).state, 'stopped');
    await until(() => probe.child.exitCode !== null);
    assert.ok(browser.requests.some(item => item.method === 'Debugger.removeBreakpoint'));
    assert.equal(JSON.parse(invoke(helper, 'status', probe.data)).running, false);

    const old = path.join(scratch, 'old'); fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'owner.json'), JSON.stringify({ tool: 'codex-input-unlock-native', format: 1 }));
    fs.writeFileSync(path.join(old, 'keep.txt'), 'keep');
    for (const exe of [helper, bootstrap]) {
      for (const action of ['status', 'clean']) assert.throws(() => invoke(exe, action, old));
    }
    assert.equal(fs.readFileSync(path.join(old, 'keep.txt'), 'utf8'), 'keep');
  } finally { await probe?.stop(); await browser.close(); }
});
