import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTlsOptions } from '../src/tls.js';

test('requires configured TLS certificate and key together', () => {
  assert.throws(() => loadTlsOptions({ CODECK_TLS_CERT: '/tmp/cert.pem' }), /必须同时设置/);
});

test('generates and reuses a persistent self-signed certificate', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-tls-'));
  try {
    const first = loadTlsOptions({ CODECK_DATA_DIR: dataDir });
    const second = loadTlsOptions({ CODECK_DATA_DIR: dataDir });
    assert.match(first.cert.toString(), /BEGIN CERTIFICATE/);
    assert.match(first.key.toString(), /BEGIN PRIVATE KEY/);
    assert.deepEqual(second.cert, first.cert);
    assert.equal(fs.statSync(path.join(dataDir, 'key.pem')).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
