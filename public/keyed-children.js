export function reconcileChildOrder(parent, desiredNodes) {
  let cursor = parent.firstChild;
  for (const node of desiredNodes) {
    if (node === cursor) {
      cursor = cursor.nextSibling;
      continue;
    }
    parent.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    parent.removeChild(cursor);
    cursor = next;
  }
}
