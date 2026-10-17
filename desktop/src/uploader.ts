import fs from 'node:fs';
import * as tus from 'tus-js-client';
import type { StagedFile } from './staging.js';

/**
 * Uploading files the app was given by Explorer.
 *
 * The web page cannot do this. Electron will tell you the path behind a File
 * a user dropped, but there is no way back -- a path cannot be turned into
 * something a remote page can read, and that is deliberate on the browser's
 * part. So when the shell hands us a path, the upload has to happen here,
 * outside the page.
 *
 * The protocol is the same tus the browser uses, against the same endpoint,
 * so the server cannot tell the difference. Reading through a stream keeps
 * a 10 GB file to one chunk in memory, as it is in the browser.
 */

export interface UploadingFile {
  id: string;
  name: string;
  size: number;
  bytesUploaded: number;
  status: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';
  uploadId: string | null;
  error?: string;
}

export interface BatchProgress {
  files: UploadingFile[];
  bytesUploaded: number;
  bytesTotal: number;
  fraction: number;
  filesDone: number;
  running: boolean;
}

export interface UploaderOptions {
  /** Server origin, e.g. http://betsend-pc:8080 */
  origin: string;
  /** The session cookie from the signed-in window, as a Cookie header value. */
  cookie: string;
  chunkSize: number;
  onProgress?: (progress: BatchProgress) => void;
}

/** tus hands back a URL; the server wants the last segment of it. */
export function uploadIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const clean = url.split('?')[0].replace(/\/+$/, '');
  const id = clean.slice(clean.lastIndexOf('/') + 1);
  return id || null;
}

export function summarise(files: readonly UploadingFile[], running: boolean): BatchProgress {
  const bytesTotal = files.reduce((sum, f) => sum + f.size, 0);
  const bytesUploaded = files.reduce((sum, f) => sum + f.bytesUploaded, 0);
  return {
    files: files.map((f) => ({ ...f })),
    bytesUploaded,
    bytesTotal,
    fraction: bytesTotal === 0 ? 0 : bytesUploaded / bytesTotal,
    filesDone: files.filter((f) => f.status === 'done').length,
    running,
  };
}

export class HostUploadBatch {
  private readonly files: UploadingFile[];
  private readonly paths = new Map<string, string>();
  private readonly uploads = new Map<string, tus.Upload>();
  private running = false;
  private cancelled = false;

  constructor(
    staged: readonly StagedFile[],
    private readonly options: UploaderOptions,
  ) {
    this.files = staged.map((file) => ({
      id: file.id,
      name: file.name,
      size: file.size,
      bytesUploaded: 0,
      status: 'queued',
      uploadId: null,
    }));
    for (const file of staged) this.paths.set(file.id, file.path);
  }

  get progress(): BatchProgress {
    return summarise(this.files, this.running);
  }

  /** Uploads everything, one at a time, and resolves with the server's ids. */
  async start(): Promise<string[]> {
    this.running = true;
    this.emit();

    try {
      // Sequential on purpose. These uploads come from a right-click, so the
      // files are usually on one disk, and reading several at once makes a
      // spinning disk slower rather than faster.
      for (const file of this.files) {
        if (this.cancelled) break;
        await this.uploadOne(file);
        if (file.status === 'error') throw new Error(file.error ?? 'Upload failed.');
      }
    } finally {
      this.running = false;
      this.emit();
    }

    if (this.cancelled) throw new Error('Upload cancelled.');
    return this.files.map((f) => f.uploadId).filter((id): id is string => Boolean(id));
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    for (const upload of this.uploads.values()) {
      try {
        await upload.abort(true);
      } catch {
        /* the server sweeps abandoned uploads anyway */
      }
    }
    this.uploads.clear();
    for (const file of this.files) {
      if (file.status === 'queued' || file.status === 'uploading') file.status = 'cancelled';
    }
    this.running = false;
    this.emit();
  }

  private uploadOne(file: UploadingFile): Promise<void> {
    const source = this.paths.get(file.id);
    if (!source) {
      file.status = 'error';
      file.error = 'That file is no longer staged.';
      return Promise.resolve();
    }

    file.status = 'uploading';
    this.emit();

    return new Promise<void>((resolve) => {
      // A stream, not a buffer: the whole point is that file size does not
      // become memory. tus needs the size told to it for the same reason --
      // it cannot measure a stream without consuming it.
      const stream = fs.createReadStream(source);

      const upload = new tus.Upload(stream, {
        endpoint: `${this.options.origin.replace(/\/+$/, '')}/api/uploads`,
        chunkSize: this.options.chunkSize,
        uploadSize: file.size,
        retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
        headers: { cookie: this.options.cookie },
        metadata: { filename: file.name, filetype: 'application/octet-stream' },
        onProgress: (uploaded) => {
          file.bytesUploaded = uploaded;
          this.emit();
        },
        onSuccess: () => {
          file.bytesUploaded = file.size;
          file.status = 'done';
          file.uploadId = uploadIdFromUrl(upload.url);
          this.uploads.delete(file.id);
          this.emit();
          resolve();
        },
        onError: (error) => {
          this.uploads.delete(file.id);
          if (this.cancelled) {
            resolve();
            return;
          }
          file.status = 'error';
          file.error = describeUploadError(error);
          this.emit();
          resolve();
        },
      });

      this.uploads.set(file.id, upload);
      upload.start();
    });
  }

  private emit(): void {
    this.options.onProgress?.(this.progress);
  }
}

/**
 * The server explains refusals in plain language -- too large, disk full,
 * over quota -- so prefer its words to anything guessed from a status code.
 */
export function describeUploadError(error: Error | tus.DetailedError): string {
  const response = (error as tus.DetailedError).originalResponse;
  const status = response?.getStatus?.();

  const fromServer = serverMessage(response?.getBody?.());
  if (fromServer && (status === 413 || status === 403 || status === 507)) return fromServer;

  if (status === 401) return 'The app has been signed out. Open BetSend, sign in, and try again.';
  if (status === 413) return 'That file is larger than the server allows.';
  if (status === 403) return 'The server refused the upload.';
  if (status === 507 || status === 500) return 'The server ran out of room.';
  return 'The connection dropped. Try again — it will continue where it stopped.';
}

function serverMessage(body: string | undefined): string | null {
  if (!body) return null;
  try {
    return (JSON.parse(body) as { error?: { message?: string } })?.error?.message ?? null;
  } catch {
    return null;
  }
}
