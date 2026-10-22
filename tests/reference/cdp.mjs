// Transport and breakpoint location logic adapted from 1zero224/codex-input-unlock (MIT).
import { gate, sha256 } from './archive.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validateWebSocketUrl(value, expectedPort) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || Number(url.port) !== expectedPort) {
    throw new Error('CDP 地址不是预期的本机回环端口');
  }
  if (url.username || url.password) throw new Error('不接受带认证信息的 CDP 地址');
  return url.href;
}

export class CdpSession {
  constructor(url) {
    this.url = url;
    this.pending = new Map();
    this.handlers = new Map();
    this.nextId = 1;
    this.closed = false;
  }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', event => this.receive(event.data));
    this.socket.addEventListener('close', () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('CDP 连接已关闭')); }
      this.pending.clear();
      this.emit('closed', {});
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.close(); reject(new Error('CDP 连接超时')); }, 5000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 无法连接')); }, { once: true });
    });
  }
  receive(data) {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (!message.id) { if (message.method) this.emit(message.method, message.params || {}); return; }
    const task = this.pending.get(message.id);
    if (!task) return;
    this.pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message));
    else task.resolve(message.result || {});
  }
  emit(name, data) { for (const handler of this.handlers.get(name) || []) handler(data); }
  on(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(handler);
    return () => this.handlers.get(name)?.delete(handler);
  }
  send(method, params = {}, timeout = 8000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP 未连接'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 命令超时：${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('调试表达式执行失败');
    return result.result?.value;
  }
  close() { try { this.socket?.close(); } catch {} }
}

export function mainTargets(targets) {
  if (!Array.isArray(targets)) throw new Error('CDP 页面列表格式无效');
  return targets.filter(target => {
    if (target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
    try {
      const url = new URL(target.url);
      return url.protocol === 'app:' && url.hostname === '-' && url.pathname === '/index.html';
    } catch { return false; }
  });
}

export async function discoverTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
  if (!response.ok) throw new Error(`CDP 页面发现失败：HTTP ${response.status}`);
  return mainTargets(await response.json()).map(target => ({ ...target, webSocketDebuggerUrl: validateWebSocketUrl(target.webSocketDebuggerUrl, port) }));
}

export async function resolveBreakpointLocation(session, scriptId, desired) {
  // New versions must not silently expand the search into unrelated expressions.
  const start = { scriptId, lineNumber: desired.lineNumber, columnNumber: desired.columnNumber };
  const end = Number.isInteger(desired.endLineNumber)
    ? { scriptId, lineNumber: desired.endLineNumber, columnNumber: desired.endColumnNumber }
    : { scriptId, lineNumber: desired.lineNumber, columnNumber: desired.columnNumber + 300 };
  const result = await session.send('Debugger.getPossibleBreakpoints', { start, end, restrictToFunction: true });
  const candidates = (result.locations || []).filter(item => item.scriptId === scriptId
    && (item.lineNumber > start.lineNumber || item.lineNumber === start.lineNumber && item.columnNumber >= start.columnNumber)
    && (item.lineNumber < end.lineNumber || item.lineNumber === end.lineNumber && item.columnNumber < end.columnNumber));
  candidates.sort((a, b) => a.lineNumber - b.lineNumber || a.columnNumber - b.columnNumber);
  if (!candidates.length) throw new Error('预期额度表达式内没有可执行断点，需要适配当前版本');
  return candidates[0];
}

export function validateSource(source, url, expected) {
  if (sha256(source) !== expected.bundleSha256) throw new Error('运行中前端与启动前检查的文件不一致，停止解锁');
  const location = gate.locate(source, url);
  const condition = gate.condition(location);
  if (!location || !condition) throw new Error('运行中额度门禁未唯一定位，停止解锁');
  return { location, condition };
}

export async function armSession(session, expected, signal, onInvalid = () => {}) {
  const candidates = new Map();
  const pending = new Set();
  let failure;
  let active = true;
  let breakpointId;
  const off = session.on('Debugger.scriptParsed', params => {
    if (!active) return;
    let url;
    try { url = new URL(params.url); } catch { return; }
    if (url.protocol !== 'app:' || url.hostname !== '-' || url.pathname !== new URL(expected.url).pathname) return;
    if (candidates.has(params.scriptId)) return;
    candidates.set(params.scriptId, null);
    const task = (async () => {
      try {
        if (candidates.size !== 1) throw new Error('同一窗口出现多个额度脚本实例，停止解锁');
        const { scriptSource } = await session.send('Debugger.getScriptSource', { scriptId: params.scriptId });
        const checked = validateSource(scriptSource, params.url, expected);
        candidates.set(params.scriptId, { ...checked, scriptId: params.scriptId, url: params.url });
      } catch (error) { failure = error; if (active) onInvalid(error); }
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  async function dispose() {
    active = false;
    off();
    if (breakpointId) {
      try { await session.send('Debugger.removeBreakpoint', { breakpointId }, 2000); } catch {}
    }
    try { await session.send('Debugger.disable', {}, 2000); } catch {}
  }
  try {
    await session.send('Runtime.enable');
    await session.send('Debugger.enable');
    const deadline = Date.now() + 20000;
    while (!failure && !signal?.aborted && !session.closed && ![...candidates.values()].some(Boolean) && Date.now() < deadline) await sleep(50);
    await Promise.all(pending);
    if (signal?.aborted) throw new Error('解锁已停止');
    if (failure) throw failure;
    if (candidates.size !== 1 || ![...candidates.values()][0]) throw new Error('未找到预期额度脚本，需要适配当前版本');
    const script = [...candidates.values()][0];
    const actualLocation = await resolveBreakpointLocation(session, script.scriptId, script.location);
    const result = await session.send('Debugger.setBreakpoint', { location: actualLocation, condition: script.condition });
    breakpointId = result.breakpointId;
    if (!breakpointId || !result.actualLocation) throw new Error('额度断点未成功挂载');
    return { breakpointId, actualLocation: result.actualLocation, condition: script.condition, dispose };
  } catch (error) { await dispose(); throw error; }
}
