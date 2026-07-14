#!/usr/bin/env -S npx tsx
// Removes exactly what `installClaudeHooks` (src/setup/installClaudeHooks.ts)
// added: the Scion-managed hook entries in ~/.claude/settings.json (matched
// by MANAGED_MARKER, so hooks the user configured independently are left
// alone) and ~/.scion/hooks/notify.sh. Also clears the "already installed"
// marker so the next `bun start` / `bun run web` reinstalls cleanly instead
// of silently staying uninstalled.
//
// Safe to run more than once, and safe to run on a machine where Scion's
// hooks were never installed — every step is a no-op rather than an error
// when there's nothing to remove.
//
// Run: `bun run uninstall-hooks`.
import { DATA_DIR } from "../src/config.ts";
import { uninstallClaudeHooks } from "../src/setup/installClaudeHooks.ts";

uninstallClaudeHooks();
console.log(
	`[scion] uninstalled Claude hooks: removed Scion's entries from ~/.claude/settings.json ` +
		`and ${DATA_DIR}/hooks/notify.sh (any of your own hooks were left untouched).`,
);
