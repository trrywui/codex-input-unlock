import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { source, conditionalSource, url, oldGate, command, jsonCommand, launchFixture, launchProbe, until, sleep, manifestFor, helper } from './fixtures.mjs';
import { CdpSession } from './reference/cdp.mjs';

if (!process.env.CODEX_UNLOCK_TEST_ROOT) throw new Error('请显式设置 CODEX_UNLOCK_TEST_ROOT 为工作区内较短的测试目录，避免 macOS Unix socket 路径超长或写入未知位置');
const workspace = path.resolve(process.env.CODEX_UNLOCK_TEST_ROOT);
const parentCreated = !fs.existsSync(workspace);
fs.mkdirSync(workspace, { recursive: true });
const scratch = fs.mkdtempSync(path.join(workspace, 'native-'));
test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  if (parentCreated) { try { fs.rmdirSync(workspace); } catch {} }
});
let seq = 0;
const directory = () => path.join(scratch, String(++seq));
function locate(text) { const file = path.join(scratch, 'source.js'); fs.writeFileSync(file, text); return jsonCommand('locate', '--source', file); }
const atom = 'let XP=Xl(K,({get:e})=>{if(t.authMethod!==`chatgpt`||n.rate_limit?.allowed!==!1)return!1;return!0});';
const cases = [
  ['local-submit-quota', source],
  ['codex-local-quota', atom + 'function f(){let q=X(XP)&&h===`local`;let disabled=busy||q,other;return{submitDisabled:disabled}}'],
  ['legacy-local-host', atom + 'function f(){let q=X(XP)&&h===`local`;var disabled=busy||q;return{submitDisabled:disabled}}'],
  ['third-party-composer-dual', atom + 'function f(){let q=X(XP)&&h;return{submitDisabled:disabled,rateLimitSendBlocked:c||q,rateLimitConversationSendBlocked:c,other:true}}'],
];
for (const [mode, text] of cases) test('Swift 与旧定位器一致：' + mode, () => {
  const native = locate(text), old = oldGate.locate(text, url);
  assert.equal(old?.mode, mode); assert.equal(native.mode, mode);
  for (const key of ['lineNumber', 'columnNumber', 'endLineNumber', 'endColumnNumber', 'quotaVariable', 'conversationQuotaVariable']) assert.equal(native[key], old[key] ?? undefined, key);
  assert.equal(native.condition, oldGate.condition(old));
});
test('UTF-16：emoji 和换行不改变与 CDP 的坐标一致性', () => {
  const text = '/*🦊中文*/' + source;
  assert.equal(locate(text).columnNumber, oldGate.locate(text, url).columnNumber);
  assert.equal(locate('\n' + text).lineNumber, 1);
});
test('歧义或损坏代码不解锁', () => {
  assert.throws(() => locate(source + source)); assert.throws(() => locate('const unrelated=1;'));
});
test('条件额度读取：在发送限制合并前定位，UTF-16 坐标准确', () => {
  for (const prefix of ['', '/*🦊中文*/', '/*🦊中文*/\n']) {
    const text = prefix + conditionalSource, location = locate(text);
    const offset = text.indexOf('busy||conversation||quotaBlocked||empty');
    const lines = text.slice(0, offset).split('\n');
    assert.equal(location.mode, 'conditional-composer-dual');
    assert.equal(location.quotaVariable, 'quotaBlocked');
    assert.equal(location.conversationQuotaVariable, 'conversation');
    assert.equal(location.lineNumber, lines.length - 1);
    assert.equal(location.columnNumber, lines.at(-1).length);
    assert.equal(location.endLineNumber, location.lineNumber);
    assert.equal(location.endColumnNumber, location.columnNumber + 1);
    assert.equal(location.condition, '(conversation=false,quotaBlocked=false,false)');
  }
});
test('条件额度读取：拒绝不完整、歧义和不相干的发送限制', () => {
  for (const text of [
    conditionalSource + conditionalSource,
    conditionalSource.replace('active?XP:!1', 'active?XP:!0'),
    conditionalSource.replace('rateLimitConversationSendBlocked:conversation', 'rateLimitConversationSendBlocked:other'),
    conditionalSource.replace('sendBlocked:conversation}', 'unrelated:conversation}'),
    conditionalSource.replace('busy||conversation||quotaBlocked||empty', 'busy||empty'),
    conditionalSource.replace('combined=busy', 'second=busy||conversation||quotaBlocked,combined=busy'),
    conditionalSource.replace('rateLimitSendBlocked:conversation||quotaBlocked', 'rateLimitSendBlocked:conversation||quotaBlocked,rateLimitConversationSendBlocked:conversation,rateLimitSendBlocked:conversation||quotaBlocked'),
  ]) assert.throws(() => locate(text));
});
test('指定客户端 ASAR：静态预检成功且不修改原文件', { skip: !process.env.CODEX_UNLOCK_APP_ARCHIVE }, () => {
  const began = Date.now();
  const archive = process.env.CODEX_UNLOCK_APP_ARCHIVE;
  const digest = () => createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const before = digest();
  const info = jsonCommand('inspect', '--archive', archive);
  assert.ok(info.location.mode);
  const expected = info.location.mode === 'conditional-composer-dual'
    ? `(${info.location.conversationQuotaVariable}=false,${info.location.quotaVariable}=false,false)`
    : oldGate.condition(info.location);
  assert.equal(info.condition, expected);
  assert.match(info.bundleSha256, /^[a-f0-9]{64}$/);
  assert.equal(digest(), before);
  assert.ok(Date.now() - began < 5000, '静态扫描必须避免 ICU 正则的过量回溯');
});
test('ASAR 无匹配、多匹配与损坏数据均拒绝', () => {
  const file = path.join(scratch, 'fixture.asar');
  function archive(contents) {
    const files = {}; let offset = 0;
    for (const [name, text] of Object.entries(contents)) { files[name] = { size: Buffer.byteLength(text), offset: String(offset) }; offset += Buffer.byteLength(text); }
    const json = Buffer.from(JSON.stringify({ files: { webview: { files: { assets: { files } } } } }));
    const size = 8 + Math.ceil(json.length / 4) * 4, prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4); prefix.writeUInt32LE(size, 4); prefix.writeUInt32LE(size - 4, 8); prefix.writeUInt32LE(json.length, 12);
    fs.writeFileSync(file, Buffer.concat([prefix, json, Buffer.alloc(size - 8 - json.length), ...Object.values(contents).map(s => Buffer.from(s))]));
  }
  archive({ 'one.js': source }); assert.equal(jsonCommand('inspect', '--archive', file).location.mode, 'local-submit-quota');
  archive({ 'conditional.js': conditionalSource }); assert.equal(jsonCommand('inspect', '--archive', file).location.mode, 'conditional-composer-dual');
  archive({ 'one.js': source, 'conditional.js': conditionalSource }); assert.throws(() => command('inspect', '--archive', file));
  archive({ 'one.js': source, 'two.js': source }); assert.throws(() => command('inspect', '--archive', file));
  archive({ 'none.js': 'const noQuota=1' }); assert.throws(() => command('inspect', '--archive', file));
  fs.writeFileSync(file, Buffer.alloc(3)); assert.throws(() => command('inspect', '--archive', file));
});
test('临时数据目录的归属保护', () => {
  const foreign = directory(); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep.txt'), 'keep');
  assert.throws(() => command('clean', '--data-dir', foreign));
  assert.equal(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8'), 'keep');
  const link = directory(); fs.symlinkSync(foreign, link);
  assert.throws(() => command('status', '--data-dir', link));
});
test('后台二进制不链接 AppKit、JavaScriptCore、WebKit 或 Node', () => {
  const links = execFileSync('/usr/bin/otool', ['-L', helper], { encoding: 'utf8' });
  assert.doesNotMatch(links, /AppKit|JavaScriptCore|WebKit|libnode/);
});

for (const [label, text] of [['原有额度读取', source], ['条件额度读取', conditionalSource]]) test('真实 V8：' + label + '解锁、保留其它限制、无暂停、停止恢复', { timeout: 20000 }, async () => {
  const fixture = await launchFixture(directory(), text); let probe; let reader;
  try {
    reader = new CdpSession(fixture.ws); await reader.connect();
    await until(async () => await reader.evaluate('typeof fixture !== "undefined"'));
    assert.equal(await reader.evaluate('fixture.render().submitDisabled'), true);
    let paused = 0; reader.on('Debugger.paused', () => { paused++; void reader.send('Debugger.resume'); });
    const location = locate(text);
    const manifest = { url, location, condition: location.condition, bundleSha256: createHash('sha256').update(text).digest('hex') };
    probe = await launchProbe(directory(), fixture.ws, manifest);
    await until(() => probe.state().state === 'ready' || probe.child.exitCode !== null);
    assert.equal(probe.state().state, 'ready', probe.errors());
    assert.equal(await reader.evaluate('fixture.render().submitDisabled'), false);
    assert.equal(await reader.evaluate('fixture.render({busy:true}).submitDisabled'), true);
    assert.equal(await reader.evaluate('fixture.render({empty:true}).submitDisabled'), true);
    if (text === conditionalSource) {
      assert.equal(await reader.evaluate('fixture.render().rateLimitSendBlocked'), false);
      assert.equal(await reader.evaluate('fixture.render().rateLimitConversationSendBlocked'), false);
      assert.equal(await reader.evaluate('fixture.render({enabled:false,conversationBlocked:false}).submitDisabled'), false);
    }
    assert.equal(paused, 0);
    const mtime = fs.statSync(path.join(probe.data, 'state.json')).mtimeMs;
    await sleep(1200);
    assert.equal(fs.statSync(path.join(probe.data, 'state.json')).mtimeMs, mtime, '空闲时不能反复写心跳');
    assert.equal(jsonCommand('status', '--data-dir', probe.data).running, true);
    await probe.stop();
    assert.equal(await reader.evaluate('fixture.render().submitDisabled'), true);
    if (text === conditionalSource) {
      assert.equal(await reader.evaluate('fixture.render().rateLimitSendBlocked'), true);
      assert.equal(await reader.evaluate('fixture.render().rateLimitConversationSendBlocked'), true);
      assert.equal(await reader.evaluate('fixture.render({enabled:false,conversationBlocked:false}).submitDisabled'), false);
    }
    assert.equal(fs.existsSync(path.join(probe.data, 'control.sock')), false);
    command('clean', '--data-dir', probe.data); assert.equal(fs.existsSync(probe.data), false);
  } finally { await probe?.stop(); reader?.close(); await fixture.stop(); }
});
test('真实 V8：前端哈希不一致即停止，不挂载断点', { timeout: 12000 }, async () => {
  const fixture = await launchFixture(directory()); let probe;
  try {
    probe = await launchProbe(directory(), fixture.ws, { ...manifestFor(), bundleSha256: '0'.repeat(64) });
    await until(() => probe.child.exitCode !== null);
    assert.equal(probe.state().state, 'failed'); assert.match(probe.state().error, /哈希不一致/);
  } finally { await probe?.stop(); await fixture.stop(); }
});
test('macOS 进程退出通知：目标退出，后台随即结束', { timeout: 12000 }, async () => {
  const fixture = await launchFixture(directory()); let probe;
  try {
    probe = await launchProbe(directory(), fixture.ws, manifestFor(), ['--watch-pid', String(fixture.child.pid)]);
    await until(() => probe.state().state === 'ready');
    await fixture.stop(); await until(() => probe.child.exitCode !== null, 4000);
    assert.equal(probe.state().state, 'stopped');
  } finally { await probe?.stop(); await fixture.stop(); }
});

// Minimal local WS fixture. No packages, external server, accounts or model calls.
async function fakeBrowser() {
  const requests = [], sockets = new Set(), sources = new Map(); let peer;
  const server = http.createServer();
  function frame(text, opcode = 1) {
    const body = Buffer.from(text); let header;
    if (body.length < 126) header = Buffer.from([0x80 | opcode, body.length]);
    else { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(body.length, 2); }
    return Buffer.concat([header, body]);
  }
  const send = message => peer?.write(frame(JSON.stringify(message)));
  const event = (method, params, sessionId) => send({ method, params, ...(sessionId ? { sessionId } : {}) });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); peer = socket;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15, masked = !!(buffer[1] & 128); let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + (masked ? 4 : 0) + length) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null; if (masked) offset += 4;
        const body = Buffer.from(buffer.subarray(offset, offset + length)); buffer = buffer.subarray(offset + length);
        if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(frame('', 8)); continue; }
        if (opcode === 9) { socket.write(frame(body, 10)); continue; }
        if (opcode !== 1) continue;
        const request = JSON.parse(body); requests.push(request); const { id, method, params = {}, sessionId } = request;
        let result = {};
        if (method === 'Target.attachToTarget') result = { sessionId: 's-' + params.targetId };
        if (method === 'Debugger.getScriptSource') result = { scriptSource: sources.get(sessionId) ?? source };
        if (method === 'Debugger.getPossibleBreakpoints') result = { locations: [params.start] };
        if (method === 'Debugger.setBreakpoint') result = { breakpointId: 'bp-' + sessionId, actualLocation: params.location };
        send({ id, result, ...(sessionId ? { sessionId } : {}) });
        if (method === 'Target.setDiscoverTargets') event('Target.targetCreated', { targetInfo: { targetId: 'one', type: 'page', url: 'app://-/index.html' } });
        if (method === 'Debugger.enable') event('Debugger.scriptParsed', { scriptId: '1', url }, sessionId);
      }
    });
    socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { ws: `ws://127.0.0.1:${server.address().port}/browser`, requests, sources, event, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
test('Browser CDP：刷新、新窗口、多窗口清理及未知版本拒绝', { timeout: 15000 }, async () => {
  const browser = await fakeBrowser(); let probe;
  try {
    probe = await launchProbe(directory(), browser.ws, manifestFor(), ['--browser']);
    await until(() => probe.state().state === 'ready' || probe.child.exitCode !== null);
    assert.equal(probe.state().state, 'ready', probe.errors());
    const mounted = () => browser.requests.filter(item => item.method === 'Debugger.setBreakpoint').length;
    browser.event('Runtime.executionContextsCleared', {}, 's-one');
    browser.event('Debugger.scriptParsed', { scriptId: '2', url }, 's-one');
    await until(() => mounted() === 2);
    browser.event('Target.targetCreated', { targetInfo: { targetId: 'two', type: 'page', url: 'app://-/index.html?window=2' } });
    await until(() => probe.state().state === 'ready' && probe.state().windows.length === 2);
    assert.equal(mounted(), 3);
    browser.sources.set('s-bad', source + ';');
    browser.event('Target.targetCreated', { targetInfo: { targetId: 'bad', type: 'page', url: 'app://-/index.html' } });
    await until(() => probe.child.exitCode !== null);
    assert.equal(probe.state().state, 'failed'); assert.match(probe.state().error, /哈希/);
    const removed = browser.requests.filter(item => item.method === 'Debugger.removeBreakpoint').map(item => item.sessionId);
    assert.ok(removed.includes('s-one')); assert.ok(removed.includes('s-two'));
  } finally { await probe?.stop(); await browser.close(); }
});
