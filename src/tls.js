import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function validManagedCertificate(cert, key) {
  try {
    const certificate = new X509Certificate(cert);
    const now = Date.now();
    return Date.parse(certificate.validFrom) <= now && now < Date.parse(certificate.validTo)
      && certificate.checkPrivateKey(createPrivateKey(key))
      && certificate.subject === certificate.issuer && certificate.verify(certificate.publicKey)
      && certificate.checkHost('localhost', { subject: 'never' }) === 'localhost'
      && certificate.checkIP('127.0.0.1') === '127.0.0.1';
  } catch {
    return false;
  }
}

function readManagedPair(certPath, keyPath) {
  try {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), generated: true };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function loadTlsOptions(env = process.env, { runOpenSSL = execFileSync } = {}) {
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

  const existing = readManagedPair(certPath, keyPath);
  if (existing && validManagedCertificate(existing.cert, existing.key)) return existing;

  // Older OpenSSL releases lack req -addext. Keep configuration and private-key
  // generation in a private, same-filesystem staging directory instead.
  const temporaryDir = fs.mkdtempSync(path.join(dataDir, '.tls-'));
  try {
    const temporaryCert = path.join(temporaryDir, 'cert.pem');
    const temporaryKey = path.join(temporaryDir, 'key.pem');
    const config = path.join(temporaryDir, 'openssl.cnf');
    fs.writeFileSync(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=Codeck\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n', { mode: 0o600 });
    runOpenSSL('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '825',
      '-config', config,
      '-keyout', temporaryKey, '-out', temporaryCert,
    ], { stdio: 'ignore' });
    const replacement = readManagedPair(temporaryCert, temporaryKey);
    if (!replacement || !validManagedCertificate(replacement.cert, replacement.key)) {
      throw new Error('OpenSSL 生成的 TLS 证书无效，原证书未替换');
    }
    fs.chmodSync(temporaryKey, 0o600);
    fs.renameSync(temporaryKey, keyPath);
    fs.renameSync(temporaryCert, certPath);
    return replacement;
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}
