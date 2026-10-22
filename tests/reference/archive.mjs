import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const gate = require('./quota-gate.cjs');
export const sha256 = value => createHash('sha256').update(value).digest('hex');

// Read the archive in place; never unpack the application into another directory.
export function inspectArchive(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    function read(length, offset) {
      if (!Number.isSafeInteger(length) || !Number.isSafeInteger(offset) || length < 0 || offset < 0 || offset + length > size) {
        throw new Error('ASAR 数据范围无效');
      }
      const data = Buffer.alloc(length);
      if (fs.readSync(fd, data, 0, length, offset) !== length) throw new Error('ASAR 读取不完整');
      return data;
    }
    const prefix = read(16, 0);
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (prefix.readUInt32LE(0) !== 4 || jsonSize > 32 * 1024 * 1024 || headerSize < jsonSize + 8) {
      throw new Error('不支持的 ASAR 头部');
    }
    const header = JSON.parse(read(jsonSize, 16).toString('utf8'));
    const base = 8 + headerSize;
    const matches = [];
    let scanned = 0;
    function walk(node, parent = '') {
      for (const [name, entry] of Object.entries(node.files || {})) {
        const archiveName = parent + name;
        if (entry.files) { walk(entry, archiveName + '/'); continue; }
        if (!archiveName.startsWith('webview/assets/') || !archiveName.endsWith('.js') || entry.unpacked || entry.link) continue;
        const length = Number(entry.size);
        const offset = Number(entry.offset);
        if (length > 64 * 1024 * 1024) throw new Error('前端脚本过大，停止自动定位');
        const bytes = read(length, base + offset);
        const source = bytes.toString('utf8');
        scanned++;
        if (!source.includes('submitDisabled:')) continue;
        const url = 'app://-/assets/' + path.posix.basename(archiveName);
        const location = gate.locate(source, url);
        const condition = gate.condition(location);
        if (location && condition) matches.push({ archiveName, url, bundleSha256: sha256(bytes), location, condition });
      }
    }
    walk(header);
    if (matches.length !== 1) throw new Error(`前端额度门禁未唯一定位（匹配 ${matches.length} 个文件），需要适配当前版本`);
    return { ...matches[0], scanned };
  } finally { fs.closeSync(fd); }
}
