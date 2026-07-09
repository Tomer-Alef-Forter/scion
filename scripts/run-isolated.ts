#!/usr/bin/env -S npx tsx
// Runs a target script under a FRESH, throwaway $HOME. Several engine
// modules (config.ts's DATA_DIR/WORKTREES_ROOT) resolve `homedir()` at
// module-load time, so an isolated HOME can only be set via a real child
// process's env — mutating process.env in-place after our own imports have
// already run is too late.
//
// This exists because a smoke test's throwaway/isolated DB was once checked
// against the REAL, shared WORKTREES_ROOT (unaffected by that DB isolation)
// — the orphan-worktree cleanup test misidentified real, in-use workspaces
// as orphaned and deleted their working directories. Isolating HOME for the
// whole test process is the only fix that protects every test, present and
// future, not just the one that happened to bite.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = process.argv[2];
if (!target) {
	console.error("usage: tsx scripts/run-isolated.ts <script-to-run>");
	process.exit(1);
}

const ROOT = join(import.meta.dirname, "..");
const TSX_BIN = join(ROOT, "node_modules", ".bin", "tsx");
const isolatedHome = mkdtempSync(join(tmpdir(), "sl-isolated-home-"));

try {
	execFileSync(TSX_BIN, [target], {
		cwd: ROOT,
		stdio: "inherit",
		env: { ...process.env, HOME: isolatedHome, SL_ISOLATED_HOME: "1" },
	});
} finally {
	rmSync(isolatedHome, { recursive: true, force: true });
}
