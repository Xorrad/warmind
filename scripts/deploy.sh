#!/usr/bin/env bash
# Deploy the latest `main` on the server: fetch, install the production
# dependencies, restart, check health. If the new version does not come
# up, go back to the previous commit.
#
# Run on the server (GitHub Actions calls it over SSH, with a key that can
# only run this script). Same paths as warmind-ctl.sh.
#
# Everything is inside main(): bash reads a script as it runs, and
# `git reset` below replaces this very file.
set -euo pipefail

main() {
    local app_dir=${WARMIND_DIR:-$HOME/warmind}
    local data_dir=${WARMIND_DATA:-$app_dir/data}
    export PATH="${NODE_BIN:-$HOME/opt/node/bin}:$PATH"
    local ctl="$app_dir/scripts/warmind-ctl.sh"

    mkdir -p "$data_dir"
    # One deploy at a time
    exec 9>"$data_dir/deploy.lock"
    if ! flock -n 9; then
        echo "Another deploy is running." >&2
        exit 1
    fi

    cd "$app_dir"
    local previous
    previous=$(git rev-parse HEAD)
    git fetch --quiet origin main
    git reset --hard --quiet origin/main
    echo "Deploying $(git log -1 --format='%h %s') (previous: ${previous:0:7})"

    if npm ci --omit=dev --no-audit --no-fund --loglevel=error && "$ctl" restart && "$ctl" health; then
        echo "Deployed $(git rev-parse --short HEAD)."
        return 0
    fi

    echo "The new version failed: rolling back to ${previous:0:7}." >&2
    git reset --hard --quiet "$previous"
    npm ci --omit=dev --no-audit --no-fund --loglevel=error
    "$ctl" restart
    exit 1
}

main "$@"
