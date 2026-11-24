import MarkdownIt from './vendor/markdown-it.js?v=15.0.3';

const markdown = new MarkdownIt({ html: false, breaks: true });
// Only Codeck's existing image loader may fetch previews, including signed local images.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const escape = markdown.utils.escapeHtml;
  return `<span data-image-src="${escape(token.attrGet('src'))}">${escape(token.content)}</span>`;
};

export function renderReplyMarkdown(node, text, images, makeFigure) {
  node.innerHTML = markdown.render(text);
  const links = [...node.querySelectorAll('a, [data-image-src]')];
  if (images?.length) {
    const byTarget = new Map();
    for (const link of links) {
      const target = link.dataset.imageSrc ?? link.getAttribute('href');
      if (!byTarget.has(target)) byTarget.set(target, link);
    }
    for (const ref of images) {
      if (ref.end > text.length) continue;
      // The source may use a relative spelling (e.g. ~/plot.png), while ref.path is canonical.
      const inline = Number.isInteger(ref.start) && markdown.parseInline(text.slice(ref.start, ref.end), {})[0]?.children?.[0];
      const target = inline && (inline.attrGet('src') || inline.attrGet('href'));
      const placeholder = target && byTarget.get(target);
      if (placeholder) placeholder.replaceWith(makeFigure(ref));
      else node.append(makeFigure(ref));
    }
  }
  for (const link of links) {
    if (!node.contains(link)) continue;
    if (link.tagName === 'A' && /^(?:https?:\/\/|mailto:)/i.test(link.getAttribute('href'))) {
      link.target = '_blank'; link.rel = 'noopener noreferrer';
    } else link.replaceWith(...link.childNodes);
  }
  for (const table of node.querySelectorAll('table')) {
    const scroller = document.createElement('div');
    scroller.className = 'reply-table-scroll'; scroller.tabIndex = 0;
    scroller.setAttribute('role', 'region'); scroller.setAttribute('aria-label', '表格');
    table.replaceWith(scroller); scroller.append(table);
  }
}
