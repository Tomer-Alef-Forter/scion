#!/bin/bash
# Scion agent lifecycle hook — invoked by Claude Code via the hooks installed
# into ~/.claude/settings.json (see src/setup/installClaudeHooks.ts). Claude
# pipes hook JSON on stdin (or passes it as $1, depending on hook type); we
# only need two fields out of it, so a small grep/sed extraction is enough —
# deliberately no `jq`/JSON-parser dependency, since this must run on any
# machine with just bash + curl.

if [ -n "$1" ]; then
  INPUT="$1"
else
  INPUT=$(cat)
fi

# Pull one string field out of a flat JSON object via a single sed capture
# group — good enough for the two fixed field names we actually need,
# without pulling in a real JSON parser as a dependency.
json_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\\1/p" | head -n1
}

SESSION_ID=$(json_field "$INPUT" "session_id")
EVENT_TYPE=$(json_field "$INPUT" "hook_event_name")

# Fold UserPromptSubmit into "Start" here (it's the one alias worth handling
# at the source); the rest of the event-name normalization happens
# server-side in engine/status.ts, not in this script.
[ "$EVENT_TYPE" = "UserPromptSubmit" ] && EVENT_TYPE="Start"

# Couldn't parse an event name — drop silently. A wrong guess (e.g.
# defaulting to some status) is worse than just not reporting this one.
[ -z "$EVENT_TYPE" ] && exit 0

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

if [ -n "$SCION_HOST_AGENT_HOOK_URL" ] && [ -n "$SCION_TERMINAL_ID" ]; then
  PAYLOAD="{\"json\":{\"terminalId\":\"$(json_escape "$SCION_TERMINAL_ID")\",\"eventType\":\"$(json_escape "$EVENT_TYPE")\",\"agent\":{\"agentId\":\"$(json_escape "$SCION_AGENT_ID")\",\"sessionId\":\"$(json_escape "$SESSION_ID")\"}}}"
  curl -sX POST "$SCION_HOST_AGENT_HOOK_URL" \
    --connect-timeout 2 --max-time 5 \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    -o /dev/null 2>/dev/null
fi

exit 0
