import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import https from 'node:https';
import { loadTlsOptions } from '../src/tls.js';

test('requires configured TLS certificate and key together', () => {
  assert.throws(() => loadTlsOptions({ CODECK_TLS_CERT: '/tmp/cert.pem' }), /必须同时设置/);
});

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeck-tls-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function assertValid(options) {
  const cert = new X509Certificate(options.cert);
  assert.ok(cert.checkPrivateKey(createPrivateKey(options.key)));
  assert.ok(cert.verify(cert.publicKey));
  assert.equal(cert.subject, cert.issuer);
  assert.ok(Date.parse(cert.validFrom) <= Date.now());
  assert.ok(Date.parse(cert.validTo) > Date.now());
  assert.equal(cert.checkHost('localhost', { subject: 'never' }), 'localhost');
  assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
}

test('generation uses a temporary config instead of addext and cleans it up', t => {
  const dir = directory(t);
  let config;
  const options = loadTlsOptions({ CODECK_DATA_DIR: dir }, { runOpenSSL(command, args, options) {
    assert.equal(command, 'openssl');
    assert.ok(!args.includes('-addext'));
    config = args[args.indexOf('-config') + 1];
    assert.match(fs.readFileSync(config, 'utf8'), /subjectAltName\s*=\s*DNS:localhost,IP:127\.0\.0\.1/);
    return execFileSync(command, args, options);
  } });
  assert.ok(config, 'the compatible OpenSSL invocation must be exercised');
  assertValid(options);
  assert.equal(fs.existsSync(config), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['cert.pem', 'key.pem']);
});

for (const problem of ['missing cert', 'missing key', 'corrupt cert', 'corrupt key', 'mismatched key', 'expired', 'missing SAN', 'wrong SAN', 'not self signed']) {
  test(`repairs managed TLS files: ${problem}`, t => {
    const dir = directory(t);
    const env = { CODECK_DATA_DIR: dir };
    const initial = loadTlsOptions(env);
    const certPath = path.join(dir, 'cert.pem');
    const keyPath = path.join(dir, 'key.pem');
    if (problem.startsWith('missing ') && !problem.includes('SAN')) fs.unlinkSync(problem.endsWith('cert') ? certPath : keyPath);
    if (problem.startsWith('corrupt')) fs.writeFileSync(problem.endsWith('cert') ? certPath : keyPath, 'invalid pem');
    if (problem === 'mismatched key') fs.copyFileSync(path.join(directoryWithCert(t), 'key.pem'), keyPath);
    if (problem === 'expired') execFileSync('openssl', ['x509', '-in', certPath, '-signkey', keyPath, '-days', '-1', '-out', certPath], { stdio: 'ignore' });
    if (problem === 'missing SAN' || problem === 'wrong SAN') {
      const config = path.join(directory(t), 'openssl.cnf');
      fs.writeFileSync(config, `[req]\nprompt=no\ndistinguished_name=dn\n${problem === 'wrong SAN' ? 'x509_extensions=ext\n' : ''}[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:example.invalid\n`);
      execFileSync('openssl', ['req', '-x509', '-new', '-key', keyPath, '-days', '825', '-config', config, '-out', certPath], { stdio: 'ignore' });
    }
    if (problem === 'not self signed') {
      const ca = directoryWithCert(t);
      const csr = path.join(ca, 'request.csr');
      const extensions = path.join(ca, 'extensions.cnf');
      fs.writeFileSync(extensions, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
      execFileSync('openssl', ['req', '-new', '-key', keyPath, '-subj', '/CN=Codeck', '-out', csr], { stdio: 'ignore' });
      execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', path.join(ca, 'cert.pem'), '-CAkey', path.join(ca, 'key.pem'), '-set_serial', '2', '-days', '825', '-extfile', extensions, '-out', certPath], { stdio: 'ignore' });
      const signed = new X509Certificate(fs.readFileSync(certPath));
      assert.equal(signed.subject, signed.issuer);
      assert.equal(signed.checkIP('127.0.0.1'), '127.0.0.1');
      assert.equal(signed.verify(signed.publicKey), false);
    }
    const repaired = loadTlsOptions(env);
    assertValid(repaired);
    assert.notDeepEqual(repaired.cert, initial.cert);
    assert.deepEqual(loadTlsOptions(env).cert, repaired.cert);
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['cert.pem', 'key.pem']);
  });
}

function directoryWithCert(t) {
  const dir = directory(t);
  loadTlsOptions({ CODECK_DATA_DIR: dir });
  return dir;
}

for (const failure of ['command fails', 'invalid generated files']) {
  test(`failed repair preserves existing files and removes temporary files: ${failure}`, t => {
    const dir = directory(t);
    fs.writeFileSync(path.join(dir, 'cert.pem'), 'old invalid cert');
    fs.writeFileSync(path.join(dir, 'key.pem'), 'old invalid key');
    assert.throws(() => loadTlsOptions({ CODECK_DATA_DIR: dir }, { runOpenSSL(_command, args) {
      if (failure === 'command fails') throw new Error('OpenSSL failed');
      fs.writeFileSync(args[args.indexOf('-out') + 1], 'bad output');
      fs.writeFileSync(args[args.indexOf('-keyout') + 1], 'bad key');
    } }));
    assert.equal(fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'), 'old invalid cert');
    assert.equal(fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'), 'old invalid key');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['cert.pem', 'key.pem']);
  });
}

test('explicit certificate paths remain caller-owned and are never automatically replaced', t => {
  const dir = directory(t);
  const certPath = path.join(dir, 'custom.pem');
  const keyPath = path.join(dir, 'custom-key.pem');
  fs.writeFileSync(certPath, 'caller cert');
  fs.writeFileSync(keyPath, 'caller key');
  const options = loadTlsOptions({ CODECK_TLS_CERT: certPath, CODECK_TLS_KEY: keyPath }, { runOpenSSL() { assert.fail('must not run'); } });
  assert.equal(options.generated, false);
  assert.equal(options.cert.toString(), 'caller cert');
  assert.equal(options.key.toString(), 'caller key');
});

test('generated certificates support verified HTTPS for localhost and loopback IP', async t => {
  const options = loadTlsOptions({ CODECK_DATA_DIR: directory(t) });
  const server = https.createServer(options, (_request, response) => response.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const servername of ['localhost', '']) {
      await new Promise((resolve, reject) => {
        https.get({ hostname: '127.0.0.1', port: server.address().port, servername, ca: options.cert, agent: false }, response => {
          assert.equal(response.statusCode, 200);
          response.resume();
          response.on('end', resolve);
        }).on('error', reject);
      });
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
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
