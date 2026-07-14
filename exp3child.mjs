import tty from "node:tty";
process.on("message", (m, h) => {
  console.error("[child] msg:", JSON.stringify(m), "handleType:", h && h.constructor && h.constructor.name, "fd:", h && h._handle && h.fd);
  if (h) {
    h.on && h.on("data", (d) => console.error("[child] DATA:", JSON.stringify(d.toString().slice(0,40))));
    try { h.resume && h.resume(); } catch(e){ console.error("[child] resume err", e.message); }
  }
});
process.on("SIGTERM", () => process.exit(0));
setInterval(()=>{}, 1000);
