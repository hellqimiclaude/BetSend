import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * The bridge between the BetSend page and the app hosting it.
 *
 * The page is served by the office server, so this is the one place where
 * something remote can ask the local machine to do anything. It is kept as
 * narrow as it can be: the page can see what the user right-clicked, drop
 * one of those files, and start the upload. It cannot name a file itself,
 * so there is no call here that could be talked into reading somewhere it
 * was not pointed.
 *
 * Note what is absent: no path ever crosses, in either direction.
 */

type Staged = { id: string; name: string; size: number };

contextBridge.exposeInMainWorld('betsendHost', {
  /** Marks this as the desktop app, so the page can offer what only it can do. */
  version: 1 as const,

  staged: (): Promise<Staged[]> => ipcRenderer.invoke('host:staged'),

  /**
   * Files the user dropped on the page or picked from the file dialog.
   *
   * These go through the host as well, so the desktop app has one upload
   * path rather than two. getPathForFile is the only way across: a File the
   * user chose has a path the app may read, which is a different thing from
   * the page being able to name any path it likes.
   */
  stagePicked: (files: File[]): Promise<Staged[]> =>
    ipcRenderer.invoke(
      'host:stage-paths',
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
    ),
  unstage: (id: string): Promise<Staged[]> => ipcRenderer.invoke('host:unstage', id),
  clear: (): Promise<void> => ipcRenderer.invoke('host:clear'),

  /** Uploads everything staged, then commits it as one transfer. */
  send: (recipients: string[], note: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('host:send', { recipients, note }),

  cancel: (): Promise<void> => ipcRenderer.invoke('host:cancel'),

  onStagedChanged: (callback: (files: Staged[]) => void): (() => void) => {
    const listener = (_event: unknown, files: Staged[]): void => callback(files);
    ipcRenderer.on('host:staged-changed', listener);
    return () => ipcRenderer.removeListener('host:staged-changed', listener);
  },

  onProgress: (callback: (progress: unknown) => void): (() => void) => {
    const listener = (_event: unknown, progress: unknown): void => callback(progress);
    ipcRenderer.on('host:progress', listener);
    return () => ipcRenderer.removeListener('host:progress', listener);
  },
});
