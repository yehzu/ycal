// Unix-socket server that lets the standalone `ycal` Node client (no Electron)
// drive the same `runCli` code path the in-process --cli mode uses. Started
// once when the GUI boots; cleaned up on quit.
//
// Wire protocol — single roundtrip, JSON on both sides:
//   client → server : { "args": ["today", "--format", "markdown"] }   (then half-close)
//   server → client : { "stdout": "...", "stderr": "...", "code": 0 }
//
// Threading: each connection runs runCli with its own in-memory Writable
// pair, so concurrent requests don't bleed into each other's output.
import { app } from 'electron';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { runCli } from './cli';

class StringSink extends Writable {
  data = '';
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

function socketPath(): string {
  return path.join(app.getPath('userData'), 'cli.sock');
}

let server: net.Server | null = null;

export function startCliServer(): void {
  if (server) return; // idempotent
  const sockPath = socketPath();

  // Stale socket from a prior crash will block listen with EADDRINUSE.
  try { fs.unlinkSync(sockPath); } catch { /* not present, that's fine */ }

  // allowHalfOpen=true is essential: by default Node auto-FINs the server's
  // write side as soon as the client half-closes, which races our async
  // runCli — the response gets dropped on the floor. With half-open we keep
  // the writable side alive until we explicitly sock.end(response).
  const s = net.createServer({ allowHalfOpen: true }, (sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => { buf += chunk; });
    sock.on('end', async () => {
      let response = { stdout: '', stderr: '', code: 1 };
      try {
        const req = JSON.parse(buf) as { args?: unknown };
        const args = Array.isArray(req.args) ? req.args.map(String) : [];
        const out = new StringSink();
        const err = new StringSink();
        const code = await runCli(args, out, err);
        response = { stdout: out.data, stderr: err.data, code };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        response = { stdout: '', stderr: `cliServer: ${msg}\n`, code: 1 };
      }
      try { sock.end(JSON.stringify(response)); } catch { /* socket closed */ }
    });
    // Don't crash the GUI if the client hangs up early.
    sock.on('error', () => { /* ignore */ });
  });

  s.on('error', (e) => {
    console.error('[yCal cliServer] error:', e);
  });

  s.listen(sockPath, () => {
    // 0600 — only this user can drive the CLI. Defense-in-depth on a
    // multi-user machine; the userData dir already enforces it but we set
    // explicit perms so it's auditable.
    try { fs.chmodSync(sockPath, 0o600); } catch { /* best-effort */ }
    console.log(`[yCal cliServer] listening on ${sockPath}`);
  });

  server = s;

  // Don't unlink the socket file on quit. During an updater-driven restart,
  // the outgoing process's `will-quit` can fire AFTER the incoming process has
  // already created its own socket file at the same path — and unlinkSync
  // would then race-delete the successor's file, leaving the new server alive
  // with no path the client can connect to. The line-37 cleanup at the next
  // startup handles staleness, so leaving the file behind is harmless.
  app.on('will-quit', () => {
    try { s.close(); } catch { /* already closed */ }
  });
}
