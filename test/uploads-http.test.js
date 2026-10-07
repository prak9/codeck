import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveUploadStream } from '../src/uploads.js';

test('HTTP streaming returns 413 for chunked overflow and saves a complete upload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeck-http-upload-'));
  const server = http.createServer(async (req, res) => {
    try {
      await saveUploadStream(req, { root, fileName: 'payload', maxBytes: 16 });
      res.writeHead(201).end('saved');
    } catch (error) { res.writeHead(error.status || 400).end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const upload = chunks => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST' }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
  try {
    assert.equal(await upload([Buffer.alloc(8), Buffer.alloc(8)]), 201);
    assert.equal(await upload([Buffer.alloc(8), Buffer.alloc(9)]), 413);
    assert.equal((await fs.stat(path.join(root, 'payload'))).size, 16);
    assert.deepEqual(await fs.readdir(root), ['payload']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
