import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export function codexAppServerEnvironment(environment = process.env) {
  const tmpdir = environment.CODECK_CODEX_TMPDIR;
  if (!tmpdir) return environment;
  return { ...environment, TMPDIR: tmpdir, TMP: tmpdir, TEMP: tmpdir };
}

function responseError(error) {
  if (typeof error === 'string') return new Error(error);
  const message = error?.message || 'Codex app-server request failed';
  const result = new Error(message);
  if (error?.code != null) result.code = error.code;
  if (error?.data != null) result.data = error.data;
  return result;
}

export class CodexAppServer extends EventEmitter {
  constructor({ spawnProcess } = {}) {
    super();
    this.spawnProcess = spawnProcess || (() => spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: codexAppServerEnvironment(),
    }));
    this.process = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.closed = false;
  }

  async request(method, params = {}) {
    if (this.closed) throw new Error('Codex app-server is closed');
    await this.#ensureReady();
    return this.#sendRequest(method, params);
  }

  async respond(id, result) {
    if (!this.process || this.process.stdin?.destroyed) throw new Error('Codex app-server is not running');
    this.#write({ id, result });
  }

  async respondError(id, code, message) {
    if (!this.process || this.process.stdin?.destroyed) throw new Error('Codex app-server is not running');
    this.#write({ id, error: { code, message } });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const processHandle = this.process;
    this.process = null;
    this.ready = null;
    this.#rejectPending(new Error('Codex app-server was closed'));
    if (processHandle && !processHandle.killed) {
      processHandle.stdin?.end?.();
      processHandle.kill?.();
    }
  }

  #ensureProcess() {
    if (this.process) return;
    const processHandle = this.spawnProcess();
    if (!processHandle?.stdin || !processHandle?.stdout) {
      throw new Error('Unable to start Codex app-server: stdio is unavailable');
    }
    this.process = processHandle;
    this.stdoutBuffer = '';
    processHandle.stdout.on('data', (chunk) => this.#consumeStdout(chunk));
    processHandle.stderr?.on?.('data', (chunk) => this.emit('stderr', String(chunk)));
    processHandle.once('error', (error) => this.#handleExit(error));
    processHandle.once('close', (code, signal) => {
      const suffix = signal ? ` (signal ${signal})` : '';
      this.#handleExit(new Error(`Codex app-server exited with code ${code ?? 'unknown'}${suffix}`));
    });
  }

  #ensureReady() {
    if (this.ready) return this.ready;
    this.#ensureProcess();
    this.ready = this.#sendRequest('initialize', {
      clientInfo: { name: 'codeck', title: 'Codeck', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }).then((result) => {
      this.#write({ method: 'initialized', params: {} });
      return result;
    }).catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  #sendRequest(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise((resolve, reject) => this.pending.set(String(id), { resolve, reject, method }));
    try {
      this.#write({ id, method, params });
    } catch (error) {
      this.pending.delete(String(id));
      return Promise.reject(error);
    }
    return result;
  }

  #write(message) {
    if (!this.process || this.process.stdin?.destroyed) throw new Error('Codex app-server is not running');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #consumeStdout(chunk) {
    this.stdoutBuffer += String(chunk);
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.emit('protocolError', new Error(`Invalid JSON from Codex app-server: ${error.message}`));
        continue;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    if (message.id != null && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(responseError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      this.emit('serverRequest', message);
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  #handleExit(error) {
    if (!this.process) return;
    this.process = null;
    this.ready = null;
    this.#rejectPending(error);
    if (!this.closed) this.emit('exit', error);
  }

  #rejectPending(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
