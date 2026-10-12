// VulnMart target shop — application factory.
//
// T-01 tracer bullet: only the three health endpoints the instance contract
// defines (contracts/instance/instance-contract.md section 6 and architecture
// 07 section 3.2). No marketplace routes, database, flags or app events yet;
// those arrive in later Target-stream stories.
//
// No secrets or flag values are ever read or returned here (instance contract
// section 6: /version carries no secrets).

import express from 'express';
import { configureViews } from './web/views.mjs';
import { loadUser, checkCsrf } from './web/middleware.mjs';
import { registerRoutes } from './web/routes.mjs';
import { registerStaffRoutes } from './web/routes-staff.mjs';

// Build id and catalogue version are supplied by the environment at run time.
// They default to "dev" so the skeleton answers even outside an instance.
const BUILD_ID = process.env.VM_BUILD_ID ?? 'dev';
const CATALOGUE_VERSION = process.env.VM_CATALOG_VERSION ?? 'dev';

// Readiness gate. Outside an instance (tests, local runs) the shop is ready as
// soon as the process is up, so the default is always-ready. Inside an instance
// the entrypoint passes `isReady` from the instance layer (T-04): 200 only after
// the injector marker /run/vm/injected exists and the snapshot is open
// (instance contract section 5/6).
const ALWAYS_READY = () => true;

// Build the app. Pass { db } to mount the customer-facing shop (T-14); without
// a db only the health endpoints are served (the T-01 skeleton / health tests).
// Pass { isReady } (T-04) to gate /readyz behind the instance marker + snapshot;
// without it the shop is always-ready (tests / local runs).
export function createApp({ db, isReady = ALWAYS_READY } = {}) {
  const app = express();

  // Do not advertise the framework.
  app.disable('x-powered-by');

  // GET /healthz — the process is up.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // GET /readyz — 200 when the shop can serve. The shop's Docker healthcheck
  // points here (instance contract section 6: "healthy" means "ready").
  app.get('/readyz', (_req, res) => {
    if (isReady()) {
      res.status(200).json({ status: 'ready' });
    } else {
      res.status(503).json({ status: 'not-ready' });
    }
  });

  // GET /version — build id and catalogue version, never a secret.
  app.get('/version', (_req, res) => {
    res.status(200).json({ build: BUILD_ID, catalogue_version: CATALOGUE_VERSION });
  });

  // The customer-facing marketplace (T-14), mounted only when a db is given.
  if (db) {
    configureViews(app);
    app.use(express.urlencoded({ extended: false }));
    app.use(loadUser(db));
    app.use(checkCsrf);
    registerRoutes(app, db);
    registerStaffRoutes(app, db);
  }

  // Terminal handler: unknown routes return a JSON body, never a stack trace
  // (instance contract error-body style: code, message).
  app.use((_req, res) => {
    res.status(404).json({ code: 'SHOP-NOT-FOUND', message: 'Not found' });
  });

  // Error handler (4-arg): a thrown route error returns the same JSON shape
  // rather than Express's default non-JSON body, and never a stack trace
  // (NFR-SEC-03). Kept minimal here; routes that throw arrive in later stories.
  // eslint-disable-next-line no-unused-vars
  app.use((_err, _req, res, _next) => {
    res.status(500).json({ code: 'SHOP-INTERNAL', message: 'Internal error' });
  });

  return app;
}
