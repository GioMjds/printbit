import net from 'node:net';
import { Readable } from 'node:stream';

const CLAMD_HOST = process.env.CLAMD_HOST ?? '127.0.0.1';
const CLAMD_PORT = parseInt(process.env.CLAMD_PORT ?? '3310', 10);
const SCAN_TIMEOUT_MS = 15_000;

export interface ScanResult {
  isClean: boolean;
  virusName: string | null;
}

function bufferToStream(buffer: Buffer): Readable {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

function buildInstreamChunks(buffer: Buffer): Buffer {
  // ClamAV INSTREAM protocol:
  // "zINSTREAM\0" → 4-byte big-endian chunk length → chunk bytes → 4 zero bytes (EOF)
  const command = Buffer.from('zINSTREAM\0');
  const lengthPrefix = Buffer.allocUnsafe(4);
  lengthPrefix.writeUInt32BE(buffer.length, 0);
  const terminator = Buffer.alloc(4, 0);
  return Buffer.concat([command, lengthPrefix, buffer, terminator]);
}

export async function scanBuffer(buffer: Buffer): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let response = '';

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('ClamAV scan timed out.'));
    }, SCAN_TIMEOUT_MS);

    socket.connect(CLAMD_PORT, CLAMD_HOST, () => {
      socket.write(buildInstreamChunks(buffer));
    });

    socket.on('data', (data) => {
      response += data.toString();
    });

    socket.on('end', () => {
      clearTimeout(timeout);
      const trimmed = response.replace(/\0/g, '').trim();

      // ClamAV responds with either:
      //   "stream: OK"
      //   "stream: Virus.Name FOUND"
      //   "stream: ... ERROR"
      if (trimmed.endsWith('OK')) {
        resolve({ isClean: true, virusName: null });
      } else if (trimmed.endsWith('FOUND')) {
        // Extract virus name: "stream: Eicar-Signature FOUND" → "Eicar-Signature"
        const match = trimmed.match(/^stream:\s+(.+)\s+FOUND$/);
        resolve({
          isClean: false,
          virusName: match ? match[1] : 'Unknown',
        });
      } else {
        reject(new Error(`Unexpected ClamAV response: ${trimmed}`));
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`ClamAV socket error: ${err.message}`));
    });
  });
}

export async function isClamdReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(3_000, () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(CLAMD_PORT, CLAMD_HOST, () => {
      socket.write('zPING\0');
    });

    socket.on('data', (data) => {
      socket.destroy();
      resolve(data.toString().replace(/\0/g, '').trim() === 'PONG');
    });

    socket.on('error', () => {
      resolve(false);
    });
  });
}
