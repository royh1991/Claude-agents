import { Store } from './lib/store.mjs';
import { createApp } from './app.mjs';
import { seed } from './seed.mjs';

const PORT = Number(process.env.PORT ?? 8081);

const store = new Store();
if (store.isEmpty()) {
  seed(store);
  console.log('[gantry] seeded demo workspace');
}

const app = createApp(store);

// Scheduler loop: fires due deployments (the console-side bookkeeping only —
// actual execution happens when an Airflow worker claims the queued session).
setInterval(() => {
  try {
    app.locals.tickSchedules();
  } catch (err) {
    console.error('[gantry] scheduler tick failed:', err);
  }
}, 20000);

app.listen(PORT, () => {
  console.log(`[gantry] control plane listening on http://localhost:${PORT}`);
});
