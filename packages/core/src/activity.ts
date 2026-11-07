/**
 * Whether the page or app is in use, for the health-probe timer.
 * A hidden tab makes no probes. Without a browser document, probes stay on.
 * @module
 */

interface VisibilityDocument {
  visibilityState: string;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
}

function visibilityDocument(): VisibilityDocument | undefined {
  const document: unknown = (globalThis as { document?: unknown }).document;
  if (typeof document !== "object" || document === null) return undefined;
  const candidate = document as Partial<VisibilityDocument>;
  if (typeof candidate.visibilityState !== "string") return undefined;
  if (typeof candidate.addEventListener !== "function" || typeof candidate.removeEventListener !== "function") {
    return undefined;
  }
  return candidate as VisibilityDocument;
}

/** Default `isActive`: false only in a browser whose page is hidden. */
export function defaultIsActive(): boolean {
  return visibilityDocument()?.visibilityState !== "hidden";
}

/** One pool's view of activity. */
export class Activity {
  readonly #isActive: () => boolean;
  #stop: (() => void) | undefined;

  constructor(isActive: (() => boolean) | undefined) {
    this.#isActive = isActive ?? defaultIsActive;
  }

  /** A hook that throws counts as active, so probes keep running. */
  active(): boolean {
    try {
      return this.#isActive() !== false;
    } catch {
      return true;
    }
  }

  watch(onChange: () => void): void {
    if (this.#stop) return;
    const document = visibilityDocument();
    if (!document) return;
    document.addEventListener("visibilitychange", onChange);
    this.#stop = (): void => document.removeEventListener("visibilitychange", onChange);
  }

  unwatch(): void {
    const stop = this.#stop;
    this.#stop = undefined;
    stop?.();
  }
}
