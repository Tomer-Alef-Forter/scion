import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";

export interface Command {
	id: string;
	label: string;
	hint?: string;
	run: () => void;
}

interface CommandPaletteProps {
	commands: Command[];
	onClose: () => void;
}

function matches(query: string, label: string): boolean {
	if (!query.trim()) return true;
	return label.toLowerCase().includes(query.trim().toLowerCase());
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);

	const filtered = useMemo(
		() => commands.filter((c) => matches(query, c.label)),
		[commands, query],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: query is an intentional trigger — reset the highlighted index whenever the search text changes, even though it isn't read in the body.
	useEffect(() => {
		setActiveIndex(0);
	}, [query]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	function runCommand(cmd: Command) {
		onClose();
		cmd.run();
	}

	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setActiveIndex((i) => Math.max(i - 1, 0));
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const cmd = filtered[activeIndex];
			if (cmd) runCommand(cmd);
		}
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop — click-outside is a mouse convenience; Escape-to-close is handled by the modal's own keydown listener
		// biome-ignore lint/a11y/useKeyWithClickEvents: as above — Escape closes the modal; the backdrop click is mouse-only
		<div
			className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="w-full max-w-lg rounded-lg border border-border bg-card text-card-foreground shadow-lg">
				<input
					ref={inputRef}
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Type a command…"
					className="w-full border-b border-border bg-transparent px-3 py-2.5 text-sm outline-none"
				/>
				<ul className="max-h-80 overflow-y-auto p-1">
					{filtered.length === 0 && (
						<li className="px-3 py-2 text-sm text-muted-foreground">No matching commands.</li>
					)}
					{filtered.map((cmd, i) => (
						<li key={cmd.id}>
							<button
								type="button"
								onClick={() => runCommand(cmd)}
								onMouseEnter={() => setActiveIndex(i)}
								className={cn(
									"flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm",
									i === activeIndex ? "bg-accent" : "hover:bg-muted/50",
								)}
							>
								<span className="truncate">{cmd.label}</span>
								{cmd.hint && (
									<span className="ml-2 shrink-0 text-xs text-muted-foreground">{cmd.hint}</span>
								)}
							</button>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}
