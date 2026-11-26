// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Transform, type TransformCallback } from 'node:stream';
import { createGunzip } from 'node:zlib';

/** Largest unpacked size we read from a .gz log (Cloudflare Logpush writes gzip files). Stops gzip bombs. */
export const MAX_LOG_UNZIPPED_BYTES = 1024 * 1024 * 1024;

export class LogFileTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`the unpacked log is over ${Math.round(limitBytes / (1024 * 1024))} MB, so it was not read to the end`);
    this.name = 'LogFileTooLargeError';
  }
}

async function isGzip(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(2), 0, 2, 0);
    return bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  } finally {
    await fh.close();
  }
}

function byteCap(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      total += chunk.length;
      if (total > limit) cb(new LogFileTooLargeError(limit));
      else cb(null, chunk);
    },
  });
}

/**
 * Lines of an access log, streamed once, gzip unpacked on the fly (detected by its magic bytes, not the name) and capped
 * at `maxUnzippedBytes`. Throws LogFileTooLargeError past the cap, and the file system's error when it can't be read.
 */
export async function* logFileLines(path: string, opts: { maxUnzippedBytes?: number } = {}): AsyncGenerator<string> {
  const gz = await isGzip(path);
  const file = createReadStream(path);
  const input = gz ? file.pipe(createGunzip()).pipe(byteCap(opts.maxUnzippedBytes ?? MAX_LOG_UNZIPPED_BYTES)) : file;
  if (gz) {
    file.on('error', (e) => input.destroy(e));
  }
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    file.destroy();
    input.destroy();
  }
}
