import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { db } from "./db";
import { Server } from "socket.io";
import { appendAdminLog, incrementCoinStats } from "./admin";

const ACCEPTED_COINS = new Set([1, 5, 10, 20]);
const FRAGMENT_WINDOW_MS = 140;
const RETRY_INTERVAL_MS = 5_000;
const MAX_RETRIES = 12; // ~60 seconds of retrying

let serialConnected = false;
let serialPortPath: string | null = null;
let serialLastError: string | null = null;

export function getSerialStatus() {
  return {
    connected: serialConnected,
    portPath: serialPortPath,
    lastError: serialLastError,
  };
}

export async function initSerial(io: Server) {
  console.log("[SERIAL] ── Initializing serial connection ──────────────");
  await attemptSerialConnection(io, 0);
}

async function attemptSerialConnection(io: Server, attempt: number) {
  try {
    const ports = await SerialPort.list();

    if (attempt === 0) {
      console.log(`[SERIAL] Found ${ports.length} serial port(s):`);
      for (const p of ports) {
        console.log(
          `[SERIAL]   → ${p.path} (manufacturer: ${p.manufacturer ?? "unknown"}, vendorId: ${p.vendorId ?? "unknown"}, productId: ${p.productId ?? "unknown"}, serialNumber: ${p.serialNumber ?? "unknown"})`,
        );
      }
    }

    if (!ports.length) {
      serialConnected = false;
      serialPortPath = null;
      serialLastError = "No serial ports found.";
      console.warn(
        "[SERIAL] ✗ No serial ports found. Continuing without serial connection.",
      );
      return;
    }

    const portPath = ports[0].path;
    serialPortPath = portPath;
    console.log(`[SERIAL] Selected port: ${portPath} (baud: 9600)${attempt > 0 ? ` — retry #${attempt}` : ""}`);

    await new Promise<void>((resolve, reject) => {
      const port = new SerialPort({
        path: portPath,
        baudRate: 9600,
      }, (err) => {
        if (err) return reject(err);
      });

      const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

      port.on("open", () => {
        console.log(`[SERIAL] ✓ Port opened — Arduino connected on ${portPath}`);
        serialConnected = true;
        serialLastError = null;
        io.emit("serialStatus", getSerialStatus());
        resolve();
      });

      port.on("close", () => {
        console.log("[SERIAL] ✗ Port closed — Arduino disconnected");
        serialConnected = false;
        io.emit("serialStatus", getSerialStatus());
      });

      port.on("error", (error) => {
        serialConnected = false;
        serialLastError = error.message;
        io.emit("serialStatus", getSerialStatus());
        console.error("[SERIAL] ✗ Port error:", error.message);
      });

      let pendingPrefix: "1" | "2" | null = null;
      let pendingTimer: NodeJS.Timeout | null = null;

      const clearPending = () => {
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingPrefix = null;
        pendingTimer = null;
      };

      const persistBalance = async (coinValue: number) => {
        db.data!.balance += coinValue;
        await incrementCoinStats(coinValue);
        await appendAdminLog("coin_accepted", `Accepted coin: ${coinValue}`, {
          coinValue,
          balance: db.data!.balance,
        });
        console.log(`[SERIAL] ✓ Coin accepted: ₱${coinValue} → new balance: ₱${db.data!.balance}`);
        io.emit("balance", db.data!.balance);
        io.emit("coinAccepted", { value: coinValue, balance: db.data!.balance });
      };

      const flushPending = async (reason: "timeout" | "interrupted") => {
        if (!pendingPrefix) return;
        const prefix = pendingPrefix;
        console.log(`[SERIAL] Flushing pending "${prefix}" (reason: ${reason})`);
        clearPending();

        if (prefix === "1") {
          await persistBalance(1);
          return;
        }

        io.emit("coinParserWarning", {
          code: "INVALID_FRAGMENT",
          message: `Ignored fragment '${prefix}' (${reason}).`,
        });
        void appendAdminLog(
          "coin_parser_warning",
          `Ignored fragment '${prefix}' (${reason}).`,
          { reason },
        );
      };

      const armPending = (prefix: "1" | "2") => {
        console.log(`[SERIAL] Pending fragment: "${prefix}" (waiting ${FRAGMENT_WINDOW_MS}ms)`);
        clearPending();
        pendingPrefix = prefix;
        pendingTimer = setTimeout(() => {
          void flushPending("timeout");
        }, FRAGMENT_WINDOW_MS);
      };

      const processToken = async (token: string) => {
        console.log(`[SERIAL] Token: "${token}"`);
        if (pendingPrefix) {
          if (token === "0") {
            const combined = Number(`${pendingPrefix}${token}`);
            clearPending();
            if (ACCEPTED_COINS.has(combined)) {
              await persistBalance(combined);
            } else {
              io.emit("coinParserWarning", {
                code: "INVALID_COMBINATION",
                message: `Ignored invalid coin '${combined}'.`,
              });
              void appendAdminLog(
                "coin_parser_warning",
                `Ignored invalid coin '${combined}'.`,
                { combined },
              );
            }
            return;
          }

          await flushPending("interrupted");
        }

        if (token === "1" || token === "2") {
          armPending(token);
          return;
        }

        const value = Number(token);
        if (!Number.isInteger(value)) {
          io.emit("coinParserWarning", {
            code: "NON_NUMERIC",
            message: `Ignored serial token '${token}'.`,
          });
          void appendAdminLog(
            "coin_parser_warning",
            `Ignored non-numeric serial token '${token}'.`,
            { token },
          );
          return;
        }

        if (!ACCEPTED_COINS.has(value)) {
          io.emit("coinParserWarning", {
            code: "UNSUPPORTED_COIN",
            message: `Ignored unsupported coin '${value}'.`,
          });
          void appendAdminLog(
            "coin_parser_warning",
            `Ignored unsupported coin '${value}'.`,
            { value },
          );
          return;
        }

        await persistBalance(value);
      };

      parser.on("data", (rawLine: string) => {
        console.log(`[SERIAL] Raw data: "${rawLine}"`);
        const token = rawLine.trim().replace(/[^0-9]/g, "");
        if (!token) return;
        void processToken(token);
      });
    });

    console.log(`[SERIAL] ✓ Serial port initialized on ${portPath}`);
    void appendAdminLog("serial_connected", `Serial port initialized on ${portPath}`, {
      portPath,
    });
  } catch (error) {
    serialConnected = false;
    serialLastError = error instanceof Error ? error.message : "Unknown serial error.";

    const isAccessDenied = serialLastError.toLowerCase().includes("access denied");

    if (isAccessDenied && attempt < MAX_RETRIES) {
      console.warn(
        `[SERIAL] ⚠ Port access denied — retrying in ${RETRY_INTERVAL_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES}). Close Arduino IDE Serial Monitor if open.`,
      );
      setTimeout(() => void attemptSerialConnection(io, attempt + 1), RETRY_INTERVAL_MS);
      return;
    }

    console.error(
      "[SERIAL] ✗ Init error:",
      serialLastError,
    );
    if (isAccessDenied) {
      console.error("[SERIAL] ✗ Gave up after retries. Close Arduino IDE Serial Monitor or any app using the port, then restart the server.");
    }
    void appendAdminLog(
      "serial_init_error",
      "Error initializing serial port. Continuing without serial connection.",
      { message: serialLastError },
    );
  }
}
