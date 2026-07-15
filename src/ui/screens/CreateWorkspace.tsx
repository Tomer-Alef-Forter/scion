import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import type { Store } from "../../store/projects.ts";

interface Props {
	store: Store;
	projectId: string;
	onDone: () => void;
}

export function CreateWorkspace({ store, projectId, onDone }: Props) {
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useInput((_input, key) => {
		if (key.escape && !busy) onDone();
	});

	const submit = async (value: string) => {
		const v = value.trim();
		if (!v || busy) return;
		setBusy(true);
		setError("");
		try {
			await store.createWorkspace({ projectId, prompt: v });
			onDone();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};

	return (
		<Box flexDirection="column" padding={1}>
			<Text bold color="cyan">
				New workspace
			</Text>
			<Text dimColor>
				Describe the task for Claude. A worktree + branch are created and the agent launches with
				this prompt.
			</Text>
			<Box marginTop={1}>
				<Text>Task: </Text>
				{busy ? (
					<Text color="yellow">creating worktree + launching claude…</Text>
				) : (
					<TextInput value={prompt} onChange={setPrompt} onSubmit={submit} />
				)}
			</Box>
			{error && (
				<Box marginTop={1}>
					<Text color="red">{error}</Text>
				</Box>
			)}
			<Box marginTop={1}>
				<Text dimColor>enter create · esc cancel</Text>
			</Box>
		</Box>
	);
}
