export function createOutboxDispatcher({
  store,
  memory = null,
  deliverTelegram = null,
  publishDigestPage = null,
  now = Date.now,
}) {
  let ticking = null;

  async function deliverItem(item, mergedItems = [item]) {
    const currentNow = now();
    const title = mergedItems.length > 1 ? `${item.title}（合并 ${mergedItems.length} 条）` : item.title;
    const body = mergedItems.length > 1
      ? mergedItems.map(i => `- **${i.title}**：${i.contentMd}`).join('\n')
      : item.contentMd;

    try {
      if ((item.channel === 'telegram' || item.channel === 'all') && deliverTelegram) {
        await deliverTelegram({ title, contentMd: body, priority: item.priority, items: mergedItems });
      }
      for (const m of mergedItems) {
        store.updateOutboxStatus(m.id, { status: 'sent', error: null, incrementAttempts: true, now: currentNow });
      }
      if (memory) {
        await memory.appendReported({
          title,
          summary: body.replace(/\s+/g, ' ').slice(0, 160),
          ref: item.meta?.url || item.scopeKey,
          at: new Date(currentNow).toISOString(),
        }).catch(() => {});
      }
      return { delivered: mergedItems.length, failed: 0 };
    } catch (error) {
      for (const m of mergedItems) {
        store.updateOutboxStatus(m.id, {
          status: m.attempts + 1 >= 3 ? 'failed' : 'pending',
          error: error?.message || String(error),
          incrementAttempts: true,
          now: currentNow,
        });
      }
      return { delivered: 0, failed: mergedItems.length };
    }
  }

  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const currentNow = now();
      const pending = store.listOutbox({ status: 'pending', limit: 100 })
        .filter(item => item.deliverAfter <= currentNow && item.priority !== 'digest');

      let delivered = 0;
      let failed = 0;

      // Urgent items deliver immediately, one by one.
      const urgent = pending.filter(i => i.priority === 'urgent');
      for (const item of urgent) {
        const res = await deliverItem(item, [item]);
        delivered += res.delivered;
        failed += res.failed;
      }

      // Notify items are merged per scopeKey+channel to prevent spam.
      const notify = pending.filter(i => i.priority === 'notify');
      const groups = new Map();
      for (const item of notify) {
        const key = `${item.scopeKey}::${item.channel}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      for (const group of groups.values()) {
        const res = await deliverItem(group[0], group);
        delivered += res.delivered;
        failed += res.failed;
      }

      return { delivered, failed };
    })().finally(() => { ticking = null; });
    return ticking;
  }

  async function compileDigest({ title = '每日简报（Digest）' } = {}) {
    const currentNow = now();
    const pending = store.listOutbox({ status: 'pending', priority: 'digest', limit: 200 });
    if (!pending.length) {
      return { count: 0, title, digestMd: '', pageUrl: null };
    }
    const lines = [
      `# ${title}`,
      '',
      `生成时间：${new Date(currentNow).toISOString()}`,
      `汇总条目：${pending.length}`,
      '',
    ];
    for (const item of pending) {
      lines.push(`## ${item.title} (${item.scopeKey})`);
      lines.push(item.contentMd || '（无正文）');
      lines.push('');
    }
    const digestMd = lines.join('\n');

    let pageUrl = null;
    if (publishDigestPage) {
      const published = await publishDigestPage({ title, digestMd, items: pending, now: currentNow });
      pageUrl = published?.url || null;
    }

    for (const item of pending) {
      store.updateOutboxStatus(item.id, { status: 'digested', error: null, incrementAttempts: true, now: currentNow });
    }
    if (memory) {
      await memory.appendReported({
        title,
        summary: `汇总 ${pending.length} 条后台进展`,
        ref: pageUrl || 'digest',
        at: new Date(currentNow).toISOString(),
      }).catch(() => {});
    }
    return { count: pending.length, title, digestMd, pageUrl };
  }

  return { tick, compileDigest };
}
