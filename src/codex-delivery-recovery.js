import { userMessageText } from '../public/agent-model.js';

const RECEIPT_LIMIT = 1_024;
const RECEIPT_TTL_MS = 24 * 60 * 60_000;
const CONFIRMATION_WAIT_MS = 60_000;
const PAGE_BUDGET = 32;

// Delivery evidence is owned by the server, not by each browser's optimistic
// bubbles. This only reads the store; it never submits or retries terminal input.
export class CodexDeliveryRecovery {
  constructor({ read, observe, changed = () => {}, now = Date.now }) {
    this.read = read;
    this.observe = observe;
    this.changed = changed;
    this.now = now;
    this.receipts = new Map();
    this.jobs = new Map();
    this.active = null;
    this.closed = false;
  }

  record(receipt) {
    if (this.closed || !receipt.commandId || receipt.baselineVersion !== 2
      || !receipt.threadId || !receipt.text || receipt.text.startsWith('/')) return false;
    if (this.receipts.has(receipt.commandId)) return true;
    this.#prune();
    while (this.receipts.size >= RECEIPT_LIMIT) this.receipts.delete(this.receipts.keys().next().value);
    this.receipts.set(receipt.commandId, { ...receipt,
      createdAt: this.now(), unknown: receipt.restored === true });
    // A new send must not inherit the previous send's retry delay. The in-flight
    // job remains owned until it settles, so a stale read cannot erase this wakeup.
    const job = this.jobs.get(receipt.threadId);
    if (job) { job.wakeRequested = true; job.nextAt = 0; }
    return true;
  }

