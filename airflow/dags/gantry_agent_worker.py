"""Gantry agent worker DAG.

Drains the queue of Gantry sessions for this environment: each DAG run
starts a pod that claims queued sessions one at a time (`--drain`) and
exits cleanly when the queue is empty; `@continuous` scheduling then starts
the next run immediately. The pod runs inside the VPC with the platform
credentials mounted, so the agent (gemini-cli plus the CLIs it shells out
to) can reach Snowflake, S3, and GitHub. The Gantry console never holds
these credentials — it only stores the model provider key, which the
worker receives when it claims a session.

Timeout layering (each layer must exceed the one below):
  execution_timeout (45 min)  >  runner --timeout (30 min per gemini call)
If a pod is ever killed mid-session anyway, the control plane's
stale-claim sweeper re-queues the session after its lease expires
(GANTRY_SESSION_LEASE_MINUTES, default 45).

Two variants:
  * KubernetesPodOperator (default): runs the runner image per drain cycle.
  * BashOperator (commented): runs the runner in-process on the Airflow
    worker on a 5-minute cron, useful on smaller deployments where a
    dedicated image is overkill.
"""

from datetime import datetime, timedelta

from airflow import DAG
from airflow.providers.cncf.kubernetes.operators.pod import KubernetesPodOperator
from kubernetes.client import models as k8s

GANTRY_API_BASE = "http://gantry-control-plane.data-agents.svc:8081"
GANTRY_ENVIRONMENT_ID = "{{ var.value.gantry_environment_id }}"

# Image built from runner/Dockerfile: python3 + gemini-cli + snowsql/aws/gh.
RUNNER_IMAGE = "ghcr.io/data-platform/gantry-runner:latest"

default_args = {
    "owner": "data-platform",
    "retries": 0,  # an empty or failed drain is simply followed by the next run
}

with DAG(
    dag_id="gantry_agent_worker",
    description="Drain queued Gantry agent sessions with gemini-cli",
    schedule="@continuous",   # next drain starts as soon as the previous ends
    start_date=datetime(2026, 7, 1),
    catchup=False,
    max_active_runs=1,
    default_args=default_args,
    tags=["gantry", "agents"],
) as dag:

    drain_queue = KubernetesPodOperator(
        task_id="drain_queue",
        name="gantry-runner",
        namespace="data-agents",
        image=RUNNER_IMAGE,
        cmds=["python3", "/app/gantry_runner.py"],
        # --drain: process queued sessions until the queue is empty, then
        # exit 0. An empty queue makes this a cheap ~seconds-long pod.
        arguments=["--drain", "--timeout", "1800"],
        startup_timeout_seconds=180,
        env_vars={
            "GANTRY_API_BASE": GANTRY_API_BASE,
            "GANTRY_ENVIRONMENT_ID": GANTRY_ENVIRONMENT_ID,
            # Warehouse/platform credentials come from k8s secrets, not Gantry.
        },
        secrets=[],  # e.g. Secret("env", "SNOWFLAKE_PASSWORD", "snowflake-svc-agents", "password")
        container_resources=k8s.V1ResourceRequirements(
            requests={"cpu": "500m", "memory": "1Gi"},
            limits={"cpu": "2", "memory": "4Gi"},
        ),
        # The pod's service account is bound to the read-only data-lake role.
        service_account_name="gantry-agent-runner",
        get_logs=True,
        is_delete_operator_pod=True,
        # Must exceed the runner's per-session --timeout (30 min) so a slow
        # session finishes and reports its own outcome instead of being
        # SIGKILLed mid-run.
        execution_timeout=timedelta(minutes=45),
    )


# ---------------------------------------------------------------------------
# Lightweight variant without a dedicated image — run the runner in-process
# on the Airflow worker every 5 minutes (it only needs python3 and the
# gemini CLI on PATH). Same timeout rule applies: execution_timeout must
# exceed the runner's per-session --timeout.
#
# from airflow.operators.bash import BashOperator
#
# with DAG(
#     dag_id="gantry_agent_worker",
#     schedule="*/5 * * * *",
#     start_date=datetime(2026, 7, 1),
#     catchup=False,
#     max_active_runs=1,
#     default_args={"owner": "data-platform", "retries": 0,
#                   "execution_timeout": timedelta(minutes=45)},
# ) as dag:
#     drain_queue = BashOperator(
#         task_id="drain_queue",
#         bash_command=(
#             "python3 {{ var.value.gantry_repo_path }}/runner/gantry_runner.py "
#             "--drain --timeout 1800"
#         ),
#         env={
#             "GANTRY_API_BASE": GANTRY_API_BASE,
#             "GANTRY_ENVIRONMENT_ID": GANTRY_ENVIRONMENT_ID,
#             "SNOWFLAKE_ACCOUNT": "{{ conn.snowflake_agents.host }}",
#             "SNOWFLAKE_USER": "{{ conn.snowflake_agents.login }}",
#             "SNOWFLAKE_PASSWORD": "{{ conn.snowflake_agents.password }}",
#             "AWS_PROFILE": "data-lake-ro",
#         },
#         append_env=True,
#     )
