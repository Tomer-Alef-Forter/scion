import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./lib/theme";
import "./globals.css";

// Synchronous, before first render — avoids a flash of the wrong theme.
initTheme();

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
