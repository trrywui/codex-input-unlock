import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { inspectArchive } from './archive.mjs';

export function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
const runtimeOwner = 'codex-input-unlock-macos';
export function verifyDataDirectory(directory) {
  if (!fs.existsSync(directory)) return false;
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('runtime 路径不是独立目录，拒绝访问');
  if (readJson(path.join(directory, 'owner.json'))?.tool !== runtimeOwner) throw new Error('runtime 目录不属于本工具，拒绝访问或清理');
  return true;
}
export function ensureDataDirectory(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { mode: 0o700 });
    writeJson(path.join(directory, 'owner.json'), { tool: runtimeOwner, format: 1 });
  } else verifyDataDirectory(directory);
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
export function claimLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readJson(file);
    if (!owner || alive(owner.pid)) throw new Error('已有工具进程正在操作；若异常退出，请先运行 status');
    fs.unlinkSync(file);
    return claimLock(file);
  }
  return () => {
    try { if (readJson(file)?.pid === process.pid) fs.unlinkSync(file); } catch {}
  };
}
export function appMetadata(appPath) {
  if (process.platform !== 'darwin') throw new Error('启动器仅支持 macOS');
  const app = fs.realpathSync(appPath);
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')]));
  if (info.CFBundleIdentifier !== 'com.openai.codex') throw new Error('目标应用的 Bundle ID 不是 com.openai.codex');
  if (typeof info.CFBundleExecutable !== 'string' || path.basename(info.CFBundleExecutable) !== info.CFBundleExecutable) throw new Error('应用主程序名称无效');
  const executable = path.join(app, 'Contents/MacOS', info.CFBundleExecutable);
  fs.accessSync(executable, fs.constants.X_OK);
  return { app, executable, bundleId: info.CFBundleIdentifier, version: info.CFBundleShortVersionString, build: info.CFBundleVersion };
}
export function preflight(appPath) {
  const metadata = appMetadata(appPath);
  const archive = path.join(metadata.app, 'Contents/Resources/app.asar');
  return { ...metadata, ...inspectArchive(archive) };
}
export function processList() {
  const result = run('/bin/ps', ['-axww', '-o', 'pid=,comm=']);
  return result.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), executable: match[2] }] : [];
  });
}
export function appProcesses(app, processes = processList()) {
  return processes.filter(item => item.executable.startsWith(app + '/Contents/'));
}
export function desktopProcesses(app, processes = processList()) {
  return appProcesses(app, processes).filter(item => item.executable.startsWith(app + '/Contents/MacOS/')
    || item.executable.startsWith(app + '/Contents/Frameworks/') && item.executable.includes('.app/Contents/MacOS/'));
}
export function assertLoopbackListeners(output, app, processes) {
  const owners = new Set(appProcesses(app, processes).map(item => item.pid));
  let pid;
  let count = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n')) {
      const address = line.slice(1);
      if (!/^(127\.0\.0\.1|\[::1\]):\d+$/.test(address)) throw new Error('调试端口并非仅监听回环地址，停止解锁');
      if (!owners.has(pid)) throw new Error('调试端口不属于目标客户端，停止解锁');
      count++;
    }
  }
  return count > 0;
}
export function verifyListener(port, app) {
  let output;
  try { output = run('/usr/sbin/lsof', ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-Fpn']); }
  catch (error) {
    if (error.status === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return false;
    throw new Error('无法核对调试监听端口：' + String(error.stderr || error.message).trim());
  }
  return assertLoopbackListeners(output, app, processList());
}
export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