  #prune() {
    for (const [id, receipt] of this.receipts) {
      if (this.now() - receipt.createdAt >= RECEIPT_TTL_MS) this.receipts.delete(id);
    }
    const threads = new Set([...this.receipts.values()].map(receipt => receipt.threadId));
    for (const id of this.jobs.keys()) if (!threads.has(id)) this.jobs.delete(id);
  }

  update(threadId, turns, cachedTurns = new Map()) {
    this.#prune();
    const receipts = [...this.receipts.values()].filter(receipt => receipt.threadId === threadId);
    const claimed = new Set(receipts.map(receipt => receipt.itemId).filter(Boolean));
    const proposals = [];
    const groups = new Map();
    for (const receipt of receipts) {
      const key = JSON.stringify([receipt.baselineUserMessageId, receipt.baselineTurnId, receipt.text]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(receipt);
    }
    for (const group of groups.values()) {
      if (group.every(receipt => receipt.itemId)) continue;
      const baseline = group[0];
      // A cache Map has insertion order, not transcript chronology. Only prepend
      // this receipt's missing anchor turn, never all cached historical turns.
      const cached = cachedTurns.get(baseline.baselineTurnId);
      const sourceTurns = cached && !turns.some(turn => turn.id === baseline.baselineTurnId)
        ? [{ id: baseline.baselineTurnId, items: cached.items }, ...turns] : turns;
      const users = sourceTurns.flatMap((turn, turnIndex) => (turn.items || [])
        .filter(item => item.type === 'userMessage' && !item.delivery)
        .map(item => ({ item, turnIndex })));
      let candidates;
      if (baseline.baselineUserMessageId) {
        const index = users.findIndex(({ item }) => item.id === baseline.baselineUserMessageId);
        if (index < 0) continue;
        candidates = users.slice(index + 1);
      } else if (baseline.baselineTurnId) {
        const index = sourceTurns.findIndex(turn => turn.id === baseline.baselineTurnId);
        if (index < 0) continue;
        candidates = users.filter(entry => entry.turnIndex > index);
      } else {
        candidates = users;
      }
      candidates = candidates.filter(({ item }) => userMessageText(item) === baseline.text && item.id);
      let ordinal = -1;
      const assignments = group.map(receipt => {
        ordinal = Math.max(ordinal + 1, receipt.baselineMatchingTextCount || 0);
        return { receipt, candidate: candidates[ordinal]?.item };
      });
      // Two browsers can submit ordinal zero. One actual input is not evidence
      // for both commands; wait for enough distinct messages before assigning.
      if (assignments.some(entry => !entry.candidate)) continue;
      proposals.push(...assignments.filter(({ receipt, candidate }) => !receipt.itemId && !claimed.has(candidate.id)));
    }
    const counts = new Map();
    for (const { candidate } of proposals) counts.set(candidate.id, (counts.get(candidate.id) || 0) + 1);
    for (const { receipt, candidate } of proposals) {
      if (counts.get(candidate.id) === 1) receipt.itemId = candidate.id;
    }
    const pending = receipts.filter(receipt => !receipt.itemId);
    const job = this.jobs.get(threadId);
    if (!pending.length && this.active !== job) this.jobs.delete(threadId);
    if (!this.closed && pending.length && !this.active && (!job || this.now() >= job.nextAt)) {
      const targets = new Set();
      for (const receipt of pending) {
        if (receipt.baselineTurnId) targets.add(receipt.baselineTurnId);
        const index = turns.findIndex(turn => turn.id === receipt.baselineTurnId);
        for (const turn of turns.slice(Math.max(0, index))) if (!turn.deliveryOnly) targets.add(turn.id);
      }
      if (targets.size) {
        const next = job || { attempts: 0 };
        if (!next.scan?.length) {
          next.scan = [...targets].map(turnId => ({ turnId, cursor: undefined, visited: new Set(), items: [] }));
          next.attempts++;
        }
        next.nextAt = Infinity;
        this.jobs.set(threadId, next);
        this.active = next;
        // Do not await store recovery in openThread or in the snapshot loader.
        this.#recover(threadId, next);
      }
    }
    return this.snapshot(threadId);
  }

  snapshot(threadId) {
    const receipts = [...this.receipts.values()].filter(receipt => receipt.threadId === threadId);
    return {
      deliveryConfirmationMode: 'server',
      deliveryConfirmations: receipts.filter(receipt => receipt.itemId)
        .map(({ commandId, itemId }) => ({ commandId, itemId })),
      unconfirmedDeliveryIds: receipts.filter(receipt => !receipt.itemId
        && (receipt.unknown || this.now() - receipt.createdAt >= CONFIRMATION_WAIT_MS))
        .map(receipt => receipt.commandId),
    };
  }

  dismiss(threadId, commandId) {
    if (this.receipts.get(commandId)?.threadId === threadId) this.receipts.delete(commandId);
    this.#prune();
  }

  async #recover(threadId, job) {
    let pages = 0;
    let changed = false;
    try {
      while (job.scan.length) {
        const scan = job.scan[0];
        const { turnId, visited, items } = scan;
        do {
          if (this.closed || pages++ >= PAGE_BUDGET) return;
          const cursor = scan.cursor;
          if (visited.has(cursor)) throw new Error('Codex delivery cursor did not advance');
          const controller = new AbortController();
          job.controller = controller;
          const timer = setTimeout(() => controller.abort(new Error('Codex delivery read timed out')), 10_000);
          timer.unref?.();
          let page;
          try {
            page = await this.read({ threadId, turnId, limit: 100, sortDirection: 'desc',
              ...(cursor ? { cursor } : {}) }, { signal: controller.signal });
          } finally {
            clearTimeout(timer);
            job.controller = null;
          }
          if (this.closed) return;
          visited.add(cursor);
          for (const entry of page.data || []) {
            if (entry.turnId !== turnId || !entry.item?.id) continue;
            const item = entry.item;
            // Preserve placement IDs without keeping large tool/answer payloads.
            items.push(item.type === 'userMessage' ? item : { id: item.id });
          }
          scan.cursor = page.nextCursor;
        } while (scan.cursor);
        this.observe(threadId, { id: turnId, items: items.reverse() });
        job.scan.shift();
        changed = true;
      }
    } catch {
      job.attempts++;
      // A store restart may invalidate cursors. Restart only the unfinished turn;
      // already committed turns do not need to be scanned again in this pass.
      const scan = job.scan[0];
      if (scan) { scan.cursor = undefined; scan.visited.clear(); scan.items = []; }
      // Read failures are not evidence of failed delivery. Keep the receipt and
      // let the next subscribed snapshot retry with backoff.
    } finally {
      job.nextAt = job.wakeRequested ? 0
        : this.now() + Math.min(60_000, 1_000 * 2 ** Math.min(job.attempts - 1, 6));
      job.wakeRequested = false;
      if (this.active === job) this.active = null;
      if (changed && !this.closed) this.changed(threadId);
    }
  }

  close() {
    this.closed = true;
    this.active?.controller?.abort(new Error('Codex delivery recovery closed'));
    this.receipts.clear();
    this.jobs.clear();
  }
}
