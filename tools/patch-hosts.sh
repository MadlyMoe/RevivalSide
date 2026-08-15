#!/bin/bash

set -e

REMOVE=false
ADDRESS="127.0.0.1"
NAMES="ctsglobal-login.sbside.com"

assert_admin() {
    if [ "$EUID" -ne 0 ]; then
        echo "Error: This script must be run as sudo." >&2
        exit 1
    fi
}

assert_admin

while [[ $# -gt 0 ]]; do
    case $1 in
        -r|--remove)
            REMOVE=true
            shift
            ;;
        -a|--address)
            ADDRESS="$2"
            shift 2
            ;;
        -n|--names)
            NAMES="$2"
            shift 2
            ;;
        *)
            echo "Unknown parameter: $1" >&2
            exit 1
            ;;
    esac
done

HOSTS_PATH="/etc/hosts"
MARKER_START="# BEGIN RevivalSide"
MARKER_END="# END RevivalSide"

TIMESTAMP=$(date +%Y%m%d%H%M%S)
BACKUP_PATH="${HOSTS_PATH}.revivalside.${TIMESTAMP}.bak"

if [ -f "$HOSTS_PATH" ]; then
    cp "$HOSTS_PATH" "$BACKUP_PATH"
else
    touch "$BACKUP_PATH"
fi

TMP_PATH="${HOSTS_PATH}.revivalside.tmp"

if [ -f "$HOSTS_PATH" ]; then
    awk -v start="$MARKER_START" -v end="$MARKER_END" '
        $0 ~ start {skip=1; next}
        $0 ~ end {skip=0; next}
        !skip {print}
    ' "$HOSTS_PATH" > "$TMP_PATH"
else
    touch "$TMP_PATH"
fi

if [ "$REMOVE" = false ]; then
    if [ -s "$TMP_PATH" ] && [ "$(tail -c 1 "$TMP_PATH" | wc -l)" -eq 0 ]; then
        echo "" >> "$TMP_PATH"
    fi

    echo "$MARKER_START" >> "$TMP_PATH"
    echo "$ADDRESS $NAMES" >> "$TMP_PATH"
    echo "$MARKER_END" >> "$TMP_PATH"
fi

mv "$TMP_PATH" "$HOSTS_PATH"

echo "[hosts] updated $HOSTS_PATH"
echo "[hosts] backup $BACKUP_PATH"

try_flush_dns() {
    if command -v resolvectl >/dev/null 2>&1; then
        resolvectl flush-caches && return 0
    fi
    if command -v systemd-resolve >/dev/null 2>&1; then
        systemd-resolve --flush-caches && return 0
    fi
    if [ -f /etc/init.d/nscd ]; then
        /etc/init.d/nscd restart && return 0
    fi
    return 1
}

if try_flush_dns; then
    echo "[hosts] dns cache flushed"
else
    echo "[hosts] warning: dns cache flush failed (no known DNS resolver found)" >&2
fi
