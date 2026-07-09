import { homedir } from "node:os";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useReducer, useState } from "react";
import type { Store } from "../../store/projects.ts";

interface Props {
	store: Store;
	onOpen: (projectId: string) => void;
	onQuit: () => void;
}

function expandHome(p: string): string {
	return p.startsWith("~") ? homedir() + p.slice(1) : p;
}

export function Projects({ store, onOpen, onQuit }: Props) {
	const [, refresh] = useReducer((x: number) => x + 1, 0);
	const projects = store.listProjects();
	const [index, setIndex] = useState(0);
	const [adding, setAdding] = useState(false);
	const [path, setPath] = useState("");
	const [error, setError] = useState("");

	useInput((input, key) => {
		if (adding) return;
		if (input === "q") return onQuit();
		if (input === "a") {
			setError("");
			setAdding(true);
			return;
		}
		if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
		if (key.downArrow) setIndex((i) => Math.min(projects.length - 1, i + 1));
		if (key.return && projects[index]) onOpen(projects[index].id);
		if (input === "x" && projects[index]) {
			store.removeProject(projects[index].id);
			setIndex(0);
			refresh();
		}
	});

	const submitPath = async (value: string) => {
		setAdding(false);
		const v = value.trim();
		setPath("");
		if (!v) return;
		try {
			await store.addProject(expandHome(v));
			setError("");
			refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<Box flexDirection="column" padding={1}>
			<Text bold color="cyan">
				superset-local · projects
			</Text>
			<Box marginTop={1} flexDirection="column">
				{projects.length === 0 && !adding && (
					<Text dimColor>No projects yet. Press "a" to add a git repo.</Text>
				)}
				{projects.map((p, i) => (
					<Text key={p.id} color={i === index ? "green" : undefined}>
						{i === index ? "❯ " : "  "}
						{p.name} <Text dimColor>{p.repoPath}</Text>
					</Text>
				))}
			</Box>

			{adding && (
				<Box marginTop={1}>
					<Text>Repo path: </Text>
					<TextInput value={path} onChange={setPath} onSubmit={submitPath} />
				</Box>
			)}

			{error && (
				<Box marginTop={1}>
					<Text color="red">{error}</Text>
				</Box>
			)}

			<Box marginTop={1}>
				<Text dimColor>
					↑/↓ select · enter open · a add · x remove · q quit
				</Text>
			</Box>
		</Box>
	);
}
