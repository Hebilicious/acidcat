#!/usr/bin/env bash
# Quint downloads its Rust evaluator on first use with an unauthenticated GitHub API request, which shared CI runners
# exhaust. This script downloads the same release with `gh`, which authenticates with GH_TOKEN.
set -euo pipefail

version=$(node --input-type=module -e '
  import { createRequire } from "node:module";
  const require = createRequire(new URL("model/package.json", `file://${process.cwd()}/`));
  console.log(require("@informalsystems/quint/dist/src/rust/binaryManager.js").QUINT_EVALUATOR_VERSION);
')
directory="${QUINT_HOME:-$HOME/.quint}/rust-evaluator-$version"

if [ -x "$directory/quint_evaluator" ]; then
  echo "The Quint evaluator $version is in $directory."
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset=quint_evaluator-x86_64-unknown-linux-gnu.tar.gz ;;
  Linux-aarch64) asset=quint_evaluator-aarch64-unknown-linux-gnu.tar.gz ;;
  Darwin-arm64) asset=quint_evaluator-aarch64-apple-darwin.tar.gz ;;
  Darwin-x86_64) asset=quint_evaluator-x86_64-apple-darwin.tar.gz ;;
  *) echo "There is no Quint evaluator for $(uname -s) $(uname -m)." >&2; exit 1 ;;
esac

mkdir -p "$directory"
gh release download "evaluator/$version" --repo quint-co/quint --pattern "$asset" --output - | tar -xz -C "$directory"
chmod +x "$directory/quint_evaluator"
echo "Installed the Quint evaluator $version in $directory."
