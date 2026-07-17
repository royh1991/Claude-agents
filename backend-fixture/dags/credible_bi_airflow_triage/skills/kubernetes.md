# Skill: kubernetes

How to reason about Kubernetes-flavored Airflow failures.

- Exit code 137 / OOMKilled means the pod exceeded its memory limit; the fix
  is a resource request change or a smaller workload, not a retry.
- Image pull backoff points at registry auth or a bad tag from a recent
  deploy — check the image reference against the latest release.
- Pod eviction and node pressure failures are transient by nature; if the
  retry succeeded, report the root cause as capacity, not code.
- Vault sidecar injection failures surface as missing environment variables
  at startup (e.g. absent `secrets.env`); the log shows the app failing on a
  missing credential rather than the injector erroring.
