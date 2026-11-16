'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAIN = path.join(__dirname, '..', 'main.js');

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`server did not start within 15s:\n${output}`));
    }, 15000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /listening on http:\/\/[^\s:]+:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code}:\n${output}`));
    });
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 4000);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function startApp(options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'formdrop-test-'));
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', FORMDROP_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await waitForListening(child);
  const base = `http://127.0.0.1:${port}`;
  const app = {
    base,
    dataDir,
    child,
    stop: () => stopChild(child),
    async restart() {
      await stopChild(child);
      const next = await startApp({ dataDir });
      app.base = next.base;
      app.child = next.child;
      app.stop = next.stop;
      app.restart = next.restart;
      return next;
    },
  };
  return app;
}

function firstCookie(response) {
  const many = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const raw = many.length ? many[0] : response.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

async function request(base, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  const init = { method: options.method || 'GET', headers, redirect: 'manual' };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.json);
  } else if (options.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(options.form).toString();
  } else if (options.body !== undefined) {
    if (options.contentType) headers['content-type'] = options.contentType;
    init.body = options.body;
  }
  const response = await fetch(base + pathname, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
    cookie: firstCookie(response),
    location: response.headers.get('location'),
  };
}

async function loginAs(base, email, password) {
  const result = await request(base, '/api/auth/login', { method: 'POST', json: { email, password } });
  return { ...result, cookie: result.cookie };
}

async function signupAs(base, email, password) {
  const result = await request(base, '/api/auth/signup', { method: 'POST', json: { email, password } });
  return { ...result, cookie: result.cookie };
}

function multipartBody(boundary, fields) {
  const parts = Object.entries(fields).map(
    ([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return `${parts.join('')}--${boundary}--\r\n`;
}

module.exports = { startApp, request, loginAs, signupAs, multipartBody, stopChild };
