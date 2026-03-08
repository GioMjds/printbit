import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { IUsbDrivePort, UsbDrive } from '@/application/ports';

export class ListUsbDrivesQuery {}

@QueryHandler(ListUsbDrivesQuery)
export class ListUsbDrivesUseCase implements IQueryHandler<ListUsbDrivesQuery, UsbDrive[]> {
  constructor(
    @Inject('IUsbDrivePort')
    private readonly usbDrivePort: IUsbDrivePort,
  ) {}

  async execute(_query: ListUsbDrivesQuery): Promise<UsbDrive[]> {
    return this.usbDrivePort.listDrives();
  }
}
