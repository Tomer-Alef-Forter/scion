import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev proxy forwards /api and /ws to the backend server (src/server/index.ts,
// port 5177) so the browser sees everything same-origin.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		proxy: {
			"/api": "http://127.0.0.1:5177",
			"/ws": {
				target: "ws://127.0.0.1:5177",
				ws: true,
			},
		},
	},
	build: {
		outDir: "dist",
	},
});
