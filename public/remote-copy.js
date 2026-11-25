import { autonomyDisplayText } from './remote-autonomy.js?v=11';

export function visibleOutput(text) {
  if (typeof text !== 'string') return '';
  return text.includes('codeck-autonomy') ? autonomyDisplayText(text) : text;
}

export function agentOutputText(turn) {
  return (turn?.items || [])
    .filter(item => item?.type === 'agentMessage')
    .map((item) => visibleOutput(item.text)).filter(Boolean)
    .join('\n\n');
}

export function latestAgentOutputText(turns) {
  for (let index = (turns?.length || 0) - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const text = agentOutputText(turn);
    if (text) return text;
  }
  return '';
}

function copyText(text) {
  const visible = visibleOutput(text);
  if (!visible) throw new Error('没有可复制的模型输出');
  return visible;
}

export async function writeAgentOutputToClipboard(source, clipboard = globalThis.navigator?.clipboard, Item = globalThis.ClipboardItem) {
  if (typeof source === 'function' && clipboard?.write && Item) {
    // WebKit requires the write to start during the click, before the RPC resolves.
    const data = source().then(text => new Blob([copyText(text)], { type: 'text/plain' }));
    const write = clipboard.write([new Item({ 'text/plain': data })]).catch(() => {
      throw new Error('复制失败：浏览器拒绝了剪贴板访问');
    });
    await Promise.all([data, write]);
    return;
  }
  if (!clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入');
  const text = copyText(typeof source === 'function' ? await source() : source);
  try {
    await clipboard.writeText(text);
  } catch {
    throw new Error('复制失败：浏览器拒绝了剪贴板访问');
  }
}
