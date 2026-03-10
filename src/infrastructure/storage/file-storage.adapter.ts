import fs from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { IFileStoragePort } from '@/application/ports';

@Injectable()
export class FileStorageAdapter implements IFileStoragePort {
  async exists(filePath: string): Promise<boolean> {
    return fs.existsSync(filePath);
  }

  async delete(filePath: string): Promise<void> {
    await fs.promises.rm(filePath, { force: true });
  }

  async listScanFiles(): Promise<string[]> {
    const scanDir = path.resolve('uploads', 'scans');
    await fs.promises.mkdir(scanDir, { recursive: true });
    const entries = await fs.promises.readdir(scanDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(scanDir, entry.name));
  }
}
