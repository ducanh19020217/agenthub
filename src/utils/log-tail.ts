import fs from 'node:fs';

export interface ReadLogTailOptions {
  /** Maximum number of lines from the end of the file to return */
  lines?: number;
  /** Maximum number of bytes to read from the end (default: 512 * 1024) */
  maxBytes?: number;
}

/**
 * Reads the tail of a file up to maxBytes or last N lines without loading
 * the whole file into memory.
 * Handles UTF-8 multi-byte character boundaries at chunk boundaries.
 */
export function readLogTail(
  filePath: string | null | undefined,
  options?: ReadLogTailOptions | number,
): string {
  if (!filePath || !fs.existsSync(filePath)) return '';

  const opts: ReadLogTailOptions =
    typeof options === 'number'
      ? { maxBytes: Math.min(Math.max(1, options), 512) * 1024 }
      : options || {};

  const maxBytes = opts.maxBytes !== undefined && opts.maxBytes > 0
    ? opts.maxBytes
    : 512 * 1024;
  const targetLines = opts.lines !== undefined && opts.lines > 0 ? opts.lines : undefined;

  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return '';
  }

  try {
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize === 0) return '';

    if (targetLines === undefined) {
      const bytesToRead = Math.min(fileSize, maxBytes);
      const startPos = fileSize - bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, startPos);

      let startIndex = 0;
      if (startPos > 0) {
        // Skip UTF-8 continuation bytes (10xxxxxx) to align to a character boundary
        while (startIndex < buffer.length && (buffer[startIndex] & 0xc0) === 0x80) {
          startIndex++;
        }
      }
      return buffer.subarray(startIndex).toString('utf-8');
    }

    // targetLines is specified: read backwards in chunks
    const chunkSize = 64 * 1024;
    let currentEnd = fileSize;
    let newlineCount = 0;
    const chunks: Buffer[] = [];
    let totalBytesRead = 0;

    while (currentEnd > 0 && totalBytesRead < maxBytes) {
      const bytesToRead = Math.min(currentEnd, chunkSize, maxBytes - totalBytesRead);
      const startPos = currentEnd - bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, startPos);

      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i] === 0x0a) {
          newlineCount++;
        }
      }

      chunks.unshift(buffer);
      totalBytesRead += bytesToRead;
      currentEnd = startPos;

      if (newlineCount > targetLines) {
        break;
      }
    }

    const combined = Buffer.concat(chunks);
    let startIndex = 0;
    if (currentEnd > 0) {
      while (startIndex < combined.length && (combined[startIndex] & 0xc0) === 0x80) {
        startIndex++;
      }
    }

    const text = combined.subarray(startIndex).toString('utf-8');
    const lines = text.split('\n');
    return lines.slice(-targetLines).join('\n');
  } catch {
    return '';
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}
