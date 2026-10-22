import http from 'node:http';
import { createHash } from 'node:crypto';
export async function browserFixture(source, url, { fragmented = false } = {}) {
  const requests = [], sockets = new Set(); let peer, pongCount = 0;
  const mode = { noBreakpoints: false, ignoreCleanup: false };
  const server = http.createServer();
  const frame = (body, opcode = 1, fin = true) => {
    body = Buffer.from(body); let header;
    if (body.length < 126) header = Buffer.from([(fin ? 128 : 0) | opcode, body.length]);
    else if (body.length < 65536) { header = Buffer.alloc(4); header[0] = (fin ? 128 : 0) | opcode; header[1] = 126; header.writeUInt16BE(body.length, 2); }
    else { header = Buffer.alloc(10); header[0] = (fin ? 128 : 0) | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
    return Buffer.concat([header, body]);
  };
  const send = message => {
    const data = Buffer.from(JSON.stringify(message));
    if (!fragmented) peer?.write(frame(data));
    else { const half = Math.max(1, Math.floor(data.length / 2)); peer?.write(frame(data.subarray(0, half), 1, false)); peer?.write(frame('ping', 9)); peer?.write(frame(data.subarray(half), 0)); }
  };
  const event = (method, params, sessionId) => send({ method, params, ...(sessionId ? { sessionId } : {}) });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); peer = socket;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15, masked = !!(buffer[1] & 128); let n = buffer[1] & 127, offset = 2;
        if (n === 126) { if (buffer.length < 4) return; n = buffer.readUInt16BE(2); offset = 4; }
        if (n === 127) { if (buffer.length < 10) return; n = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + (masked ? 4 : 0) + n) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null; if (masked) offset += 4;
        const body = Buffer.from(buffer.subarray(offset, offset + n)); buffer = buffer.subarray(offset + n);
        if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        if (opcode === 10) { pongCount++; continue; }
        if (opcode === 8) { socket.end(frame('', 8)); continue; }
        if (opcode !== 1) continue;
        const r = JSON.parse(body); requests.push(r); const { id, method, params = {}, sessionId } = r;
        if (mode.ignoreCleanup && ['Debugger.removeBreakpoint', 'Debugger.disable'].includes(method)) continue;
        let result = {};
        if (method === 'Target.attachToTarget') result = { sessionId: 's-' + params.targetId };
        if (method === 'Debugger.getScriptSource') result = { scriptSource: source };
        if (method === 'Debugger.getPossibleBreakpoints') result = { locations: mode.noBreakpoints ? [] : [params.start] };
        if (method === 'Debugger.setBreakpoint') result = { breakpointId: 'bp-' + sessionId, actualLocation: params.location };
        send({ id, result, ...(sessionId ? { sessionId } : {}) });
        if (method === 'Target.setDiscoverTargets') event('Target.targetCreated', { targetInfo: { targetId: 'one', type: 'page', url: 'app://-/index.html' } });
        if (method === 'Debugger.enable') event('Debugger.scriptParsed', { scriptId: '1', url }, sessionId);
      }
    });
    socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { ws: `ws://127.0.0.1:${server.address().port}/browser`, requests, mode, event, pongCount: () => pongCount, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
