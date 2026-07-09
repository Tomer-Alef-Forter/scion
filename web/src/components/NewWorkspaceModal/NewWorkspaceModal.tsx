import { useEffect, useState } from "react";

interface NewWorkspaceModalProps {
	projectName: string;
	busy: boolean;
	error: string | null;
	onCreate: (prompt: string, name?: string) => Promise<void>;
	onClose: () => void;
}

export function NewWorkspaceModal({
	projectName,
	busy,
	error,
	onCreate,
	onClose,
}: NewWorkspaceModalProps) {
	const [prompt, setPrompt] = useState("");
	const [name, setName] = useState("");

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape" && !busy) onClose();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [busy, onClose]);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (busy) return;
		await onCreate(prompt.trim(), name.trim() || undefined);
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
			onClick={(e) => {
				if (e.target === e.currentTarget && !busy) onClose();
			}}
		>
			<div className="w-full max-w-md rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg">
				<h2 className="mb-1 text-sm font-semibold">New workspace</h2>
				<p className="mb-3 text-xs text-muted-foreground">
					Describe the task for Claude in <span className="font-medium">{projectName}</span>
					{" — "}optional. A worktree + branch are created either way; leave it blank to open
					an agent with no seed task.
				</p>
				<form onSubmit={handleSubmit}>
					<textarea
						autoFocus
						rows={4}
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						placeholder="Fix the flaky login redirect test… (optional)"
						className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					/>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Name (optional — defaults to the task description)"
						className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					/>
					{error && <p className="mt-2 text-xs text-destructive">{error}</p>}
					<div className="mt-3 flex justify-end gap-2">
						<button
							type="button"
							onClick={onClose}
							disabled={busy}
							className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={busy}
							className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
						>
							{busy ? "Creating…" : "Create"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
