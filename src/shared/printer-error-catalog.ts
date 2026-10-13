export type PrinterErrorCode =
  | 'E_NO_PAPER'
  | 'E_COVER_OPEN'
  | 'E_OUTPUT_TRAY'
  | 'E_PAPER_SETUP'
  | 'E_INK_OUT'
  | 'E_OFFLINE'
  | 'E_SERVICE'
  | 'E_UNKNOWN'
  | 'E_STALL'
  | 'W_INK_LOW';

export type PrinterErrorTier = 'Customer' | 'Staff' | 'Technician' | 'None';

export interface LocalizedMessage {
  en: string;
  fil: string;
}

export interface PrinterErrorDefinition {
  code: PrinterErrorCode;
  tier: PrinterErrorTier;
  triggerRule: string;
  autoClear: boolean;
  locksCoinSlot: boolean;
  lookAtPrinterScreen: boolean;
  title: LocalizedMessage;
  what: LocalizedMessage;
  action: LocalizedMessage;
}

export const PRINTER_ERROR_CATALOG: Record<PrinterErrorCode, PrinterErrorDefinition> = {
  E_NO_PAPER: {
    code: 'E_NO_PAPER',
    tier: 'Staff',
    triggerRule: 'out_of_paper|detectederrorstate_4',
    autoClear: false,
    locksCoinSlot: true,
    lookAtPrinterScreen: false,
    title: {
      en: 'Printer Needs Paper',
      fil: 'Kailangan ng Papel ang Printer',
    },
    what: {
      en: 'Printer is out of paper.',
      fil: 'Naubos na ang papel ng printer.',
    },
    action: {
      en: 'Please call staff to load paper.',
      fil: 'Pakitawag ang staff para maglagay ng papel.',
    },
  },
  E_COVER_OPEN: {
    code: 'E_COVER_OPEN',
    tier: 'Customer',
    triggerRule: 'cover_open|door_open|detectederrorstate_7',
    autoClear: true,
    locksCoinSlot: true,
    lookAtPrinterScreen: true,
    title: {
      en: 'Printer Cover Open',
      fil: 'Bukas ang Takip ng Printer',
    },
    what: {
      en: 'The printer cover is open.',
      fil: 'Bukas ang takip ng printer.',
    },
    action: {
      en: 'Please close the cover, then press OK on the printer screen if prompted.',
      fil: 'Pakisara ang takip, tapos pindutin ang OK sa screen ng printer kung may senyas.',
    },
  },
  E_OUTPUT_TRAY: {
    code: 'E_OUTPUT_TRAY',
    tier: 'Customer',
    triggerRule: 'output_bin_full|tray_closed|detectederrorstate_11',
    autoClear: true,
    locksCoinSlot: true,
    lookAtPrinterScreen: true,
    title: {
      en: 'Check Output Tray',
      fil: 'Tingnan ang Labasan ng Papel',
    },
    what: {
      en: 'The output tray is closed or full.',
      fil: 'Nakasara o puno ang labasan ng papel.',
    },
    action: {
      en: 'Open or clear the tray, then press OK on the printer screen if prompted.',
      fil: 'Buksan o alisin ang papel sa labasan, tapos pindutin ang OK kung may senyas.',
    },
  },
  E_PAPER_SETUP: {
    code: 'E_PAPER_SETUP',
    tier: 'Staff',
    triggerRule: 'paper_setup_prompt|size_mismatch',
    autoClear: false,
    locksCoinSlot: true,
    lookAtPrinterScreen: true,
    title: {
      en: 'Paper Setup Required',
      fil: 'Kailangan ng Pag-aayos ng Papel',
    },
    what: {
      en: 'Printer is asking for paper size or type confirmation.',
      fil: 'Nanghihingi ang printer ng kumpirmasyon sa sukat o uri ng papel.',
    },
    action: {
      en: 'Please call staff to verify paper settings on the printer.',
      fil: 'Pakitawag ang staff para suriin ang settings ng papel sa printer.',
    },
  },
  E_INK_OUT: {
    code: 'E_INK_OUT',
    tier: 'Staff',
    triggerRule: 'ink_out|toner_out|detectederrorstate_5|detectederrorstate_6',
    autoClear: false,
    locksCoinSlot: true,
    lookAtPrinterScreen: false,
    title: {
      en: 'Ink Tank Empty',
      fil: 'Ubos na ang Tinta ng Printer',
    },
    what: {
      en: 'The printer ink tank is empty or needs attention.',
      fil: 'Ubos na ang tinta o may problema sa tangke ng printer.',
    },
    action: {
      en: 'Please call staff to refill the ink.',
      fil: 'Pakitawag ang staff para kargahan ng tinta.',
    },
  },
  E_OFFLINE: {
    code: 'E_OFFLINE',
    tier: 'Staff',
    triggerRule: 'printer_offline|disconnected|detectederrorstate_9',
    autoClear: false,
    locksCoinSlot: true,
    lookAtPrinterScreen: false,
    title: {
      en: 'Printer Offline',
      fil: 'Offline ang Printer',
    },
    what: {
      en: 'The printer is offline or disconnected.',
      fil: 'Offline o hindi nakakabit ang printer.',
    },
    action: {
      en: 'Please call staff to check printer power and cables.',
      fil: 'Pakitawag ang staff para suriin ang kuryente at kable ng printer.',
    },
  },
  E_SERVICE: {
    code: 'E_SERVICE',
    tier: 'Technician',
    triggerRule: 'service_required|ink_pad_full|fatal_hardware_error',
    autoClear: false,
    locksCoinSlot: true,
    lookAtPrinterScreen: true,
    title: {
      en: 'Printer Service Required',
      fil: 'Kailangan ng Serbisyong Teknikal',
    },
    what: {
      en: 'The printer reported a service error or maintenance box is full.',
      fil: 'May ulat na sira o puno ang waste ink pad ng printer.',
    },
    action: {
      en: 'Please call staff for technical assistance.',
      fil: 'Pakitawag ang staff para sa tulong ng technician.',
    },
  },
  E_UNKNOWN: {
    code: 'E_UNKNOWN',
    tier: 'Staff',
    triggerRule: 'unmapped_hardware_error',
    autoClear: false,
    locksCoinSlot: true,
    lookAtPrinterScreen: true,
    title: {
      en: 'Printer Attention Needed',
      fil: 'Kailangan ng Pansin ang Printer',
    },
    what: {
      en: 'The printer encountered an unrecognized condition.',
      fil: 'May hindi pangkaraniwang kondisyon ang printer.',
    },
    action: {
      en: 'Look at the printer screen and call staff.',
      fil: 'Tingnan ang screen ng printer at tawagin ang staff.',
    },
  },
  E_STALL: {
    code: 'E_STALL',
    tier: 'Staff',
    triggerRule: 'job_watchdog_timeout',
    autoClear: false,
    locksCoinSlot: true,
    lookAtPrinterScreen: true,
    title: {
      en: 'Printing Incomplete',
      fil: 'Hindi Natapos ang Pag-print',
    },
    what: {
      en: 'Printing stalled without progress.',
      fil: 'Huminto ang proseso ng pag-print.',
    },
    action: {
      en: 'Look at the printer screen and call staff.',
      fil: 'Tingnan ang screen ng printer at tawagin ang staff.',
    },
  },
  W_INK_LOW: {
    code: 'W_INK_LOW',
    tier: 'None',
    triggerRule: 'ink_low_warning',
    autoClear: true,
    locksCoinSlot: false,
    lookAtPrinterScreen: false,
    title: {
      en: 'Ink Low Warning',
      fil: 'Babala: Mababa ang Tinta',
    },
    what: {
      en: 'Printer ink is running low.',
      fil: 'Pausad nang maubos ang tinta ng printer.',
    },
    action: {
      en: 'Admin warning only.',
      fil: 'Babala lamang para sa admin.',
    },
  },
};

export function getPrinterErrorDefinition(code: string): PrinterErrorDefinition {
  if (code in PRINTER_ERROR_CATALOG) {
    return PRINTER_ERROR_CATALOG[code as PrinterErrorCode];
  }
  return PRINTER_ERROR_CATALOG.E_UNKNOWN;
}
