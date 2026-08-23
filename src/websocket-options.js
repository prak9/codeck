export const AGENT_WEBSOCKET_OPTIONS = Object.freeze({
  maxPayload: 128 * 1024,
  perMessageDeflate: Object.freeze({
    threshold: 4 * 1024,
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
  }),
});
