/** Crosses process boundaries as text, so the message always carries it. */
export const IO_UNAVAILABLE = "[AGENT_GRAPH_IO_UNAVAILABLE]";
/** Program isolation cannot run here. The session stops before any model call. */
export class IoUnavailable extends Error {
  constructor(detail: string) {
    super(`${IO_UNAVAILABLE} ${detail}`);
    this.name = "IoUnavailable";
  }
}
