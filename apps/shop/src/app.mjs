// VulnMart target shop — application factory.
//
// T-01 tracer bullet: only the three health endpoints the instance contract
// defines (contracts/instance/instance-contract.md section 6 and architecture
// 07 section 3.2). No marketplace routes, database, flags or app events yet;
// those arrive in later Target-stream stories.
//
// No secrets or flag values are ever read or returned here (instance contract
// section 6: /version carries no secrets).

import { botScope, createBotQueue } from './challenges/c03b-bot.mjs';
import { buildId, catalogueVersion } from './build-id.mjs';
import express from 'express';
import { configureViews } from './web/views.mjs';
import { loadUser, checkCsrf } from './web/middleware.mjs';
import { registerRoutes } from './web/routes.mjs';
import { registerStaffRoutes } from './web/routes-staff.mjs';
import { registerSellerRoutes } from './web/routes-seller.mjs';
import { registerPageRoutes } from './web/routes-pages.mjs';
import { buildCatalogStore } from './challenges/c03a-catalog-search.mjs';
import { registerOpsRoutes } from './challenges/c05-ops-console.mjs';
import { registerAuthResetRoutes } from './challenges/c07-password-reset.mjs';
import { registerWebhookRoutes } from './challenges/c08-payment-webhook.mjs';
import { registerLegacyLoginRoute } from './challenges/c09-logging-failures.mjs';

// Build id and catalogue version: stamped into files by the image build (build-id.mjs), "dev" when nothing was stamped (tests, a local run).
const BUILD_ID = buildId();
const CATALOGUE_VERSION = catalogueVersion();

// Readiness gate. Outside an instance (tests, local runs) the shop is ready as
// soon as the process is up, so the default is always-ready. Inside an instance
// the entrypoint passes `isReady` from the instance layer (T-04): 200 only after
// the injector marker /run/vm/injected exists and the snapshot is open
// (instance contract section 5/6).
const ALWAYS_READY = () => true;

// Build the app. Pass { db } to mount the customer-facing shop (T-14); without
// a db only the health endpoints are served (the T-01 skeleton / health tests).
// Pass { isReady } (T-04) to gate /readyz behind the instance marker + snapshot;
// without it the shop is always-ready (tests / local runs). Pass { emit } to post
// app events to the sidecar on built flows (T-09, IF-4); without it emission is a
// no-op (local runs and tests that do not assert on events).
export function createApp({ db, isReady = ALWAYS_READY, emit = () => {}, challenges = {}, flagOf = () => undefined, bot = null, mockUrl = process.env.VM_MOCK_URL ?? 'http://mock-services', loginThrottle } = {}) {
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
    // In instance mode the snapshot db opens only after the injector marker; until
    // then answer marketplace routes with a clean 503 (the health endpoints above
    // are already served) rather than letting a db access throw a logged 500. In
    // tests / local runs `isReady` is always-ready, so this is a no-op there.
    app.use((_req, res, next) => {
      if (!isReady()) return res.status(503).json({ code: 'SHOP-NOT-READY', message: 'Not ready' });
      next();
    });
    app.use(loadUser(db));
    // C03 part B: a session minted for the support bot reaches one ticket page and the agent profile, nothing else (scope rule of challenge-specs 3.3).
    app.use(botScope);
    // The bot's visit queue exists in an instance (the bot controller is there); local runs and tests pass their own or none.
    const botQueue = bot ?? createBotQueue({ db, enabled: Boolean(process.env.VM_INSTANCE_ID) });
    // C05 (Security Misconfiguration): the ops console + verbose-error endpoint
    // are mounted before checkCsrf — they are anonymous and the verbose-error
    // probe posts raw JSON (no form token). All behaviour is build-gated in the
    // challenge module (404 + generic errors in the fixed/default build).
    registerOpsRoutes(app, db, { challenges, emit });
    // C07 (Authentication Failures): the anonymous password-reset endpoints and
    // the test-only mailbox, also before checkCsrf (pre-auth API).
    registerAuthResetRoutes(app, db, { challenges, emit });
    // C08 (Integrity Failures): the anonymous payment webhook (raw body for HMAC),
    // also before checkCsrf (the gateway/attacker posts a signed JSON body).
    registerWebhookRoutes(app, db, express, { challenges, emit });
    // C09 (Logging Failures): the legacy mobile login route (API), before checkCsrf.
    registerLegacyLoginRoute(app, db, express, { challenges, emit });
    app.use(checkCsrf);
    // C03 part A searches a SEPARATE read-only catalog store (no users/orders),
    // so even a successful injection cannot reach anything but merchandising data.
    // Built lazily on first search (after readiness) so instance mode, where the
    // snapshot db opens only after the marker, does not touch it at construction.
    registerRoutes(app, db, emit, { challenges, bot: botQueue, mockUrl, instanceId: process.env.VM_INSTANCE_ID, loginThrottle, getCatalogDb: () => buildCatalogStore(db, { flag: flagOf('C03') }) });
    registerStaffRoutes(app, db, { emit, challenges, flagOf });
    registerSellerRoutes(app, db, { emit, challenges });
    // The pages a learner reaches the weaknesses from (wallet, seller orders, pay step, sign-up, forgotten password, contact, app note).
    registerPageRoutes(app, db);
  }

  // Terminal handler: unknown routes return a JSON body, never a stack trace
  // (instance contract error-body style: code, message).
  app.use((_req, res) => {
    res.status(404).json({ code: 'SHOP-NOT-FOUND', message: 'Not found' });
  });

  // Error handler (4-arg): a thrown route error returns the same JSON shape
  // rather than Express's default non-JSON body, and never a stack trace to the
  // client (NFR-SEC-03). The error IS logged server-side so an unexpected 500 is
  // diagnosable (the instance log is not player-visible; it carries no flags).
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('shop 500:', err?.stack ?? err?.message ?? err);
    res.status(500).json({ code: 'SHOP-INTERNAL', message: 'Internal error' });
  });

  return app;
}
