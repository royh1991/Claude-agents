#!/usr/bin/env python3
"""Gantry worker: claims queued sessions from the control plane and executes
them with gemini-cli.

This is the deliberately simple harness described in docs/DESIGN.md — the
Airflow-side "hands". It polls the control plane (like a self-hosted sandbox
worker), builds one prompt from the session's event history, hands it to
`gemini` in non-interactive mode (gemini-cli runs its own tool loop), and
posts the outcome back as session events.

Runs anywhere that has network access to the control plane and the
credentials the agent needs (Snowflake, S3, GitHub) — in production, an
Airflow task inside the VPC.

Usage:
  gantry_runner.py --once                 # claim and run at most one session
  gantry_runner.py --poll 30              # poll forever, every 30 seconds
  gantry_runner.py --once --dry-run       # exercise the loop without gemini

Environment:
  GANTRY_API_BASE        control plane URL (default http://localhost:8081)
  GANTRY_ENVIRONMENT_ID  only claim sessions for this environment
  GEMINI_API_KEY         fallback key if the control plane has none stored
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

DEFAULT_TIMEOUT_S = 30 * 60


def api(base, method, path, body=None):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def post_events(base, session_id, events, attempts=3):
    """Post events with retries — a transient control-plane blip must not
    discard a completed gemini run."""
    last_err = None
    for attempt in range(attempts):
        try:
            return api(base, "POST", f"/v1/internal/sessions/{session_id}/events", {"events": events})
        except Exception as err:  # noqa: BLE001 — sockets raise a zoo of types
            last_err = err
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed to post events for {session_id} after {attempts} attempts: {last_err}")


def post_events_best_effort(base, session_id, events):
    """For failure reporting: if the control plane is what's down, posting the
    failure will fail too — log instead of crashing the worker (double-fault)."""
    try:
        post_events(base, session_id, events)
        return True
    except Exception as err:  # noqa: BLE001
        print(f"[runner] could not report events for {session_id}: {err}", file=sys.stderr)
        return False


def build_prompt(agent, events):
    """Flatten system prompt + conversation into one prompt for gemini-cli."""
    parts = []
    if agent.get("system"):
        parts.append(f"<system>\n{agent['system']}\n</system>")
    mcp = agent.get("mcp_servers") or []
    if mcp:
        names = ", ".join(s["name"] for s in mcp)
        parts.append(
            "You have credentials for these systems available in your environment: "
            f"{names}. Use the corresponding CLIs (snowsql, aws, gh) where needed."
        )
    for event in events:
        text = "\n".join(
            block.get("text", "")
            for block in event.get("content", [])
            if block.get("type") == "text"
        )
        if not text:
            continue
        if event["type"] == "user.message":
            parts.append(f"<user>\n{text}\n</user>")
        elif event["type"] == "agent.message":
            parts.append(f"<previous_agent_reply>\n{text}\n</previous_agent_reply>")
    parts.append("Complete the user's request. Report what you did and what you found.")
    return "\n\n".join(parts)


def run_gemini(model_id, prompt, api_key, workdir, gemini_bin, timeout_s):
    """Run gemini-cli non-interactively; it drives its own tool loop."""
    cmd = [
        gemini_bin,
        "--model", model_id,
        "--prompt", prompt,
        "--yolo",                      # auto-approve tool calls inside the pod
        "--output-format", "json",
    ]
    env = dict(os.environ)
    if api_key:
        env["GEMINI_API_KEY"] = api_key
    proc = subprocess.run(
        cmd, cwd=workdir, env=env, timeout=timeout_s,
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"gemini exited {proc.returncode}: {proc.stderr.strip()[:2000] or proc.stdout.strip()[:2000]}"
        )
    raw = proc.stdout.strip()
    try:
        parsed = json.loads(raw)
        response = parsed.get("response") or raw
        stats = parsed.get("stats") or {}
    except json.JSONDecodeError:
        response, stats = raw, {}
    usage = {}
    # gemini-cli reports per-model token totals under stats.models
    for model_stats in (stats.get("models") or {}).values():
        tok = model_stats.get("tokens", {})
        usage["input_tokens"] = usage.get("input_tokens", 0) + tok.get("prompt", 0)
        usage["output_tokens"] = usage.get("output_tokens", 0) + tok.get("candidates", 0)
    return response, usage


def execute(base, bundle, args):
    session = bundle["session"]
    agent = bundle["agent"]
    sid = session["id"]
    model_id = agent["model"]["id"]
    key = (bundle.get("provider_key") or {}).get("value") or os.environ.get("GEMINI_API_KEY")

    print(f"[runner] claimed {sid} ({session.get('title')}) — {agent['name']} / {model_id}")
    prompt = build_prompt(agent, bundle.get("events") or [])

    workdir = tempfile.mkdtemp(prefix="gantry-")
    started = time.time()
    try:
        post_events(base, sid, [
            {"type": "span.model_request_start", "model": model_id},
        ])
        if args.dry_run:
            response = (
                "Dry run: the worker claimed this session and would now hand the "
                "prompt to gemini-cli. No model was called."
            )
            usage = {"input_tokens": 0, "output_tokens": 0}
        else:
            response, usage = run_gemini(
                model_id, prompt, key, workdir, args.gemini_bin, args.timeout,
            )
        events = [{"type": "agent.message", "content": [{"type": "text", "text": response}]}]
        if usage:
            events.append({
                "type": "span.model_request_end",
                "model": model_id,
                "model_usage": {
                    "input_tokens": usage.get("input_tokens", 0),
                    "output_tokens": usage.get("output_tokens", 0),
                },
            })
        events.append({"type": "session.status_idle", "stop_reason": "end_turn"})
        try:
            post_events(base, sid, events)
        except Exception as err:  # noqa: BLE001
            # The model produced a result but the control plane is
            # unreachable: keep the response in the pod logs so the work
            # isn't lost, and leave the session to the stale-claim sweeper.
            print(f"[runner] {sid} completed but could not be reported: {err}", file=sys.stderr)
            print(f"[runner] {sid} unreported agent response follows:\n{response}", file=sys.stderr)
            return
        print(f"[runner] {sid} idle after {time.time() - started:.0f}s")
    except subprocess.TimeoutExpired:
        post_events_best_effort(base, sid, [
            {"type": "session.error", "error": {
                "type": "timeout_error",
                "message": f"gemini-cli exceeded {args.timeout}s",
                "retry_status": "exhausted",
            }},
            {"type": "session.status_terminated", "stop_reason": "error"},
        ])
        print(f"[runner] {sid} terminated: timeout", file=sys.stderr)
    except Exception as err:  # report the failure into the trace, then continue polling
        post_events_best_effort(base, sid, [
            {"type": "session.error", "error": {
                "type": "api_error", "message": str(err)[:2000], "retry_status": "exhausted",
            }},
            {"type": "session.status_terminated", "stop_reason": "error"},
        ])
        print(f"[runner] {sid} terminated: {err}", file=sys.stderr)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def claim(base, environment_id, worker_id):
    try:
        return api(base, "POST", "/v1/internal/claim", {
            "environment_id": environment_id, "worker_id": worker_id,
        })
    except Exception as err:  # noqa: BLE001 — URLError, socket timeouts,
        # ConnectionResetError, IncompleteRead, JSONDecodeError from an LB
        # error page: all mean the same thing here — try again next poll.
        print(f"[runner] claim failed: {err}", file=sys.stderr)
        return {"session": None}


def main():
    parser = argparse.ArgumentParser(description="Gantry gemini-cli worker")
    parser.add_argument("--api-base", default=os.environ.get("GANTRY_API_BASE", "http://localhost:8081"))
    parser.add_argument("--environment-id", default=os.environ.get("GANTRY_ENVIRONMENT_ID"))
    parser.add_argument("--worker-id", default=f"{socket.gethostname()}-{os.getpid()}")
    parser.add_argument("--gemini-bin", default="gemini")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_S, help="per-session gemini timeout (s)")
    parser.add_argument("--once", action="store_true", help="claim and run at most one session, then exit")
    parser.add_argument("--drain", action="store_true", help="run sessions until the queue is empty, then exit")
    parser.add_argument("--poll", type=int, metavar="SECONDS", help="poll forever at this interval")
    parser.add_argument("--dry-run", action="store_true", help="skip gemini; post a canned reply")
    args = parser.parse_args()

    if not args.once and not args.drain and not args.poll:
        parser.error("pass --once, --drain, or --poll SECONDS")

    ran = 0
    while True:
        bundle = claim(args.api_base, args.environment_id, args.worker_id)
        if bundle.get("session"):
            try:
                execute(args.api_base, bundle, args)
            except Exception as err:  # noqa: BLE001 — one bad session must not kill the worker
                sid = (bundle.get("session") or {}).get("id")
                print(f"[runner] unexpected failure on {sid}: {err}", file=sys.stderr)
            ran += 1
            if args.once:
                return
        elif args.once or args.drain:
            print(f"[runner] queue empty after {ran} session(s)")
            return
        else:
            time.sleep(args.poll)


if __name__ == "__main__":
    main()
