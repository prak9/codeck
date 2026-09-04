const BOUNDED_COMPRESSION = Object.freeze({
  threshold: 4 * 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
});

export const AGENT_WEBSOCKET_OPTIONS = Object.freeze({
  maxPayload: 128 * 1024,
  perMessageDeflate: BOUNDED_COMPRESSION,
});

// Full-screen TUIs repeatedly repaint the same ANSI text. Compress only larger frames:
// keypresses stay uncompressed and latency-sensitive, while WAN redraw traffic shrinks.
export const TERMINAL_WEBSOCKET_OPTIONS = Object.freeze({
  perMessageDeflate: BOUNDED_COMPRESSION,
});
