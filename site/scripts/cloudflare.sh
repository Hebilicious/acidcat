#!/usr/bin/env bash
# Workers Builds runs this script from the repository root: `build`, then `deploy`.

set -euo pipefail

case "${1:-build}" in
  build) task="site:build" ;;
  deploy) task="site:deploy" ;;
  *)
    echo "Unknown action: $1. Use build or deploy." >&2
    exit 64
    ;;
esac

export PROTO_HOME="${PROTO_HOME:-$HOME/.proto}"
export PATH="$PROTO_HOME/shims:$PROTO_HOME/bin:$PATH"

if ! command -v proto >/dev/null 2>&1; then
  curl --fail --location --silent --show-error https://moonrepo.dev/install/proto.sh \
    | bash -s -- 0.63.1 --no-modify-profile --no-modify-path --yes
fi

for tool in node pnpm moon; do proto install "$tool"; done
pnpm install --frozen-lockfile
moon exec --ci false --ignore-ci-checks --force "$task"
