export function agentOutputText(turn) {
  return (turn?.items || [])
    .filter((item) => item?.type === 'agentMessage' && typeof item.text === 'string' && item.text)
    .map((item) => item.text)
    .join('\n\n');
}

export async function writeAgentOutputToClipboard(text, clipboard = globalThis.navigator?.clipboard) {
  if (!text) throw new Error('没有可复制的模型输出');
  if (!clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入');
  try {
    await clipboard.writeText(text);
  } catch {
    throw new Error('复制失败：浏览器拒绝了剪贴板访问');
  }
}
