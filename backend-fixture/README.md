# Backend fixture

A development replica of the `credible-bi-airflow-triage` backend package
(`dags/credible_bi_airflow_triage/`), containing only the **catalog files the
console reads and writes**: agent packs, skills, tools, response formats,
environments, and guardrails. No Python runtime code lives here.

The console's server points at a backend checkout via `BACKEND_REPO_ROOT`
(+ `BACKEND_PACKAGE_DIR`, default `dags/credible_bi_airflow_triage`). When
unset, it falls back to this fixture so the console runs standalone.

File shapes follow the backend contract (CLAUDE.md §8). If the real backend
diverges, fix this fixture to match the backend — never the other way around.
