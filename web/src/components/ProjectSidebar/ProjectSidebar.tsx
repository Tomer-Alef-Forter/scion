import { Moon, Pencil, Settings, Sun } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { useTheme } from "../../lib/useTheme";
import type { Project } from "../../lib/api";

interface ProjectSidebarProps {
	projects: Project[];
	selectedProjectId: string | null;
	onSelect: (projectId: string) => void;
	onAdd: (repoPath: string) => Promise<void>;
	onRemove: (projectId: string) => void;
	onUpdateSetupCommand: (projectId: string, setupCommand: string) => Promise<void>;
	onOpenSettings: () => void;
	busy: boolean;
}

export function ProjectSidebar({
	projects,
	selectedProjectId,
	onSelect,
	onAdd,
	onRemove,
	onUpdateSetupCommand,
	onOpenSettings,
	busy,
}: ProjectSidebarProps) {
	const [repoPathInput, setRepoPathInput] = useState("");
	const [adding, setAdding] = useState(false);
	const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
	const [setupCommandInput, setSetupCommandInput] = useState("");
	const [theme, toggleTheme] = useTheme();

	async function handleSaveSetupCommand(e: React.FormEvent, projectId: string) {
		e.preventDefault();
		await onUpdateSetupCommand(projectId, setupCommandInput.trim());
		setEditingProjectId(null);
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!repoPathInput.trim()) return;
		await onAdd(repoPathInput.trim());
		setRepoPathInput("");
		setAdding(false);
	}

	return (
		<div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
			<div className="flex items-center justify-between border-b border-sidebar-border px-3 py-3">
				<div className="flex items-center gap-2">
					<img src="/logo.svg" alt="" className="size-5" />
					<h1 className="text-sm font-semibold">Scion</h1>
				</div>
				<div className="flex items-center gap-0.5">
					<button
						type="button"
						onClick={onOpenSettings}
						title="Settings"
						className="rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
					>
						<Settings className="size-4" />
					</button>
					<button
						type="button"
						onClick={toggleTheme}
						title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
						className="rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
					>
						{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
					</button>
				</div>
			</div>
			<div className="flex-1 overflow-y-auto p-2">
				<ul className="space-y-0.5">
					{projects.map((p) =>
						editingProjectId === p.id ? (
							<li key={p.id}>
								<form
									onSubmit={(e) => handleSaveSetupCommand(e, p.id)}
									className="flex flex-col gap-1.5 rounded-md border border-sidebar-border p-2"
								>
									<label className="text-xs font-medium text-muted-foreground">
										Setup command for {p.name}
									</label>
									<input
										autoFocus
										value={setupCommandInput}
										onChange={(e) => setSetupCommandInput(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Escape") setEditingProjectId(null);
										}}
										placeholder="e.g. npm install (optional)"
										className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
									/>
									<p className="text-[10px] text-muted-foreground">
										Runs once in each new workspace's worktree, before the agent starts.
									</p>
									<div className="flex gap-1.5">
										<button
											type="submit"
											disabled={busy}
											className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
										>
											Save
										</button>
										<button
											type="button"
											onClick={() => setEditingProjectId(null)}
											className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
										>
											Cancel
										</button>
									</div>
								</form>
							</li>
						) : (
							<li key={p.id} className="group relative">
								<button
									type="button"
									onClick={() => onSelect(p.id)}
									className={cn(
										"w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors",
										selectedProjectId === p.id
											? "bg-sidebar-accent text-sidebar-accent-foreground"
											: "hover:bg-sidebar-accent/50",
									)}
								>
									<div className="truncate font-medium">{p.name}</div>
									<div className="truncate text-xs text-muted-foreground">
										{p.repoPath}
									</div>
									{p.setupCommand && (
										<div className="truncate text-[10px] text-muted-foreground/70">
											⚙ {p.setupCommand}
										</div>
									)}
								</button>
								<div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 group-hover:opacity-100">
									<button
										type="button"
										onClick={() => {
											setEditingProjectId(p.id);
											setSetupCommandInput(p.setupCommand ?? "");
										}}
										title="Edit setup command"
										className="rounded px-1 text-xs text-muted-foreground hover:bg-sidebar-accent"
									>
										<Pencil className="size-3" />
									</button>
									<button
										type="button"
										onClick={() => onRemove(p.id)}
										title="Remove from list"
										className="rounded px-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
									>
										✕
									</button>
								</div>
							</li>
						),
					)}
					{projects.length === 0 && (
						<li className="px-2.5 py-2 text-xs text-muted-foreground">
							No projects yet.
						</li>
					)}
				</ul>
			</div>
			<div className="border-t border-sidebar-border p-2">
				{adding ? (
					<form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
						<input
							autoFocus
							value={repoPathInput}
							onChange={(e) => setRepoPathInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									setAdding(false);
									setRepoPathInput("");
								}
							}}
							placeholder="~/path/to/repo"
							className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
						/>
						<div className="flex gap-1.5">
							<button
								type="submit"
								disabled={busy}
								className="flex-1 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
							>
								Add
							</button>
							<button
								type="button"
								onClick={() => {
									setAdding(false);
									setRepoPathInput("");
								}}
								className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
							>
								Cancel
							</button>
						</div>
					</form>
				) : (
					<button
						type="button"
						onClick={() => setAdding(true)}
						className="w-full rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
					>
						+ Add project
					</button>
				)}
			</div>
		</div>
	);
}
