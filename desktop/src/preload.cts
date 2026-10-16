import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between the setup page and the app.
 *
 * Three named calls, no general-purpose channel. The main window gets no
 * preload at all -- it shows a remote page and has no business reaching the
 * machine it runs on.
 */
contextBridge.exposeInMainWorld('betsend', {
  currentAddress: (): Promise<string> => ipcRenderer.invoke('betsend:current-address'),
  tryAddress: (address: string): Promise<{ ok: boolean; url?: string; error?: string }> =>
    ipcRenderer.invoke('betsend:try-address', address),
  useAddress: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('betsend:use-address', url),
});
