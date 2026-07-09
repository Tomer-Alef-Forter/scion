import { useEffect } from "react";

interface ConfirmDialogProps {
	title: string;
	message: string;
	warning?: string;
	confirmLabel?: string;
	destructive?: boolean;
	busy: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function ConfirmDialog({
	title,
	message,
	warning,
	confirmLabel = "Confirm",
	destructive = false,
	busy,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape" && !busy) onCancel();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [busy, onCancel]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
			onClick={(e) => {
				if (e.target === e.currentTarget && !busy) onCancel();
			}}
		>
			<div className="w-full max-w-sm rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg">
				<h2 className="mb-1 text-sm font-semibold">{title}</h2>
				<p className="text-xs text-muted-foreground">{message}</p>
				{warning && (
					<p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
						{warning}
					</p>
				)}
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						disabled={busy}
						className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={busy}
						className={
							destructive
								? "rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
								: "rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
						}
					>
						{busy ? "Working…" : confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
