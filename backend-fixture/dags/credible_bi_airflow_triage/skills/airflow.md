# Skill: airflow

How to investigate a failed Airflow DAG run.

- Start from the failing task, not the DAG: identify the task id, attempt
  number, and operator type from the run context.
- Read the last ~100 lines of the task log first; the terminal exception is
  usually there. Distinguish the *first* error from retry noise.
- Common failure classes and where to look:
  - **Upstream data problems** — the operator succeeded before on the same
    code; compare against the previous run's inputs.
  - **Infrastructure** — pod evictions, OOMKilled, image pull errors: these
    show in the k8s events, not the application log.
  - **Code/config regressions** — correlate the failure's first occurrence
    with recent merges to the DAG or dbt repos.
- Airflow task state can be misleading around trigger rules (`all_done`
  tasks run after failures by design); judge health by the terminal states
  of the tasks that matter.
- Always report the run's `log_url` when it is present in the context.
