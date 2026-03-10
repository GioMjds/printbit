export interface IFileStoragePort {
  exists(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;
  listScanFiles(): Promise<string[]>;
}
