#!/bin/bash
# superset-local agent lifecycle hook.
# Ported from superset apps/desktop/.../templates/notify-hook.template.sh,
# trimmed to the v2 host-service POST path (Electron v1 fallback removed).
# Claude pipes hook JSON on stdin; it also passes SUPERSET_* via the env.

if [ -n "$1" ]; then
  INPUT="$1"
else
  INPUT=$(cat)
fi

SESSION_ID=$(echo "$INPUT" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
EVENT_TYPE=$(echo "$INPUT" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')

# UserPromptSubmit normalizes here; other aliases are mapped server-side.
[ "$EVENT_TYPE" = "UserPromptSubmit" ] && EVENT_TYPE="Start"

# Never default to a completion on parse failure — silent drop is safer.
[ -z "$EVENT_TYPE" ] && exit 0

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

if [ -n "$SUPERSET_HOST_AGENT_HOOK_URL" ] && [ -n "$SUPERSET_TERMINAL_ID" ]; then
  PAYLOAD="{\"json\":{\"terminalId\":\"$(json_escape "$SUPERSET_TERMINAL_ID")\",\"eventType\":\"$(json_escape "$EVENT_TYPE")\",\"agent\":{\"agentId\":\"$(json_escape "$SUPERSET_AGENT_ID")\",\"sessionId\":\"$(json_escape "$SESSION_ID")\"}}}"
  curl -sX POST "$SUPERSET_HOST_AGENT_HOOK_URL" \
    --connect-timeout 2 --max-time 5 \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    -o /dev/null 2>/dev/null
fi

exit 0
