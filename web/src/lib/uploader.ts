import * as tus from 'tus-js-client';
import { notifySignedOut } from './api';

/**
 * Chunked, resumable uploads.
 *
 * tus-js-client slices each File with `Blob.slice`, so only one chunk is ever
 * in memory — a 10 GB file uploads with the same footprint as a 10 MB one.
 * If the connection drops, tus retries and continues from the offset the
 * server acknowledged; it never restarts from zero.
 */

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';

export interface UploadItem {
  key: string;
  file: File;
  name: string;
  size: number;
  /** Server-side upload id, available once the file has been created. */
  uploadId: string | null;
  bytesUploaded: number;
  status: UploadStatus;
  error?: string;
}

export interface BatchProgress {
  items: UploadItem[];
  bytesUploaded: number;
  bytesTotal: number;
  /** 0–1 */
  fraction: number;
  bytesPerSecond: number;
  secondsRemaining: number;
  filesDone: number;
  running: boolean;
}

export interface UploadBatchOptions {
  endpoint: string;
  chunkSize: number;
  concurrency?: number;
  onProgress: (progress: BatchProgress) => void;
}

let keyCounter = 0;

export class UploadBatch {
  private items: UploadItem[];
  private uploads = new Map<string, tus.Upload>();
  private options: UploadBatchOptions;
  private running = false;
  private aborted = false;
  private ticker: number | null = null;

  // Rolling speed estimate.
  private lastSampleAt = 0;
  private lastSampleBytes = 0;
  private smoothedSpeed = 0;

  private resolveAll: ((ids: string[]) => void) | null = null;
  private rejectAll: ((error: Error) => void) | null = null;

  constructor(files: File[], options: UploadBatchOptions) {
    this.options = options;
    this.items = files.map((file) => ({
      key: `u${++keyCounter}`,
      file,
      name: file.name,
      size: file.size,
      uploadId: null,
      bytesUploaded: 0,
      status: 'queued' as UploadStatus,
    }));
  }

  get files(): UploadItem[] {
    return this.items;
  }

  /** Resolves with the server upload ids, in the order the files were added. */
  start(): Promise<string[]> {
    this.running = true;
    this.aborted = false;
    this.lastSampleAt = Date.now();
    this.lastSampleBytes = 0;

    // Recompute speed on a timer rather than per-chunk: chunk callbacks are
    // bursty and would make the number jump around.
    this.ticker = window.setInterval(() => this.emit(), 500);

    const promise = new Promise<string[]>((resolve, reject) => {
      this.resolveAll = resolve;
      this.rejectAll = reject;
    });

    const concurrency = Math.max(1, this.options.concurrency ?? 2);
    for (let i = 0; i < concurrency; i++) this.pump();
    this.emit();

    return promise;
  }

  /** Cancel everything and ask the server to drop the partial files. */
  async abort(): Promise<void> {
    this.aborted = true;
    this.running = false;
    for (const [key, upload] of this.uploads) {
      const item = this.items.find((i) => i.key === key);
      if (item && item.status === 'uploading') item.status = 'cancelled';
      try {
        await upload.abort(true);
      } catch {
        /* the server will sweep the partial file either way */
      }
    }
    this.uploads.clear();
    for (const item of this.items) {
      if (item.status === 'queued' || item.status === 'uploading') item.status = 'cancelled';
    }
    this.stopTicker();
    this.emit();
    this.rejectAll?.(new DOMException('Upload cancelled', 'AbortError'));
    this.resolveAll = null;
    this.rejectAll = null;
  }

