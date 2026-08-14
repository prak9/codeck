import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function loadTlsOptions(env = process.env) {
  const configuredCert = env.CODECK_TLS_CERT;
  const configuredKey = env.CODECK_TLS_KEY;
  if (Boolean(configuredCert) !== Boolean(configuredKey)) {
    throw new Error('CODECK_TLS_CERT 和 CODECK_TLS_KEY 必须同时设置');
  }

  if (configuredCert && configuredKey) {
    return { cert: fs.readFileSync(configuredCert), key: fs.readFileSync(configuredKey), generated: false };
  }

  const dataDir = env.CODECK_DATA_DIR || path.join(os.homedir(), '.codeck');
  const certPath = path.join(dataDir, 'cert.pem');
  const keyPath = path.join(dataDir, 'key.pem');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '825',
      '-subj', '/CN=Codeck',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', keyPath, '-out', certPath,
    ], { stdio: 'ignore' });
    fs.chmodSync(keyPath, 0o600);
  }

  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), generated: true };
}
