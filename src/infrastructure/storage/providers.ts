import { Provider } from '@nestjs/common';
import { PORT_TOKENS } from '@/infrastructure/hardware/tokens';
import { FileStorageAdapter } from './file-storage.adapter';

export const StorageAdapterProviders: Provider[] = [
  FileStorageAdapter,
  {
    provide: PORT_TOKENS.FILE_STORAGE,
    useExisting: FileStorageAdapter,
  },
];
