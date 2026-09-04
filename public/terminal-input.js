// xterm 5.x answers a secondary-device-attributes query with ESC[>0;276;0c.
// If that reply lands between remotely injected text and Enter, some Agent TUIs keep
// the printable tail in the submitted prompt. Strip only this exact known suffix; broad
// ANSI cleanup would risk changing legitimate user text.
const XTERM_DEVICE_ATTRIBUTES_RESIDUE = /(\S)(?:\u001b\[>)?0;276;0c$/u;

export function stripTerminalInputResidue(value) {
  if (typeof value !== 'string') return value;
  const cleaned = value.replace(XTERM_DEVICE_ATTRIBUTES_RESIDUE, '$1');
  return cleaned || value;
}
