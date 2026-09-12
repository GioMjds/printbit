import type { Server, Socket } from 'socket.io';
import type { SessionStore } from '@/services/session';
import type { PowerSafetyService } from '@/services/power-safety';
import {
  canControlCoinSlot,
  canJoinSessionRoom,
  type SocketPrincipal,
} from '@/middleware/socket-access';
import {
  getCoinSlotLockOwnerId,
  getCoinSlotLockedAt,
  isCoinSlotLocked,
  lockCoinSlot,
} from '@/services/hardware-state-projection';

export interface ControlSocketDeps {
  io: Server | { emit: (event: string, ...args: unknown[]) => void };
  sessionStore: Pick<SessionStore, 'getSessionState'>;
  powerSafetyService: Pick<PowerSafetyService, 'getEffectiveEvent'>;
}

export function registerControlSocketHandlers(
  socket: Socket,
  deps: ControlSocketDeps,
): void {
  const principal = socket.data?.principal as SocketPrincipal | undefined;
  if (!principal) {
    socket.disconnect?.(true);
    return;
  }

  const locked = isCoinSlotLocked();
  const ownerId = getCoinSlotLockOwnerId();
  if (locked) {
    socket.emit('coinSlotLocked', {
      lockedAt: getCoinSlotLockedAt() ?? new Date().toISOString(),
      ownerId,
    });
  }

  socket.emit(
    'workerPowerStatusChanged',
    deps.powerSafetyService.getEffectiveEvent(),
  );

  socket.on('joinSession', (sessionId: string) => {
    if (
      !canJoinSessionRoom(principal, sessionId) ||
      deps.sessionStore.getSessionState(sessionId) !== 'active'
    ) {
      socket.emit('sessionJoinDenied', { reason: 'unauthorized_session' });
      return;
    }
    socket.join(`session:${sessionId}`);
  });

  socket.on('lockCoinSlot', () => {
    if (!canControlCoinSlot(principal)) {
      socket.emit('coinSlotLockDenied', { reason: 'unauthorized_socket' });
      return;
    }
    const currentOwnerId = getCoinSlotLockOwnerId();
    if (
      isCoinSlotLocked() &&
      currentOwnerId &&
      currentOwnerId !== socket.id &&
      currentOwnerId !== 'power-safety'
    ) {
      socket.emit('coinSlotLockDenied', {
        reason: 'lock_owned_by_another_socket',
      });
      return;
    }

    lockCoinSlot(socket.id);
    deps.io.emit('coinSlotLocked', {
      lockedAt: new Date().toISOString(),
      ownerId: socket.id,
    });
  });
}
