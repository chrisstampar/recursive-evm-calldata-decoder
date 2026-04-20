import { Component, Fragment, type ReactNode, type ErrorInfo } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Replaces the built-in red panel entirely. **Does not** wrap `children` in the keyed `Fragment` used
   * for remount-on-reset: after recovery, only the default UI path bumps `resetKey`. For custom fallbacks,
   * add your own `key` on `children` (or remount logic) if you need the same “fresh subtree” behavior.
   */
  fallback?: ReactNode;
  /** Analytics / monitoring (e.g. Sentry). Invoked for every caught error (prod and dev). */
  onError?: (error: Error, info: ErrorInfo) => void;
  /**
   * Called when the default UI’s **Try again** is used (incrementing `resetKey` and clearing the error).
   * Not invoked for a custom `fallback` unless you wire it yourself.
   */
  onReset?: () => void;
  /**
   * Delay (ms) before clearing error state after **Try again**, so the browser can finish scheduling work.
   * Must be finite and ≥ 0; invalid values fall back to **50**. Ignored for custom `fallback` (no built-in reset).
   */
  resetDelay?: number;
  /**
   * Overrides the default single-line summary in the built-in fallback (otherwise uses `error.message`, with
   * `error.name` prefixed when it is not the generic `"Error"`). Use for codes / structured copy; keep output
   * short—do not stringify unknown objects (risk of cycles or huge payloads).
   */
  formatError?: (error: Error) => ReactNode;
}

/** Boundary state; exported for subclasses or typed refs. */
export interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  /** Bumped on "Try again" so keyed children remount and stale state/props cannot immediately rethrow. */
  resetKey: number;
  /** React component stack from `componentDidCatch`; dev UI + cleared on reset. */
  errorComponentStack: string | null;
}

const DEFAULT_RESET_DELAY_MS = 50;

function normalizeResetDelayMs(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return DEFAULT_RESET_DELAY_MS;
  return raw;
}

/** Safe one-line summary for `Error` (message is always a string on `Error`; avoids extra serialization). */
function defaultErrorSummaryLine(error: Error | null): string {
  if (!error) return 'Unknown error';
  const msg = error.message.trim() || '(no message)';
  if (error.name && error.name !== 'Error') return `${error.name}: ${msg}`;
  return msg;
}

/**
 * React error boundary (class component).
 *
 * **Does not catch:** errors in event handlers (`onClick`, etc.), async work (unhandled promise
 * rejections, `setTimeout` callbacks), SSR render errors, or errors thrown while this boundary itself
 * renders. Use `try/catch` (or equivalent) in those paths.
 *
 * **Remounting:** an internal `resetKey` and keyed `Fragment` remount `children` after **Try again**
 * (after {@link ErrorBoundaryProps.resetDelay}, default 50ms). Custom {@link ErrorBoundaryProps.fallback}
 * does not use that keyed fragment—see prop docs. For a full boundary remount, the parent can pass an outer `key`.
 *
 * **Default UI styling:** uses Tailwind utilities (`red-950/20`, opacity `/30`, etc.); requires a standard
 * v4 `@import "tailwindcss"` setup (no extra config for these palette steps).
 *
 * **Stacks in production:** JS/React stacks below render only when `import.meta.env.DEV` is true, so
 * typical production builds do not surface them in the DOM. Bundlers usually avoid leaking absolute
 * host paths in shipped chunks; still avoid logging raw stacks in prod unless scrubbed.
 *
 * @example Large tree: custom fallback + `onError` for reporting. Widget: `onReset` to clear stale data.
 * ```tsx
 * <ErrorBoundary fallback={<RouteErrorFallback />} onError={logToSentry}>
 *   <RouterProvider router={router} />
 * </ErrorBoundary>
 * <ErrorBoundary onReset={refreshData} onError={() => toast.error('Widget failed')}>
 *   <ComplexChart />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    resetKey: 0,
    errorComponentStack: null,
  };

  /** Browser `setTimeout` id (DOM typings use `number`, not Node's `Timeout`). */
  private resetDelayId: number | null = null;

  componentWillUnmount(): void {
    if (this.resetDelayId != null) {
      clearTimeout(this.resetDelayId);
      this.resetDelayId = null;
    }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);

    if (import.meta.env.DEV) {
      console.error('ErrorBoundary caught:', error);
      if (info.componentStack) {
        console.error('Component stack:', info.componentStack.trim());
      }
    }

    this.setState({
      errorComponentStack: info.componentStack?.trim() ?? null,
    });
  }

  private handleReset = (): void => {
    if (this.resetDelayId != null) {
      return;
    }
    this.props.onReset?.();
    const delayMs = normalizeResetDelayMs(this.props.resetDelay);
    this.resetDelayId = window.setTimeout(() => {
      this.resetDelayId = null;
      this.setState(prev => ({
        hasError: false,
        error: null,
        resetKey: prev.resetKey + 1,
        errorComponentStack: null,
      }));
    }, delayMs);
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const dev = import.meta.env.DEV;
      const err = this.state.error;
      const stackPre =
        'mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all border-t border-red-500/20 pt-2 text-xs font-mono text-red-300/60';

      return (
        <div
          className="rounded-lg border border-red-500/30 bg-red-950/20 p-4"
          role="alert"
          aria-live="assertive"
        >
          <h3 className="text-sm font-semibold text-red-400">Something went wrong</h3>
          <p className="mt-1 text-xs text-red-300/70 font-mono">
            {this.props.formatError && err ? this.props.formatError(err) : defaultErrorSummaryLine(err)}
          </p>
          {/*
            Stacks only in dev — production Vite sets import.meta.env.DEV false, so these nodes are omitted
            and local file paths from the dev server are not shown to end users.
          */}
          {dev && this.state.error?.stack ? (
            <pre className={stackPre} aria-label="JavaScript stack trace">
              {this.state.error.stack}
            </pre>
          ) : null}
          {dev && this.state.errorComponentStack ? (
            <pre className={stackPre} aria-label="React component stack">
              {this.state.errorComponentStack}
            </pre>
          ) : null}
          <button
            type="button"
            aria-label="Attempt to recover from error and reload component"
            className="mt-3 text-xs text-red-400 underline hover:text-red-300"
            onClick={this.handleReset}
          >
            Try again
          </button>
        </div>
      );
    }

    return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>;
  }
}
