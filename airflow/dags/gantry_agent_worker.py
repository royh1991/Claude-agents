"""Gantry agent worker DAG.

Every 5 minutes, drain the queue of Gantry sessions for this environment.
The pod runs inside the VPC with the platform credentials mounted, so the
agent (gemini-cli plus the CLIs it shells out to) can reach Snowflake, S3,
and GitHub. The Gantry console never holds these credentials — it only
stores the model provider key, which the worker receives when it claims a
session.

Two variants:
  * KubernetesPodOperator (default): runs the runner image per tick.
  * PythonOperator (commented): runs the runner in-process on the Airflow
    worker, useful on smaller deployments where a dedicated image is
    overkill.
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
    "retries": 0,  # a failed claim is retried on the next tick, not re-run
    "execution_timeout": timedelta(minutes=45),
}

with DAG(
    dag_id="gantry_agent_worker",
    description="Drain queued Gantry agent sessions with gemini-cli",
    schedule="*/5 * * * *",
    start_date=datetime(2026, 7, 1),
    catchup=False,
    max_active_runs=1,  # one drain loop at a time; scale via pod parallelism instead
    default_args=default_args,
    tags=["gantry", "agents"],
) as dag:

    drain_queue = KubernetesPodOperator(
        task_id="drain_queue",
        name="gantry-runner",
        namespace="data-agents",
        image=RUNNER_IMAGE,
        cmds=["python3", "/app/gantry_runner.py"],
        arguments=["--poll", "10", "--timeout", "1800"],
        # Stop polling once the queue stays empty; the next DAG tick resumes.
        # (--once would also work; --poll lets one pod drain a burst.)
        startup_timeout_seconds=180,
        env_vars={
            "GANTRY_API_BASE": GANTRY_API_BASE,
            "GANTRY_ENVIRONMENT_ID": GANTRY_ENVIRONMENT_ID,
            # Warehouse/platform credentials come from k8s secrets, not Gantry:
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
        # Kill the drain loop before the next tick would start.
        execution_timeout=timedelta(minutes=4, seconds=30),
    )


# ---------------------------------------------------------------------------
# Lightweight variant without a dedicated image — run the runner in-process
# on the Airflow worker (it only needs python3 and the gemini CLI on PATH):
#
# from airflow.operators.bash import BashOperator
#
# drain_queue = BashOperator(
#     task_id="drain_queue",
#     bash_command=(
#         "python3 {{ var.value.gantry_repo_path }}/runner/gantry_runner.py "
#         "--once --api-base $GANTRY_API_BASE"
#     ),
#     env={
#         "GANTRY_API_BASE": GANTRY_API_BASE,
#         "GANTRY_ENVIRONMENT_ID": GANTRY_ENVIRONMENT_ID,
#         "SNOWFLAKE_ACCOUNT": "{{ conn.snowflake_agents.host }}",
#         "SNOWFLAKE_USER": "{{ conn.snowflake_agents.login }}",
#         "SNOWFLAKE_PASSWORD": "{{ conn.snowflake_agents.password }}",
#         "AWS_PROFILE": "data-lake-ro",
#     },
#     append_env=True,
# )
