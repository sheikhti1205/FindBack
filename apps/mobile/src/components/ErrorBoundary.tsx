import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { logError } from "../utils/log";

interface InnerProps {
  children: ReactNode;
  resetKey: string;
  onRetry: () => void;
}

interface State {
  error: Error | null;
}

/**
 * Keeps a screen-level render error from turning into a blank, dead app.
 *
 * Recovery navigates to Home (a known-good route) instead of just clearing
 * the flag: a deterministically crashing screen would otherwise throw again
 * on the next render. The raw message is logged for diagnostics but never
 * shown, so implementation details do not leak to users.
 */
class ErrorBoundaryInner extends Component<InnerProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logError("FindBack screen error:", error, info.componentStack);
  }

  componentDidUpdate(prevProps: InnerProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-on-surface-variant">
            This screen could not be shown. Your reports and drafts are safe.
          </p>
          <button
            type="button"
            onClick={this.props.onRetry}
            className="min-h-[48px] rounded-lg bg-on-surface px-4 text-surface"
          >
            Back to Home
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ErrorBoundary({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <ErrorBoundaryInner resetKey={pathname} onRetry={() => navigate("/", { replace: true })}>
      {children}
    </ErrorBoundaryInner>
  );
}
