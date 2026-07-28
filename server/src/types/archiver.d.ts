/**
 * archiver v8 ships no type declarations and @types/archiver still describes
 * the v7 CommonJS factory. This covers exactly the surface we use.
 */
declare module 'archiver' {
  import { Transform } from 'node:stream';

  interface ArchiverOptions {
    /** true = store entries uncompressed (fastest; office files are mostly already compressed). */
    store?: boolean;
    zlib?: { level?: number };
    statConcurrency?: number;
  }

  interface EntryData {
    name: string;
    date?: Date | string;
    mode?: number;
  }

  class Archiver extends Transform {
    constructor(options?: ArchiverOptions);
    append(source: NodeJS.ReadableStream | Buffer | string, data: EntryData): this;
    file(filepath: string, data: EntryData): this;
    finalize(): Promise<void>;
    abort(): this;
    pointer(): number;
  }

  export class ZipArchive extends Archiver {}
  export class TarArchive extends Archiver {}
  export class JsonArchive extends Archiver {}
  export { Archiver };
}
