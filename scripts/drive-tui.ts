// Drive the real TUI inside a PTY, feed keystrokes, capture output — so we can
// reproduce interactive errors headlessly. Uses an isolated HOME + a throwaway
// git repo so the real ~/.claude / ~/.scion are untouched.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";

const home = mkdtempSync(join(tmpdir(), "sl-drive-home-"));
const repo = join(mkdtempSync(join(tmpdir(), "sl-drive-repo-")), "demo");
execFileSync("git", ["init", "-q", "-b", "main", repo]);
execFileSync("git", ["-C", repo, "config", "user.email", "d@d.local"]);
execFileSync("git", ["-C", repo, "config", "user.name", "d"]);
writeFileSync(join(repo, "README.md"), "# demo\n");
execFileSync("git", ["-C", repo, "add", "-A"]);
execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);

const child = pty.spawn("bun", ["start"], {
	name: "xterm-256color",
	cols: 100,
	rows: 30,
	cwd: process.cwd(),
	env: { ...process.env, HOME: home } as Record<string, string>,
});

let out = "";
child.onData((d) => {
	out += d;
	process.stdout.write(d);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
	await wait(2500); // let it boot + render Projects
	child.write("a"); // add project
	await wait(800);
	child.write(repo); // type the repo path
	await wait(400);
	child.write("\r"); // submit
	await wait(2500); // let addProject run + re-render (or error)
	child.write("\r"); // open the project's dashboard
	await wait(1800);
	child.write("q"); // quit
	await wait(800);
	child.kill();

	const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
	console.log("\n\n===== ERROR SCAN =====");
	const hit = clean.split("\n").filter((l) => /error|Error|ERROR|not a git|throw|Exception/.test(l));
	console.log(hit.length ? hit.join("\n") : "(no error lines found)");
	execFileSync("rm", ["-rf", home, repo]);
	process.exit(0);
})();
