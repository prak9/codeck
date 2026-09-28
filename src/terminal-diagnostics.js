// Keep only geometry/lifecycle metadata, never keystrokes or terminal contents.
// Dump on a detected layout failure, rather than logging every resize indefinitely.
export function createTerminalDiagnostics({ maxSessions = 32, maxEvents = 24 } = {}) {
  const sessions = new Map();
  return {
    record(session, event, details = {}) {
      const events = sessions.get(session) || [];
      sessions.delete(session);
      events.push({ at: new Date().toISOString(), event, ...details });
      if (events.length > maxEvents) events.shift();
      sessions.set(session, events);
      if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    },
    read(session) { return (sessions.get(session) || []).map(event => ({ ...event })); },
  };
}

export const terminalDiagnostics = createTerminalDiagnostics();
