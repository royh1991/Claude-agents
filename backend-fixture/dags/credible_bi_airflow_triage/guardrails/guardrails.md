# Shared guardrails

These rules apply to every agent run and are injected into every prompt.

- **Read-only.** Never mutate warehouse state, repository contents, or
  infrastructure. SELECT/CTE queries only; no DDL, DML, or destructive shell
  commands.
- **Bounded.** Keep queries and file reads small and targeted. No full-table
  scans without limits, no background or indefinite workloads.
- **No secrets.** Never print credentials, tokens, or connection strings in
  any output, even partially. Do not attempt to read secret files.
- **Stay in the workspace.** Only access files under the workspace root and
  the repositories cloned for this session.
- **Structured output only.** Return exactly one JSON object matching the
  provided output schema; no markdown fences, no prose outside the JSON.
