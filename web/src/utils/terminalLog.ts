/**
 * Worker logs are raw terminal output: cargo, npm and agent CLIs emit ANSI
 * colour/cursor sequences and use a bare `\r` to redraw progress lines. Shown
 * as-is, the escape codes appear as `[38;5;77m` noise and redrawn progress
 * lines pile up on one row, so the log is cleaned before it is rendered.
 */

// CSI (colours, cursor moves, erase), OSC (titles, hyperlinks), charset and keypad modes.
// Same shapes the backend strips in `src/api/pty.ts`.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?<>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g;
// Remaining C0 controls except tab and newline (backspace, bell, stray ESC...).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Keep what a terminal would show for a line redrawn with bare `\r`: the last non-empty write. */
function resolveCarriageReturns(line: string): string {
  if (!line.includes('\r')) return line;
  const parts = line.split('\r');
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index] !== '') return parts[index];
  }
  return '';
}

export function cleanTerminalLog(text: string): string {
  if (!text) return text;
  return text
    .replace(/\r\n/g, '\n')
    .replace(ANSI_RE, '')
    .split('\n')
    .map((line) => resolveCarriageReturns(line).replace(CONTROL_RE, ''))
    .join('\n');
}
