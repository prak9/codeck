const COMMAND_ID = /^[A-Za-z0-9._:-]{8,128}$/;
export const COMMAND_RECEIPT_TTL_MS = 10 * 60_000;

function cleanCommandId(value) {
  const commandId = typeof value === 'string' ? value.trim() : '';
  if (!COMMAND_ID.test(commandId)) throw new Error('Invalid command id');
  return commandId;
}

export function createCommandReceiptCache({
  ttlMs = COMMAND_RECEIPT_TTL_MS,
  maxEntries = 1_024,
  now = Date.now,
} = {}) {
  const receipts = new Map();

  function prune() {
    const currentTime = now();
    for (const [id, receipt] of receipts) {
      if (!receipt.pending && receipt.expiresAt <= currentTime) receipts.delete(id);
    }
  }

  function run(rawCommandId, fingerprint, operation) {
    const commandId = cleanCommandId(rawCommandId);
    prune();
    const existing = receipts.get(commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new Error('Command id was reused with a different payload'));
      }
      return existing.promise;
    }
    if (receipts.size >= maxEntries) {
      return Promise.reject(new Error('Command receipt cache reached capacity; retry later'));
    }

    const receipt = {
      fingerprint,
      pending: true,
      expiresAt: Number.POSITIVE_INFINITY,
      promise: null,
    };
    receipt.promise = Promise.resolve()
      .then(operation)
      .finally(() => {
        receipt.pending = false;
        receipt.expiresAt = now() + ttlMs;
      });
    receipts.set(commandId, receipt);
    return receipt.promise;
  }

  return { run };
}
