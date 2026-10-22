import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CdpSession, armSession, discoverTargets, sleep } from './cdp.mjs';
import { readJson, writeJson, verifyListener, claimLock, verifyDataDirectory } from './platform.mjs';

export async function supervise({ port, expected, signal, listenerCheck = () => verifyListener(port, expected.app), discover = () => discoverTargets(port), onStatus = () => {}, connect = async target => {
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  return session;
}, startupTimeout = 60000, missingTimeout = 20000, pollInterval = 1000 }) {
  const controller = new AbortController();
  const tasks = new Map();
  const states = new Map();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let fatal;
  let everReady = false;
  let missingSince;
  const deadline = Date.now() + startupTimeout;
  function report() {
    const targets = [...states.values()];
    const ready = targets.length > 0 && targets.every(item => item.state === 'ready');
    if (ready) everReady = true;
    onStatus(ready ? 'ready' : 'waiting', { port, targets });
  }
  async function watch(target, local) {
    let session;
    try {
      while (!local.signal.aborted && !controller.signal.aborted) {
        let mounted;
        let reload = false;
        let invalid;
        let off;
        try {
          states.set(target.id, { id: target.id, state: 'attaching' });
          report();
          session = await connect(target);
          off = session.on('Runtime.executionContextsCleared', () => { reload = true; });
          mounted = await armSession(session, expected, local.signal, error => { invalid = error; });
          if (invalid && !reload) throw invalid;
          states.set(target.id, { id: target.id, state: 'ready', actualLocation: mounted.actualLocation });
          report();
          while (!controller.signal.aborted && !local.signal.aborted && !reload && !session.closed && !invalid) await sleep(100);
          if (invalid && !reload) throw invalid;
          if (session.closed) return;
        } catch (error) {
          if (!reload && !local.signal.aborted && !controller.signal.aborted) throw error;
        } finally {
          off?.();
          await mounted?.dispose();
          session?.close();
          session = null;
        }
        if (reload) await sleep(100);
      }
    } catch (error) {
      fatal = error;
      controller.abort();
    } finally { states.delete(target.id); }
  }
  try {
    while (!controller.signal.aborted) {
      let targets = [];
      if (await listenerCheck()) {
        try { targets = await discover(); }
        catch (error) {
          // A closing client may lose its HTTP listener between the two checks.
          if (!(error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name))) throw error;
        }
      }
      const active = new Set(targets.map(item => item.id));
      for (const [id, task] of tasks) {
        if (!active.has(id)) { task.controller.abort(); await task.promise; tasks.delete(id); states.delete(id); }
      }
      for (const target of targets) {
        if (tasks.has(target.id)) continue;
        const local = new AbortController();
        const stop = () => local.abort();
        controller.signal.addEventListener('abort', stop, { once: true });
        const task = { controller: local };
        task.promise = watch(target, local).finally(() => { controller.signal.removeEventListener('abort', stop); task.done = true; });
        tasks.set(target.id, task);
      }
      for (const [id, task] of tasks) if (task.done) tasks.delete(id);
      if (!targets.length) {
        missingSince ??= Date.now();
        if (everReady && Date.now() - missingSince > missingTimeout) break;
      } else missingSince = null;
      if (!everReady && Date.now() > deadline) throw new Error('启动超时：未能启用 CDP 或找到兼容的主窗口；请检查客户端版本和诊断结果');
      report();
      await sleep(pollInterval);
    }
    if (fatal) throw fatal;
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', abort);
    await Promise.allSettled([...tasks.values()].map(task => task.promise));
  }
}

async function main() {
  const stateFile = process.argv[2];
  if (!stateFile || path.basename(stateFile) !== 'session.json') throw new Error('缺少有效会话文件');
  const dataDir = path.dirname(stateFile);
  verifyDataDirectory(dataDir);
  const state = readJson(stateFile);
  if (!state || !/^[a-f0-9]{32}$/.test(state.token) || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535) throw new Error('会话参数无效');
  const unlock = claimLock(path.join(dataDir, 'supervisor.lock'));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const statusFile = path.join(dataDir, 'status.json');
  let lastWrite = 0;
  let lastState;
  function status(value, extra = {}) {
    // Heartbeat only: never store credentials, request bodies or chat contents.
    if (lastState === value && Date.now() - lastWrite < 2000) return;
    lastState = value; lastWrite = Date.now();
    writeJson(statusFile, { state: value, pid: process.pid, token: state.token, updatedAt: new Date().toISOString(), ...extra });
  }
  const stopFile = path.join(dataDir, 'stop-request.json');
  const timer = setInterval(() => {
    try { if (readJson(stopFile)?.token === state.token) controller.abort(); }
    catch { /* Atomic writer may be interrupted; next tick retries. */ }
  }, 200);
  try {
    status('waiting', { port: state.port });
    await supervise({ port: state.port, expected: state.expected, signal: controller.signal, onStatus: status });
    status('stopped', { message: '解锁已停止，官方客户端未被关闭' });
  } catch (error) {
    status('failed', { error: error.message });
    process.exitCode = 1;
  } finally {
    clearInterval(timer);
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    unlock();
    try { if (readJson(stopFile)?.token === state.token) fs.unlinkSync(stopFile); } catch {}
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
