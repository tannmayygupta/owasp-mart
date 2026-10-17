// Nunjucks view setup for the shop (T-14, ADR note in the plan). Autoescape is
// ON (the correct flow escapes all user content; the C03 XSS challenge turns it
// off in one isolated spot later). Pure JS, no native build.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nunjucks from 'nunjucks';
import { BRANDING } from '../identity/branding.mjs';

const VIEWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'views');

// Configure Nunjucks as Express's view engine and add a cents->currency filter.
export function configureViews(app) {
  const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, express: app, noCache: true });
  env.addFilter('cents', (c) => `$${(Number(c || 0) / 100).toFixed(2)}`);
  env.addGlobal('brand', BRANDING);
  app.set('view engine', 'njk');
  return env;
}
