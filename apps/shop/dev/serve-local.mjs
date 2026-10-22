// Serves the vulnerable shop on PORT (default 3200) for the browser walkthrough (tests/web-e2e/shop): the real shop app over a seeded in-memory database, every
// challenge on its vulnerable build, the database placements an instance would make, and no bot. Test use only.
import { openDb } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { seedAll } from '../seed/registry.mjs';
import { createApp } from '../src/app.mjs';
import { plantDatabase } from '../src/instance/placements.mjs';

const KEYS = ['C01', 'C02', 'C03A', 'C03B', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11'];
const db = openDb(':memory:');
migrate(db);
await seedAll(db);
plantDatabase(db, { C01: 'C01-FLAG-IN-THE-NOTE', C02: 'C02-FLAG-IN-THE-CARD', C04: 'C04-SENTINEL' });
const app = createApp({ db, challenges: Object.fromEntries(KEYS.map((k) => [k, 'vulnerable'])) });
const port = Number(process.env.PORT ?? 3200);
app.listen(port, '127.0.0.1', () => console.log(`shop for the walkthrough on ${port}`));
