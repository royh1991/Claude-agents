import { createApp } from './app.mjs';
import { resolveBackendPaths } from './lib/catalog.mjs';

const PORT = Number(process.env.PORT ?? 8081);
const app = createApp(process.env);
const paths = resolveBackendPaths(process.env);

app.listen(PORT, () => {
  console.log(`[gantry] console server on http://localhost:${PORT}`);
  console.log(`[gantry] backend package: ${paths.packageRoot}${paths.usingFixture ? ' (bundled fixture — set BACKEND_REPO_ROOT for a real checkout)' : ''}`);
  console.log(`[gantry] run mode: ${process.env.AIRFLOW_BASE_URL ? `airflow (${process.env.AIRFLOW_BASE_URL})` : 'mock (set AIRFLOW_BASE_URL to proxy a real Airflow)'}`);
});
