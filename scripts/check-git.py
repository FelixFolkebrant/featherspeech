#!/usr/bin/env python3
import re
import subprocess
import sys
from pathlib import Path

IMPERATIVE_VERBS = set(
    "Add Adjust Allow Build Bump Change Clean Configure Correct Create Disable Document "
    "Drop Enable Ensure Expose Extract Fix Handle Implement Improve Introduce Make Move "
    "Pin Prevent Refactor Remove Rename Replace Restore Rework Run Set Simplify Support "
    "Switch Test Tighten Update Use Validate Wire Write".split()
)


def check_branch():
    branch = subprocess.run(
        ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*/[a-z0-9]+(?:-[a-z0-9]+)*", branch):
        sys.exit(f"Branch '{branch}' must be named username/short-description")


def check_message(path):
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    subject = lines[0].strip() if lines else ""
    match = re.fullmatch(r"([A-Z][a-z]+) (.+?)(?: \(#[1-9][0-9]*\))?", subject)
    if not match or match.group(1) not in IMPERATIVE_VERBS or "(#" in match.group(2):
        sys.exit(
            "Commit title must start with an imperative verb and use an optional issue suffix, e.g. Add profile editing (#142)"
        )


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "branch":
        check_branch()
    elif len(sys.argv) == 3 and sys.argv[1] == "message":
        check_message(sys.argv[2])
    else:
        sys.exit("Usage: check-git.py branch | message <message-file>")
