// Open a worktree in an external editor. Mapping adapted from superset
// apps/desktop/.../external/helpers.ts (getAppCommand): macOS uses
// `open -a "<App>"`, Linux uses the CLI binary directly.
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAC_APP_NAMES: Record<string, string> = {
	vscode: "Visual Studio Code",
	cursor: "Cursor",
	zed: "Zed",
};
const LINUX_CLI: Record<string, string> = {
	vscode: "code",
	cursor: "cursor",
	zed: "zed",
};

export async function openInEditor(
	targetPath: string,
	editor: keyof typeof MAC_APP_NAMES = "vscode",
): Promise<void> {
	const macApp = MAC_APP_NAMES[editor] ?? "Visual Studio Code";
	const cli = LINUX_CLI[editor] ?? "code";
	if (platform() === "darwin") {
		try {
			await execFileAsync("open", ["-a", macApp, targetPath]);
			return;
		} catch {
			// fall through to the CLI / generic open
		}
	}
	try {
		await execFileAsync(cli, [targetPath]);
	} catch {
		// last resort: platform opener
		const opener = platform() === "darwin" ? "open" : "xdg-open";
		await execFileAsync(opener, [targetPath]);
	}
}
