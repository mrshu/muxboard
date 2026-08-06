/** Minimal logger so core services stay decoupled from the Stream Deck SDK. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** No-op logger used by default in tests. */
export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

/** Error → message string, for log lines. */
export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
