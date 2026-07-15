import { useEffect, useState } from "react";
import type { AgentType } from "../../lib/api";

const AGENT_TYPES: AgentType[] = [
	"claude",
	"gemini",
	"codex",
	"cursor-agent",
	"droid",
	"opencode",
	"copilot",
];

export interface BatchOptions {
	agents?: AgentType[];
	count?: number;
}

interface NewWorkspaceModalProps {
	projectName: string;
	busy: boolean;
	error: string | null;
	// `batch` is set only when the user asked for more than one workspace —
	// either multiple presets or multiple copies. A single workspace leaves it
	// undefined so the plain create path is used.
	onCreate: (prompt: string, name?: string, batch?: BatchOptions) => Promise<void>;
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
	// Batch controls: N copies of each selected preset. No presets selected =>
	// the default agent. copies=1 + no presets => an ordinary single workspace.
	const [copies, setCopies] = useState(1);
	const [selectedAgents, setSelectedAgents] = useState<AgentType[]>([]);

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape" && !busy) onClose();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [busy, onClose]);

	function toggleAgent(agent: AgentType) {
		setSelectedAgents((prev) =>
			prev.includes(agent) ? prev.filter((a) => a !== agent) : [...prev, agent],
		);
	}

	const presetCount = selectedAgents.length > 0 ? selectedAgents.length : 1;
	const totalWorkspaces = Math.max(1, copies) * presetCount;
	const isBatch = totalWorkspaces > 1;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (busy) return;
		const batch: BatchOptions | undefined = isBatch
			? {
					agents: selectedAgents.length > 0 ? selectedAgents : undefined,
					count: copies,
				}
			: undefined;
		await onCreate(prompt.trim(), name.trim() || undefined, batch);
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
					Describe the task for the agent in <span className="font-medium">{projectName}</span>
					{" — "}optional. A worktree + branch are created either way; leave it blank to open an
					agent with no seed task.
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

					{/* ---- batch fan-out ---- */}
					<div className="mt-3 rounded-md border border-border p-3">
						<p className="mb-2 text-xs font-medium">Batch (optional)</p>
						<div className="flex items-center gap-2">
							<label htmlFor="copies" className="text-xs text-muted-foreground">
								Copies of each agent
							</label>
							<input
								id="copies"
								type="number"
								min={1}
								max={20}
								value={copies}
								onChange={(e) => {
									const n = Number.parseInt(e.target.value, 10);
									setCopies(Number.isNaN(n) ? 1 : Math.min(20, Math.max(1, n)));
								}}
								className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring"
							/>
						</div>
						<p className="mt-2 mb-1 text-xs text-muted-foreground">
							Agents (default: your default agent)
						</p>
						<div className="flex flex-wrap gap-1.5">
							{AGENT_TYPES.map((agent) => {
								const on = selectedAgents.includes(agent);
								return (
									<button
										type="button"
										key={agent}
										onClick={() => toggleAgent(agent)}
										className={`rounded-full border px-2.5 py-1 text-xs ${
											on
												? "border-primary bg-primary text-primary-foreground"
												: "border-border hover:bg-accent"
										}`}
									>
										{agent}
									</button>
								);
							})}
						</div>
						{isBatch && (
							<p className="mt-2 text-xs text-muted-foreground">
								Will create <span className="font-medium">{totalWorkspaces}</span> workspaces.
							</p>
						)}
					</div>

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
							{busy ? "Creating…" : isBatch ? `Create ${totalWorkspaces}` : "Create"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
