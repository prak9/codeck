export function filterSessionNames(sessions, query, name = session => session.name) {
  const keyword = String(query || '').trim().toLowerCase();
  return keyword ? sessions.filter(session => String(name(session) || '').toLowerCase().includes(keyword)) : sessions;
}
