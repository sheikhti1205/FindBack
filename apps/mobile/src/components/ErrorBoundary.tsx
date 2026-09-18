import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps a screen-level render error from turning into a blank, dead app.
 *
 * Without this, any thrown error unmounts the whole tree and the WebView shows
 * nothing, with no way back. Here the error is surfaced and recoverable.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("FindBack screen error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="break-words text-sm text-on-surface-variant">
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="min-h-[48px] rounded-lg bg-on-surface px-4 text-surface"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
