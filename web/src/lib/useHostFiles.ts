import { useCallback, useEffect, useState } from 'react';
import { hostBridge, type HostProgress, type HostStagedFile } from './host';

/**
 * Files the desktop app is holding for us, and the progress of sending them.
 *
 * In a browser this reports an empty list and a null bridge, so the calling
 * component can use the same code and simply never see host files.
 */
export function useHostFiles(): {
  host: ReturnType<typeof hostBridge>;
  staged: HostStagedFile[];
  progress: HostProgress | null;
  stagePicked: (files: File[]) => Promise<{ name: string; reason: string }[]>;
  unstage: (id: string) => Promise<void>;
  clear: () => Promise<void>;
  setProgress: (progress: HostProgress | null) => void;
} {
  const host = hostBridge();
  const [staged, setStaged] = useState<HostStagedFile[]>([]);
  const [progress, setProgress] = useState<HostProgress | null>(null);

  useEffect(() => {
    if (!host) return;

    let live = true;
    void host.staged().then((files) => {
      if (live) setStaged(files);
    });

    const offStaged = host.onStagedChanged((files) => setStaged(files));
    const offProgress = host.onProgress((update) => setProgress(update));

    return () => {
      live = false;
      offStaged();
      offProgress();
    };
  }, [host]);

  const stagePicked = useCallback(
    async (files: File[]) => {
      if (!host || files.length === 0) return [];
      const result = await host.stagePicked(files);
      setStaged(result.files);
      return result.skipped;
    },
    [host],
  );

  const unstage = useCallback(
    async (id: string) => {
      if (!host) return;
      setStaged(await host.unstage(id));
    },
    [host],
  );

  const clear = useCallback(async () => {
    if (!host) return;
    await host.clear();
    setStaged([]);
    setProgress(null);
  }, [host]);

  return { host, staged, progress, stagePicked, unstage, clear, setProgress };
}
