export function clipboardFiles(data) {
  const files = Array.from(data?.items || [])
    .filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  return files.length ? files : Array.from(data?.files || []);
}

export async function readClipboardPayload(clipboard = navigator.clipboard) {
  if (!clipboard?.read) return { images: [], text: await clipboard.readText() };
  const items = await clipboard.read();
  const images = [];
  let text = '';
  for (const item of items) {
    const type = item.types.find(type => type.startsWith('image/'));
    if (type) images.push(await item.getType(type));
    else if (item.types.includes('text/plain')) text += await (await item.getType('text/plain')).text();
  }
  return { images, text: images.length ? '' : text };
}
