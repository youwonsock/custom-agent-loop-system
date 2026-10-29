import { Component, type ReactNode } from "react";
export class ViewBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <div className="empty-state" role="alert">
          <h2>화면을 불러오지 못했습니다</h2>
          <p>{this.state.error.message}</p>
          <button className="button" onClick={() => location.reload()}>
            새로고침
          </button>
        </div>
      );
    return this.props.children;
  }
}
