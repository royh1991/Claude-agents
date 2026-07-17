# Skill: dbt

How to investigate dbt build failures and asset behavior.

- `run_results.json` is the source of truth for what failed: extract the
  failed nodes, their error messages, and their materializations.
- Read the compiled SQL of a failing model before hypothesizing; most
  failures are one of: source schema drift, contract/test violations, bad
  incremental predicates, or warehouse permission changes.
- Tests failing ≠ models failing: a `unique` or `not_null` test failure
  usually indicates an upstream data regression, not broken SQL.
- When querying the warehouse, use bounded SELECT-only queries via the
  provided dbt tooling; never mutate state.
- Name dbt nodes precisely (e.g. `model.credible_dbt.fct_orders`) so the
  reader can jump straight to the asset.
