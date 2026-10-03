// Hidden admin panel for tests and demos. The operator's browser is never allowed to reach this port.
import express from 'express';
import { getDB, resetDB } from './store.js';
import { clearSessions } from './sessions.js';
import { getFaults, setFaults, resetFaults, firedFaults } from './faults.js';
import { deliver, listDeliveries } from './deliveries.js';

export function adminApp() {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.post('/reset', (_req, res) => { resetDB(); clearSessions(); resetFaults(); res.json({ ok: true }); });
  app.get('/faults', (_req, res) => res.json({ faults: getFaults(), fired: firedFaults() }));
  app.post('/faults', (req, res) => res.json({ faults: setFaults(req.body ?? {}) }));
  app.get('/deliveries', (_req, res) => res.json(listDeliveries()));
  app.post('/deliver', (req, res) => { const r = deliver(String(req.body?.kind ?? '')); res.status(r.ok ? 200 : 409).json(r); });
  app.get('/state', (_req, res) => {
    const { docs: _docs, ...rest } = getDB();
    res.json(rest);
  });
  return app;
}
