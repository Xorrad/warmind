#!/usr/bin/env bash
# Control the WarMind server on a host without systemd (shared hosting).
#
#   warmind-ctl.sh start|stop|restart|status|health|ensure
#
# `ensure` starts the app if it is not running: cron calls it every minute,
# which also brings the app back after a reboot or a crash.
#
# Settings come from the app's .env (PORT, DB_PATH...). Paths:
#   WARMIND_DIR   the app (default ~/warmind)
#   WARMIND_DATA  pid file and logs (default ~/warmind-data)
#   NODE_BIN      folder of the node binary (default ~/opt/node/bin)
set -uo pipefail

APP_DIR=${WARMIND_DIR:-$HOME/warmind}
DATA_DIR=${WARMIND_DATA:-$HOME/warmind-data}
NODE_BIN=${NODE_BIN:-$HOME/opt/node/bin}
PID_FILE=$DATA_DIR/warmind.pid
LOG_DIR=$DATA_DIR/logs
LOG_FILE=$LOG_DIR/app.log
LOG_MAX_BYTES=$((5 * 1024 * 1024))

export PATH="$NODE_BIN:$PATH"
mkdir -p "$LOG_DIR"

port() {
    local p
    p=$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2)
    echo "${p:-3000}"
}

log() { echo "[$(date '+%F %T')] $*" >>"$LOG_FILE"; }

running() {
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null) || return 1
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && grep -q "server/index.js" "/proc/$pid/cmdline" 2>/dev/null
}

health() { curl -fsS --max-time 5 "http://127.0.0.1:$(port)/api/health"; }

rotate_logs() {
    if [ -f "$LOG_FILE" ] && [ "$(stat -c %s "$LOG_FILE")" -gt "$LOG_MAX_BYTES" ]; then
        mv -f "$LOG_FILE" "$LOG_FILE.1"
    fi
}

start() {
    if running; then
        echo "already running (pid $(cat "$PID_FILE"))"
        return 0
    fi
    rotate_logs
    cd "$APP_DIR" || return 1
    local commit
    commit=$(git rev-parse --short HEAD 2>/dev/null || true)
    log "starting $commit"
    BUILD_COMMIT=$commit nohup node --env-file-if-exists=.env server/index.js >>"$LOG_FILE" 2>&1 </dev/null &
    echo $! >"$PID_FILE"
    # Wait until it answers (or gives up)
    for _ in $(seq 1 30); do
        if health >/dev/null 2>&1; then
            echo "started (pid $(cat "$PID_FILE"), port $(port))"
            return 0
        fi
        running || break
        sleep 1
    done
    echo "failed to start, see $LOG_FILE" >&2
    tail -20 "$LOG_FILE" >&2
    return 1
}

stop() {
    if ! running; then
        rm -f "$PID_FILE"
        echo "not running"
        return 0
    fi
    local pid
    pid=$(cat "$PID_FILE")
    kill -TERM "$pid"
    # The server finishes its requests and closes the database (10 s max)
    for _ in $(seq 1 15); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid"
    rm -f "$PID_FILE"
    log "stopped"
    echo "stopped"
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    restart) stop && start ;;
    status)
        if running; then echo "running (pid $(cat "$PID_FILE"), port $(port))"; else echo "not running"; exit 1; fi
        ;;
    health) health && echo ;;
    ensure)
        if ! running; then
            log "not running: starting (ensure)"
            start >/dev/null
        fi
        ;;
    *)
        echo "usage: $0 start|stop|restart|status|health|ensure" >&2
        exit 2
        ;;
esac
