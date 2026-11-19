#!/bin/sh
# Assembles the cloud runner's Docker build context in OUT from committed trees only (never the working copies):
#   bench/runner/context.sh OUT [AC_COMMIT] [P3_DIR] [P3_COMMIT] [OPENCODE_DIR]
# AC_COMMIT defaults to HEAD; PlayerThree to ../player-three (beside the main checkout) at its HEAD; OpenCode to
# ~/.local/opencode-1.19.5. Deploy with `railway up OUT` (the Dockerfile sits at OUT's root).
set -eu
out=$1
ac=$(git rev-parse --verify "${2:-HEAD}^{commit}")
p3dir=${3:-$(git rev-parse --path-format=absolute --git-common-dir)/../../player-three}
p3=$(git -C "$p3dir" rev-parse --verify "${4:-HEAD}^{commit}")
oc=${5:-$HOME/.local/opencode-1.19.5}
rm -rf "$out" && mkdir -p "$out/ac" "$out/p3" "$out/opencode"
git archive "$ac" -- . ':!docs/archive' ':!docs/art' ':!docs/media' ':!docs/checkpoints' ':!docs/brand' ':!docs/readme' | tar -x -C "$out/ac"
git -C "$p3dir" archive "$p3" | tar -x -C "$out/p3"
cp "$oc/package.json" "$oc/package-lock.json" "$out/opencode/"
cp "$out/ac/bench/runner/Dockerfile" "$out/Dockerfile"
printf '%s\n' "agent-command $ac" "player-three $p3" > "$out/BUILD"
echo "context $out: agent-command $ac, player-three $p3"
