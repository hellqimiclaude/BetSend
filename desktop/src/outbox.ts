import type { StagedFile, StagingResult } from './staging.js';
import { stageFiles } from './staging.js';

/**
 * What the app is holding, waiting for somebody to say who it goes to.
 *
 * Right-clicking files in Explorer puts them here; the window then shows
 * them and collects recipients. Kept out of the main process file so it can
 * be tested without starting Electron.
 */
export class Outbox {
  private staged: StagedFile[] = [];

  /** Returns what was added and what was refused, for telling the user. */
  add(paths: readonly string[]): StagingResult {
    const result = stageFiles(paths, this.staged);
    this.staged = [...this.staged, ...result.files];
    return result;
  }

  get files(): readonly StagedFile[] {
    return this.staged;
  }

  get totalBytes(): number {
    return this.staged.reduce((sum, file) => sum + file.size, 0);
  }

  remove(id: string): boolean {
    const before = this.staged.length;
    this.staged = this.staged.filter((file) => file.id !== id);
    return this.staged.length !== before;
  }

  clear(): void {
    this.staged = [];
  }

  /**
   * What the window is allowed to see. Names and sizes only -- the page is
   * served by the server, and the full path of somebody's hard disk is not
   * the server's business.
   */
  forRenderer(): { id: string; name: string; size: number }[] {
    return this.staged.map(({ id, name, size }) => ({ id, name, size }));
  }
}
