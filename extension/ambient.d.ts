declare module "proper-lockfile" {
  export interface LockOptions {
    realpath?: boolean;
    stale?: number;
    retries?: number;
    onCompromised?: (error: Error) => void;
  }
  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
}

declare module "unzipper" {
  export interface File {
    type: string;
    path: string;
    compressionMethod: number;
    uncompressedSize: number;
    stream(): import("node:stream").Readable;
  }
  export function Extract(options?: { path?: string }): import("node:stream").Writable;
  export const Open: {
    file(archivePath: string): Promise<{ files: File[] }>;
  };
}
