// Contains a rendering crash to the pane that threw, instead of taking down
// the whole app with a blank white screen. React requires a class component
// for error boundaries — no hook equivalent exists.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
	children: ReactNode;
	/** Remounts the boundary (clearing the error) when this changes — e.g. pass
	 * the workspace/tab key so switching away and back retries cleanly. */
	resetKey?: string;
}

interface ErrorBoundaryState {
	error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("[ErrorBoundary]", error, info.componentStack);
	}

	componentDidUpdate(prevProps: ErrorBoundaryProps) {
		if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
			this.setState({ error: null });
		}
	}

	render() {
		if (this.state.error) {
			return (
				<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
					<p className="text-sm font-medium text-destructive">
						This panel failed to render.
					</p>
					<p className="max-w-md text-xs text-muted-foreground">
						{this.state.error.message}
					</p>
					<button
						type="button"
						onClick={() => this.setState({ error: null })}
						className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
					>
						Retry
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
