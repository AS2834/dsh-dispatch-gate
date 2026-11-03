#!/usr/bin/env bash
# Remove dsh-dispatch-gate through the official local-bundle path.
#
#   PNPM_BIN=/opt/homebrew/bin/pnpm ./uninstall.sh
#
# Re-enable the old DSH Schedule dispatch tasks yourself if you want to roll back.
set -euo pipefail

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
"$DSH_BIN" plugin --profile "$PROFILE" remove dsh-dispatch-gate

cat <<'EOF'

Removed Dispatch Gate. Re-create/enable the old DSH Schedule tasks if you want
the previous fixed-tick behaviour. The gate does not touch control-plane files.
EOF
