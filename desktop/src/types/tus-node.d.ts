/**
 * tus-js-client ships one set of typings, written for the browser, while the
 * package's default entry point is the Node build. FileUrlStorage is real at
 * runtime -- it is how an upload URL survives a restart -- but missing from
 * those typings.
 *
 * The leading import matters: without it this file would be a script and the
 * block below would replace the package's types rather than add to them.
 */
import 'tus-js-client';

declare module 'tus-js-client' {
  /**
   * Keeps tus's record of each upload in a JSON file, not in memory.
   * Declared as implementing UrlStorage so it can be passed as one.
   */
  export class FileUrlStorage implements UrlStorage {
    constructor(filePath: string);
    findAllUploads(): Promise<PreviousUpload[]>;
    findUploadsByFingerprint(fingerprint: string): Promise<PreviousUpload[]>;
    removeUpload(urlStorageKey: string): Promise<void>;
    addUpload(fingerprint: string, upload: PreviousUpload): Promise<string>;
  }
}
