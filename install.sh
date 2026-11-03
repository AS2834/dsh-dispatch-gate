#!/usr/bin/env bash
# Install dsh-dispatch-gate through the official local-bundle path.
#
#   PNPM_BIN=/opt/homebrew/bin/pnpm ./install.sh
#
# The old three DSH Schedule dispatch tasks must be disabled/removed separately;
# this script only installs the gate bundle.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${DSH_PROFILE:-web}"
DSH_BIN="${DSH_BIN:-dsh}"
PNPM_BIN="${PNPM_BIN:-}"

if ! command -v "$DSH_BIN" >/dev/null 2>&1; then
  echo "error: dsh was not found on PATH (set DSH_BIN=/absolute/path/to/dsh)" >&2
  exit 1
fi

if [[ -z "$PNPM_BIN" ]]; then
  if command -v pnpm >/dev/null 2>&1; then
    PNPM_BIN="$(command -v pnpm)"
  else
    for candidate in \
      "$HOME/.local/share/pnpm/pnpm" \
      "$HOME/Library/pnpm/pnpm" \
      "/opt/homebrew/bin/pnpm" \
      "/usr/local/bin/pnpm"; do
      if [[ -x "$candidate" ]]; then
        PNPM_BIN="$candidate"
        break
      fi
    done
  fi
fi

if [[ -z "$PNPM_BIN" || ! -x "$PNPM_BIN" ]]; then
  echo "error: pnpm was not found; set PNPM_BIN=/absolute/path/to/pnpm" >&2
  exit 1
fi

export PATH="$(dirname "$PNPM_BIN"):$PATH"
echo "installing $PKG_DIR into profile '$PROFILE' using $PNPM_BIN"
"$DSH_BIN" plugin --profile "$PROFILE" add "$PKG_DIR"

cat <<'EOF'

Installed Dispatch Gate (调度闸门).

Before enabling it, stop/delete the three old DSH Schedule dispatch tasks:
  - coding every 300s
  - acceptance every 300s
  - planner every 600s

Then confirm in the plugin inventory that the title is "Dispatch Gate" /
"调度闸门", not "自动化任务". The gate checks control.py first and only wakes
an idle session; it does not modify the control plane.
EOF
