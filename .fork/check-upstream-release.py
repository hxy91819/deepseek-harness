#!/usr/bin/env python3
"""Gate the weekly fork release automation on a newer upstream stable/RC tag.

The bb automation runs this on a weekly cron. While the newest upstream stable
or RC tag is not newer than the base recorded on fork-tooling, the run exits 0
with no output and bb records a silent tick. A newer tag spawns the release
agent thread with the prompt stored on fork-tooling and reports the thread.

Operator options: --dry-run prints the decision without spawning, --no-fetch
skips the remote fetch, --tag replays a specific release tag, and
--prompt-file overrides the stored release prompt.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
from typing import Any

REPO = "/data/code/deepseek-harness"
PROJECT_ID = "proj_5fr8ecy24i"
ENVIRONMENT_ID = "env_3x7gq8t368"
PROVIDER_ID = "acp-dsh"
MODEL_ID = '["ollama-cloud","deepseek-v4.1-flash"]'
REASONING_LEVEL = "max"
PERMISSION_MODE = "full"
PROMPT_REF = "fork-tooling:.fork/release-agent-prompt.md"
TAG_PATTERN = re.compile(r"^dsh-v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$")


def run(argv: list[str]) -> str:
    completed = subprocess.run(argv, text=True, capture_output=True, check=True)
    return completed.stdout


def git(*args: str) -> str:
    return run(["git", "-C", REPO, *args])


def release_key(tag: str) -> tuple[int, int, int, int, int]:
    match = TAG_PATTERN.match(tag)
    if match is None:
        raise SystemExit(f"unexpected release tag: {tag}")
    major, minor, patch, rc = match.groups()
    return (int(major), int(minor), int(patch), 0 if rc else 1, int(rc or 0))


def newest_release() -> str:
    tags = [tag for tag in git("tag", "-l", "dsh-v*").splitlines() if TAG_PATTERN.match(tag)]
    if not tags:
        raise SystemExit("no stable or RC tags after fetch")
    return max(tags, key=release_key)


def base_release() -> str:
    for line in git("show", "fork-tooling:.fork/branches").splitlines():
        fields = line.split()
        if fields[:1] == ["base"] and len(fields) > 1:
            return fields[1]
    raise SystemExit("no base line in fork-tooling:.fork/branches")


def bb_cli() -> str:
    return os.environ.get("BB_CLI") or shutil.which("bb") or "bb"


def read_prompt(override: str | None) -> str:
    if override:
        with open(override, encoding="utf-8") as handle:
            return handle.read()
    return git("show", PROMPT_REF)


def running_thread(title: str) -> str | None:
    threads = json.loads(run([bb_cli(), "thread", "list", "--project", PROJECT_ID, "--json"]))
    for thread in threads:
        if thread.get("title") == title and thread.get("status") == "running":
            return thread.get("id")
    return None


def spawn_release_agent(tag: str, base: str, prompt: str) -> str:
    title = f"DSH 上游 {tag} 集成发布"
    existing = running_thread(title)
    if existing:
        return existing
    checked_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    message = f"本轮上游新 tag：{tag}（检查时间 {checked_at}，base={base}）。\n\n{prompt}"
    output = run(
        [
            bb_cli(), "thread", "spawn",
            "--project", PROJECT_ID,
            "--environment", ENVIRONMENT_ID,
            "--provider", PROVIDER_ID,
            "--model", MODEL_ID,
            "--reasoning-level", REASONING_LEVEL,
            "--permission-mode", PERMISSION_MODE,
            "--title", title,
            "--prompt", message,
            "--json",
        ]
    )
    result: Any = json.loads(output)
    thread = result.get("thread", result)
    return thread["id"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="print the decision without spawning")
    parser.add_argument("--no-fetch", action="store_true", help="skip the origin fetch")
    parser.add_argument("--tag", help="treat this release tag as the newest one")
    parser.add_argument("--prompt-file", help="read the release prompt from this file")
    args = parser.parse_args()

    if not args.no_fetch:
        run(["git", "-C", REPO, "fetch", "--quiet", "origin", "--tags", "--prune"])

    latest = args.tag or newest_release()
    base = base_release()
    if release_key(latest) <= release_key(base):
        return 0

    prompt = read_prompt(args.prompt_file)
    if args.dry_run:
        print(json.dumps({"base": base, "tag": latest, "action": "spawn"}, ensure_ascii=False))
        return 0

    thread_id = spawn_release_agent(latest, base, prompt)
    print(json.dumps({"base": base, "tag": latest, "threadId": thread_id}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        sys.stderr.write(f"{' '.join(error.cmd)} failed with exit {error.returncode}\n{error.stderr or ''}\n")
        sys.exit(1)
