export function mountHistoryRoutes(app, { history, ownerOnly }) {
  const run = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(error => res.status(400).json({ error: error.message }));
  app.use('/api/history', ownerOnly, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/history/search', run(async (req, res) => res.json(await history.search(req.query.q, { provider: req.query.provider }))));
  app.get('/api/history/context/:id', run(async (req, res) => res.json(await history.context(req.params.id))));
  app.post('/api/history/commits', run(async (req, res) => res.json(await history.link(req.body || {}))));
}