  private stopTicker(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /** Start the next queued file, or finish the batch when nothing is left. */
  private pump(): void {
    if (this.aborted) return;

    const next = this.items.find((item) => item.status === 'queued');
    if (!next) {
      const stillGoing = this.items.some((item) => item.status === 'uploading');
      if (!stillGoing) this.finish();
      return;
    }

    next.status = 'uploading';
    this.upload(next);
  }

  private finish(): void {
    this.running = false;
    this.stopTicker();
    this.emit();

    const failed = this.items.find((item) => item.status === 'error');
    if (failed) {
      this.rejectAll?.(new Error(failed.error ?? 'Upload failed.'));
    } else {
      this.resolveAll?.(this.items.map((item) => item.uploadId!).filter(Boolean));
    }
    this.resolveAll = null;
    this.rejectAll = null;
  }

  private upload(item: UploadItem): void {
    const upload = new tus.Upload(item.file, {
      endpoint: this.options.endpoint,
      chunkSize: this.options.chunkSize,
      // Back off and keep trying: a LAN blip should never lose an hour of upload.
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
      metadata: {
        filename: item.file.name,
        filetype: item.file.type || 'application/octet-stream',
      },
      // Fingerprints let a re-added file pick up where it left off after a refresh.
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,
      onProgress: (uploaded) => {
        item.bytesUploaded = uploaded;
      },
      onSuccess: () => {
        item.bytesUploaded = item.size;
        item.status = 'done';
        item.uploadId = extractUploadId(upload.url);
        this.uploads.delete(item.key);
        this.emit();
        this.pump();
      },
      onError: (error) => {
        if (this.aborted) return;
        if ((error as tus.DetailedError).originalResponse?.getStatus?.() === 401) {
          // Same path as any other expired session: back to the sign-in screen.
          notifySignedOut();
        }
        item.status = 'error';
        item.error = friendlyUploadError(error);
        this.uploads.delete(item.key);
        this.emit();
        this.pump();
      },
    });

    this.uploads.set(item.key, upload);

    // Resume a matching half-finished upload from a previous page load.
    upload
      .findPreviousUploads()
      .then((previous) => {
        if (this.aborted) return;
        if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      })
      .catch(() => {
        if (!this.aborted) upload.start();
      });
  }

  private emit(): void {
    const bytesTotal = this.items.reduce((sum, item) => sum + item.size, 0);
    const bytesUploaded = this.items.reduce((sum, item) => sum + item.bytesUploaded, 0);

    const nowMs = Date.now();
    const elapsed = (nowMs - this.lastSampleAt) / 1000;
    if (elapsed >= 0.4) {
      const instant = Math.max(0, (bytesUploaded - this.lastSampleBytes) / elapsed);
      // Exponential smoothing keeps the readout calm without lagging too far behind.
      this.smoothedSpeed = this.smoothedSpeed === 0 ? instant : this.smoothedSpeed * 0.7 + instant * 0.3;
      this.lastSampleAt = nowMs;
      this.lastSampleBytes = bytesUploaded;
    }

    const remainingBytes = Math.max(0, bytesTotal - bytesUploaded);
    this.options.onProgress({
      items: [...this.items],
      bytesUploaded,
      bytesTotal,
      fraction: bytesTotal === 0 ? 0 : bytesUploaded / bytesTotal,
      bytesPerSecond: this.running ? this.smoothedSpeed : 0,
      secondsRemaining: this.smoothedSpeed > 0 ? remainingBytes / this.smoothedSpeed : 0,
      filesDone: this.items.filter((item) => item.status === 'done').length,
      running: this.running,
    });
  }
}

function extractUploadId(url: string | null): string | null {
  if (!url) return null;
  const clean = url.split('?')[0].replace(/\/+$/, '');
  const id = clean.slice(clean.lastIndexOf('/') + 1);
  return id || null;
}

function friendlyUploadError(error: Error | tus.DetailedError): string {
  const response = (error as tus.DetailedError).originalResponse;
  const status = response?.getStatus?.();

  // The server explains refusals in plain language (too large, disk full,
  // over quota); prefer its wording over anything guessed from the status.
  if (status === 413 || status === 403) {
    const message = serverMessage(response?.getBody?.());
    if (message) return message;
  }

  if (status === 413) return 'This file is larger than the server allows.';
  if (status === 401) return 'You have been signed out. Sign in again and the upload will continue where it stopped.';
  if (status === 403) return 'The server refused this upload.';
  if (status === 507 || status === 500) return 'The server ran out of room for this file.';
  return 'The connection dropped and could not be restored. You can try again — it will continue where it stopped.';
}

/** Pull `{ error: { message } }` out of a response body, if that is what it is. */
function serverMessage(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed?.error?.message ?? null;
  } catch {
    return null;
  }
}
