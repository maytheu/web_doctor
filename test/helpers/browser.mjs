import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const LAUNCH_ATTEMPTS = 3;
const TARGET_DEADLINE_MS = 30000;
const CONNECT_TIMEOUT_MS = 20000;

const CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
};

export function findBrowser() {
  const override = process.env.CHROME_PATH;
  if (override) return existsSync(override) ? override : null;
  return (CANDIDATES[process.platform] ?? []).find(existsSync) ?? null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForTarget(port, readStderr, hasExited) {
  const deadline = Date.now() + TARGET_DEADLINE_MS;
  for (;;) {
    if (hasExited()) {
      throw new Error(`Chrome exited before exposing a debug target. ${readStderr().slice(0, 500)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome is still starting.
    }
    if (Date.now() >= deadline) {
      throw new Error(`Chrome did not expose a debug target. ${readStderr().slice(0, 500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP connection timed out'));
    }, CONNECT_TIMEOUT_MS);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve(ws);
      },
      { once: true }
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('CDP connection failed'));
      },
      { once: true }
    );
  });
}

function createClient(ws) {
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const slot = pending.get(message.id);
      if (!slot) return;
      pending.delete(message.id);
      if (message.error) slot.reject(new Error(message.error.message));
      else slot.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) ?? []) listener(message.params);
  });

  ws.addEventListener('close', () => {
    for (const [id, slot] of pending) {
      pending.delete(id);
      slot.reject(new Error('CDP connection closed'));
    }
  });

  function send(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function on(method, listener) {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(listener);
  }

  return { send, on };
}

async function launchOnce(executable) {
  const port = await freePort();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'awd-browser-'));
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-pings',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,900',
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  let ws;
  try {
    ws = await connect(
      await waitForTarget(port, () => stderr, () => child.exitCode !== null || child.signalCode !== null)
    );
    const { send, on } = createClient(ws);
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');

    async function evaluate(expression) {
      const outcome = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      });
      if (outcome.exceptionDetails) {
        const detail = outcome.exceptionDetails.exception?.description ?? outcome.exceptionDetails.text;
        throw new Error(detail || 'Page evaluation failed');
      }
      return outcome.result?.value;
    }

    async function waitFor(expression, { timeoutMs = 15000, intervalMs = 50, label } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await evaluate(expression);
        if (value) return value;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label || expression}`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    async function navigate(url) {
      await send('Page.navigate', { url });
      const withSlash = url.endsWith('/') ? url : `${url}/`;
      await waitFor(
        `document.readyState === "complete" && (location.href === ${JSON.stringify(url)} || location.href === ${JSON.stringify(withSlash)})`,
        { label: `page load of ${url}` }
      );
    }

    async function close() {
      try {
        await Promise.race([
          send('Browser.close'),
          new Promise((resolve) => setTimeout(resolve, 2000))
        ]);
      } catch {
        // The browser may already be gone.
      }
      try {
        ws.close();
      } catch {
        // Ignore.
      }
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore.
          }
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.kill();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    return { send, on, evaluate, waitFor, navigate, close };
  } catch (error) {
    try {
      ws?.close();
    } catch {
      // Ignore.
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore.
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    const detail = stderr.trim();
    throw new Error(detail ? `${error.message}\n${detail.slice(-500)}` : error.message);
  }
}

export async function launchBrowser(executable) {
  let lastError;
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt += 1) {
    try {
      return await launchOnce(executable);
    } catch (error) {
      lastError = error;
      if (attempt < LAUNCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  throw new Error(`Chrome failed to start after ${LAUNCH_ATTEMPTS} attempts: ${lastError.message}`);
}
