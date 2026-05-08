import net from 'node:net';
import { spawn } from 'node:child_process';

const LOCAL_PORT = Number(process.env.PLATFORM_LOCAL_PORT || 8788);
const RESET_LOCAL = process.argv.includes('--reset-local');

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function spawnProc(command, args, options = {}) {
  return spawn(command, args, {
    stdio: 'inherit',
    ...options,
  });
}

const cleanupHandlers = [];
let shuttingDown = false;

function addCleanup(fn) {
  cleanupHandlers.push(fn);
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const fn of cleanupHandlers.reverse()) {
    try {
      await fn();
    } catch {
      // Ignore shutdown errors.
    }
  }
  process.exit(code);
}

async function main() {
  let localProc = null;
  const localIsRunning = await isPortOpen(LOCAL_PORT);

  if (localIsRunning && RESET_LOCAL) {
    console.warn(`[platform-local] Port ${LOCAL_PORT} is already in use; --reset-local ignored.`);
  }

  if (!localIsRunning) {
    const localArgs = ['platform/local-testenv.mjs'];
    if (RESET_LOCAL) localArgs.push('--reset');

    console.log(`[platform-local] starting local test environment on :${LOCAL_PORT}`);
    localProc = spawnProc('node', localArgs, {
      env: {
        ...process.env,
        PLATFORM_LOCAL_PORT: String(LOCAL_PORT),
      },
    });

    await new Promise((resolve, reject) => {
      let settled = false;

      localProc.once('exit', (code) => {
        if (!settled) {
          settled = true;
          reject(new Error(`platform-local exited early with code ${code ?? 'unknown'}`));
        }
      });

      const checkReady = async () => {
        if (settled) return;
        const ok = await isPortOpen(LOCAL_PORT);
        if (ok) {
          settled = true;
          resolve();
          return;
        }
        setTimeout(checkReady, 150);
      };

      setTimeout(checkReady, 150);
    });

    addCleanup(async () => {
      if (!localProc || localProc.killed) return;
      localProc.kill('SIGTERM');
    });
  } else {
    console.log(`[platform-local] using existing local test environment on :${LOCAL_PORT}`);
  }

  console.log('[desktop] starting tauri gRPC dev mode');
  console.log('[desktop] tip: open labeling app with ?platformLocal=1 once to persist local mode');

  const desktopProc = spawnProc('npm', ['run', 'desktop:dev:grpc'], {
    env: {
      ...process.env,
      PLATFORM_LOCAL_PORT: String(LOCAL_PORT),
      // Suppress WebKitGTK GPU/Vulkan warnings in WSL / headless environments.
      WEBKIT_DISABLE_DMABUF_RENDERER: '1',
      WEBKIT_DISABLE_COMPOSITING_MODE: '1',
      // Suppress Locale warning from GTK.
      LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    },
  });

  addCleanup(async () => {
    if (desktopProc.killed) return;
    desktopProc.kill('SIGTERM');
  });

  desktopProc.once('exit', (code) => {
    shutdown(code ?? 0);
  });
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

main().catch((err) => {
  console.error('[dev-desktop-platform-local] failed:', err.message || err);
  shutdown(1);
});
