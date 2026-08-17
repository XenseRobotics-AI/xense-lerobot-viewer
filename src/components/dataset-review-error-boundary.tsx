"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type DatasetReviewErrorBoundaryProps = {
  children: ReactNode;
};

type DatasetReviewErrorBoundaryState = {
  error: Error | null;
};

/**
 * Keeps failures in the optional Dataset Review bundle local to that tab.
 *
 * Fetch failures are rendered by DatasetReviewPanel itself. This boundary is
 * for failures that happen while loading the lazy chunk or rendering a
 * malformed response, so Doctor/Parquet/Episodes can keep working.
 */
export default class DatasetReviewErrorBoundary extends Component<
  DatasetReviewErrorBoundaryProps,
  DatasetReviewErrorBoundaryState
> {
  state: DatasetReviewErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[dataset-review] Render failed:", error, errorInfo);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <section className="mx-auto w-full max-w-4xl rounded-xl border border-red-400/30 bg-red-400/5 p-5 text-red-100">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-red-300">
                Dataset Review error
              </p>
              <h2 className="mt-1 text-lg font-semibold text-red-100">
                检查页加载失败
              </h2>
            </div>
            <button
              type="button"
              onClick={this.reset}
              className="rounded-md border border-red-300/30 px-3 py-1.5 text-xs text-red-100 transition-colors hover:border-red-200/70 hover:bg-red-300/10"
            >
              重试
            </button>
          </div>
          <p className="mt-4 whitespace-pre-wrap break-words rounded-md border border-red-300/15 bg-black/10 p-3 font-mono text-xs text-red-200/90">
            {this.state.error.message || String(this.state.error)}
          </p>
          <p className="mt-3 text-xs text-red-200/60">
            该错误已限制在 Dataset Review 页签内，不会影响 Episodes、Doctor 或
            Parquet。
          </p>
        </section>
      );
    }

    return this.props.children;
  }
}
