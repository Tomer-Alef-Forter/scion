import * as nodePty from "node-pty";
import net from "node:net";
import tty from "node:tty";
import { fork } from "node:child_process";

const term = nodePty.spawn("bash", ["-c", "for i in 1 2 3 4 5; do echo line$i; sleep 1; done; sleep 60"], { name: "xterm", cols: 80, rows: 24 });
const masterFd = term._fd;
console.error("[parent] masterFd", masterFd);

// dup the fd so lifecycle is independent
import { constants } from "node:os";
import fs from "node:fs";
// node has no fs.dup; use a fresh tty.ReadStream over the same fd via dup? Use child_process? 
// Try: wrap raw fd in a new tty.ReadStream to send its handle
let sendStream;
try {
  sendStream = new tty.ReadStream(masterFd);
  console.error("[parent] made tty.ReadStream, handle:", sendStream._handle && sendStream._handle.constructor.name);
} catch(e){ console.error("[parent] tty.ReadStream err:", e.message); }

const child = fork("/Users/tomeralef/dev/scion/exp3child.mjs", [], { stdio: "inherit" });
child.on("spawn", () => {
  try {
    child.send({ kind: "pty" }, sendStream, (err) => console.error("[parent] send cb err:", err && err.message));
  } catch (e) { console.error("[parent] send threw:", e.message); }
});
setTimeout(() => { try{term.kill(); child.kill();}catch{}; process.exit(0); }, 4000);
