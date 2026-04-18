#!/usr/bin/env node
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 33737;
const BOOT_TIMEOUT_MS = 15000;

const tmpDb = path.join(os.tmpdir(), `lektorat-smoke-${process.pid}.db`);
const tmpLog = path.join(os.tmpdir(), `lektorat-smoke-${process.pid}.log`);

const env = {
  ...process.env,
  PORT: String(PORT),
  SESSION_SECRET: 'ci-smoke-secret',
  ALLOWED_EMAILS: 'ci@example.com',
  ANTHROPIC_API_KEY: 'sk-ci-smoke',
  MODEL_NAME: 'claude-opus-4-7',
  API_PROVIDER: 'claude',
  DB_PATH: tmpDb,
  LOG_FILE: tmpLog,
  LOCAL_DEV_MODE: 'false',
  APP_URL: 'http://localhost:' + PORT,
};

function cleanup() {
  for (const f of [tmpDb, tmpLog]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET' }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startete nicht innerhalb ${BOOT_TIMEOUT_MS}ms`)), BOOT_TIMEOUT_MS);
    const onData = buf => {
      const s = buf.toString();
      process.stdout.write(`[server] ${s}`);
      if (s.includes('Lektorat läuft auf') || s.includes('Lektorat l')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server beendet unerwartet mit Code ${code}`));
    });
  });
}

(async () => {
  console.log('[boot-smoke] Starte Server…');
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  const kill = () => { try { child.kill('SIGTERM'); } catch {} };
  process.on('exit', kill);

  try {
    await waitForReady(child);
    console.log('[boot-smoke] Server bereit. Teste Endpunkte…');

    const cfg = await get('/config');
    if (cfg.status !== 401) throw new Error(`/config ohne Session: erwarte 401, bekam ${cfg.status}`);
    try {
      const j = JSON.parse(cfg.body);
      if (j.error_code !== 'NOT_LOGGED_IN') throw new Error(`/config 401 erwartet error_code NOT_LOGGED_IN, bekam ${JSON.stringify(j)}`);
    } catch (e) {
      throw new Error(`/config 401 body ist kein JSON: ${e.message}`);
    }
    console.log('[boot-smoke] OK: /config → 401 JSON');

    const root = await get('/');
    if (root.status !== 302) throw new Error(`/: erwarte 302 Redirect, bekam ${root.status}`);
    if (!String(root.headers.location || '').startsWith('/auth/login')) {
      throw new Error(`/: erwarte Redirect nach /auth/login, bekam ${root.headers.location}`);
    }
    console.log('[boot-smoke] OK: / → 302 /auth/login');

    const jobs = await get('/jobs/status/nonexistent');
    if (jobs.status !== 401) throw new Error(`/jobs/*: erwarte 401, bekam ${jobs.status}`);
    console.log('[boot-smoke] OK: /jobs/* → 401 JSON');

    console.log('[boot-smoke] ALLE CHECKS GRÜN');
    kill();
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error(`[boot-smoke] FAIL: ${e.message}`);
    kill();
    cleanup();
    process.exit(1);
  }
})();
