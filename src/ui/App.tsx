import React, { useState } from "react";
import type { StatusStore } from "../engine/status.ts";
import type { Store } from "../store/projects.ts";
import { CreateWorkspace } from "./screens/CreateWorkspace.tsx";
import { Dashboard } from "./screens/Dashboard.tsx";
import { Projects } from "./screens/Projects.tsx";
import type { ExitAction } from "./types.ts";

type View =
	| { name: "projects" }
	| { name: "dashboard"; projectId: string }
	| { name: "create"; projectId: string };

interface Props {
	store: Store;
	status: StatusStore;
	requestExit: (action: ExitAction) => void;
	initialProjectId?: string;
}

export function App({ store, status, requestExit, initialProjectId }: Props) {
	const [view, setView] = useState<View>(
		initialProjectId
			? { name: "dashboard", projectId: initialProjectId }
			: { name: "projects" },
	);

	if (view.name === "projects") {
		return (
			<Projects
				store={store}
				onOpen={(projectId) => setView({ name: "dashboard", projectId })}
				onQuit={() => requestExit({ type: "quit" })}
			/>
		);
	}

	if (view.name === "dashboard") {
		return (
			<Dashboard
				store={store}
				status={status}
				projectId={view.projectId}
				onBack={() => setView({ name: "projects" })}
				onCreate={() => setView({ name: "create", projectId: view.projectId })}
				requestExit={requestExit}
			/>
		);
	}

	return (
		<CreateWorkspace
			store={store}
			projectId={view.projectId}
			onDone={() => setView({ name: "dashboard", projectId: view.projectId })}
		/>
	);
}
