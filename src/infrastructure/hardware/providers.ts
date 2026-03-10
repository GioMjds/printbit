import { Provider } from '@nestjs/common';
import { CoinAcceptorAdapter } from './coin-acceptor.adapter';
import { HopperAdapter } from './hopper.adapter';
import { HotspotAdapter } from './hotspot.adapter';
import { PreviewAdapter } from './preview.adapter';
import { PrinterStatusAdapter } from './printer-status.adapter';
import { ScannerAdapter } from './scanner.adapter';
import { SumatraPrintAdapter } from './sumatra-print.adapter';
import { PORT_TOKENS } from './tokens';
import { UsbDriveAdapter } from './usb-drive.adapter';

export const HardwareAdapterProviders: Provider[] = [
  CoinAcceptorAdapter,
  HopperAdapter,
  HotspotAdapter,
  PreviewAdapter,
  PrinterStatusAdapter,
  ScannerAdapter,
  SumatraPrintAdapter,
  UsbDriveAdapter,
  {
    provide: PORT_TOKENS.COIN_ACCEPTOR,
    useExisting: CoinAcceptorAdapter,
  },
  {
    provide: PORT_TOKENS.HOPPER,
    useExisting: HopperAdapter,
  },
  {
    provide: PORT_TOKENS.HOTSPOT,
    useExisting: HotspotAdapter,
  },
  {
    provide: PORT_TOKENS.PREVIEW,
    useExisting: PreviewAdapter,
  },
  {
    provide: PORT_TOKENS.PRINTER_STATUS,
    useExisting: PrinterStatusAdapter,
  },
  {
    provide: PORT_TOKENS.SCANNER,
    useExisting: ScannerAdapter,
  },
  {
    provide: PORT_TOKENS.PRINTER,
    useExisting: SumatraPrintAdapter,
  },
  {
    provide: PORT_TOKENS.USB_DRIVE,
    useExisting: UsbDriveAdapter,
  },
];
