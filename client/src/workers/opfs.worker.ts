/// <reference lib="webworker" />
/**
 * Writes an incoming download into the Origin Private File System using a
 * synchronous access handle (the only OPFS write API Safari supports, and
 * only inside workers). Used on WebKit, where service-worker downloads are
 * unreliable: bytes go to disk as they arrive instead of piling up in RAM,
 * and the finished file is then handed to the browser's download manager.
 */
import type { OpfsRequest, OpfsResponse } from '../lib/opfsProtocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let dir: FileSystemDirectoryHandle | null = null;
let fileName = '';
let handle: FileSystemSyncAccessHandle | null = null;
let position = 0;
let queue: Promise<void> = Promise.resolve();

ctx.onmessage = (ev: MessageEvent<OpfsRequest>) => {
  const msg = ev.data;
  queue = queue.then(async () => {
    try {
      await handleMessage(msg);
      ctx.postMessage({ type: 'ok', id: msg.id } satisfies OpfsResponse);
    } catch (err) {
      ctx.postMessage({
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      } satisfies OpfsResponse);
    }
  });
};

async function handleMessage(msg: OpfsRequest): Promise<void> {
  switch (msg.type) {
    case 'open': {
      const root = await navigator.storage.getDirectory();
      dir = await root.getDirectoryHandle(msg.dir, { create: true });
      fileName = msg.name;
      const fh = await dir.getFileHandle(fileName, { create: true });
      handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      position = 0;
      return;
    }
    case 'write': {
      if (!handle) throw new Error('not open');
      let written = 0;
      while (written < msg.chunk.byteLength) {
        const n = handle.write(msg.chunk.subarray(written), { at: position + written });
        if (n <= 0) throw new Error('disk write failed (is the disk full?)');
        written += n;
      }
      position += written;
      return;
    }
    case 'close':
      if (!handle) throw new Error('not open');
      handle.flush();
      handle.close();
      handle = null;
      return;
    case 'abort':
      handle?.close();
      handle = null;
      if (dir && fileName) await dir.removeEntry(fileName).catch(() => undefined);
      return;
  }
}
