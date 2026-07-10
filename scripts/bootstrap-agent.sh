#!/bin/sh
# pi-fleet agent bootstrap (Linux/macOS). Idempotent.
#   curl -fsSL https://raw.githubusercontent.com/picassio/pi-fleet/main/scripts/bootstrap-agent.sh | sh -s -- --server <machine> [--port 9788] [--max-workers 4]
set -e

SERVER=""; PORT="9788"; MAXW=""; CCPATCH=""
while [ $# -gt 0 ]; do
	case "$1" in
		--server) SERVER="$2"; shift 2 ;;
		--port) PORT="$2"; shift 2 ;;
		--max-workers) MAXW="$2"; shift 2 ;;
		--with-cc-patch) CCPATCH="1"; shift ;;
		*) echo "unknown arg: $1" >&2; exit 1 ;;
	esac
done
[ -n "$SERVER" ] || { echo "usage: bootstrap-agent.sh --server <pinned-machine-name>" >&2; exit 1; }

for cmd in node pi tailscale; do
	command -v "$cmd" >/dev/null 2>&1 || { echo "missing prerequisite: $cmd" >&2; exit 1; }
done
tailscale ip -4 >/dev/null 2>&1 || { echo "tailscale is not up" >&2; exit 1; }

echo "installing pi-fleet via pi (official package flow)..."
pi install git:github.com/picassio/pi-fleet

if [ -n "$CCPATCH" ]; then
	echo "installing pi-cc-patch (Claude Code subscription auth for workers)..."
	pi install git:github.com/picassio/pi-cc-patch
	echo "note: workers on this machine also need Claude Code credentials (see pi-cc-patch README)"
fi

PKG="$HOME/.pi/agent/git/github.com/picassio/pi-fleet"
[ -f "$PKG/scripts/pi-fleet-agent.mjs" ] || { echo "install did not produce $PKG" >&2; exit 1; }

AGENT_ARGS="serve --server $SERVER --port $PORT"
[ -n "$MAXW" ] && AGENT_ARGS="$AGENT_ARGS --max-workers $MAXW"

if command -v systemctl >/dev/null 2>&1 && [ "$(uname)" = "Linux" ]; then
	mkdir -p "$HOME/.config/systemd/user"
	cat > "$HOME/.config/systemd/user/pi-fleet-agent.service" <<EOF
[Unit]
Description=pi-fleet agent (pinned server: $SERVER)
After=network-online.target

[Service]
ExecStart=$(command -v node) $PKG/scripts/pi-fleet-agent.mjs $AGENT_ARGS
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
	systemctl --user daemon-reload
	systemctl --user enable --now pi-fleet-agent 2>/dev/null || {
		echo "systemd user session unavailable; starting directly"
		pkill -f "pi-fleet-agent.mjs serve" 2>/dev/null || true
		nohup node "$PKG/scripts/pi-fleet-agent.mjs" $AGENT_ARGS > "$HOME/.pi-fleet-agent.log" 2>&1 &
	}
else
	pkill -f "pi-fleet-agent.mjs serve" 2>/dev/null || true
	nohup node "$PKG/scripts/pi-fleet-agent.mjs" $AGENT_ARGS > "$HOME/.pi-fleet-agent.log" 2>&1 &
fi

sleep 2
if pgrep -f "pi-fleet-agent.mjs serve" >/dev/null 2>&1; then
	echo "pi-fleet agent running (pinned to $SERVER, port $PORT)"
else
	echo "agent failed to start; see ~/.pi-fleet-agent.log or journalctl --user -u pi-fleet-agent" >&2
	exit 1
fi
