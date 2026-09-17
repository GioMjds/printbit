For your **PrintBit kiosk**, I would use a **wired USB-C connection between the Windows 10 tablet and the ESP32 for the primary hardware-control path**.

Keep the ESP32 Wi-Fi network available for customer/admin access where useful, but I would **not make Wi-Fi the critical link for the coin acceptor and hopper** during an all-day unattended operation.

### Recommended architecture

```text
                    ┌─────────────────────────┐
                    │     Windows 10 Tablet   │
                    │                         │
                    │  Node.js + Express      │
                    │       │                 │
                    │       │ localhost       │
                    │       ▼                 │
                    │  C# Hardware Worker     │
                    │       │                 │
                    └───────┼─────────────────┘
                            │
                    USB-C / USB Serial
                            │
                            ▼
                    ┌─────────────────┐
                    │      ESP32       │
                    │                 │
                    │ Coin Acceptor   │
                    │ Hopper          │
                    │ Sensors         │
                    └─────────────────┘

        Wi-Fi AP / PrintBit SSID
                 │
       ┌─────────┴─────────┐
       ▼                   ▼
   Admin Phone        Other devices
```

The important part is:

**Tablet ↔ USB ↔ ESP32**

instead of:

**Tablet ↔ Wi-Fi ↔ ESP32**

for critical hardware commands.

### Why USB is better for your kiosk

| Factor                     | ESP32 Wi-Fi               | USB-C / USB Serial             |
| -------------------------- | ------------------------- | ------------------------------ |
| Connection stability       | Can disconnect            | Very stable                    |
| RF interference            | Possible                  | None                           |
| IP configuration           | Required                  | Not required                   |
| ESP32 AP availability      | Must remain operational   | Irrelevant to hardware control |
| Latency                    | Usually low, but variable | Very low and predictable       |
| Hardware control           | Good                      | **Better**                     |
| Recovery after Wi-Fi issue | More complicated          | Simple COM-port reconnect      |
| Long unattended operation  | Acceptable                | **Preferred**                  |
| Debugging                  | Network/IP dependent      | Easy COM-port logs             |
| Security exposure          | Network surface           | Local physical connection      |

For your particular setup, this is especially useful because the ESP32 controls things that directly affect a transaction:

- coin acceptor
- hopper
- hardware sensors
- possibly transaction state/events

You do not want a customer reaching `/confirm`, inserting coins, and then having the tablet temporarily lose the ESP32 because the Wi-Fi link dropped.

### The biggest advantage for PrintBit

Your C# Worker can treat the ESP32 as a **local hardware device**, rather than as another network service.

For example:

```text
C# Worker
   │
   ├── Open COM port
   │
   ├── ENABLE_COINS
   │
   ├── COIN_INSERTED: 5
   │
   ├── COIN_INSERTED: 10
   │
   ├── DISPENSE: 15
   │
   └── DISABLE_COINS
```

This fits your existing worker architecture very well.

You can even have the worker automatically attempt to reconnect if the USB serial device disappears.

### What I would do with Wi-Fi

I would **not eliminate Wi-Fi entirely**.

Instead, give it a different responsibility.

**USB: critical machine control**

- coin acceptor
- hopper
- ESP32 commands
- sensor events
- heartbeat
- machine state

**Wi-Fi: user/admin networking**

- admin phone
- `/admin`
- status dashboard
- configuration
- customer-side connectivity
- potentially file transfer or QR-based workflows

That gives you two independent paths.

If Wi-Fi dies:

```text
Customer/admin networking affected
        ↓
Hardware still connected through USB
        ↓
C# Worker can still monitor/control ESP32
```

That is much safer than making Wi-Fi the only connection.

### One important issue: USB-C is not automatically ideal

The connector being USB-C is not the important part. What matters is that the ESP32 exposes a **reliable USB serial interface** to Windows.

Windows should see something like:

```text
USB Serial Device (COM5)
```

or a board-specific COM port.

Your C# Worker can then discover/open that port.

I would also avoid depending forever on a hardcoded:

```json
{
  "Port": "COM5"
}
```

because Windows can assign another COM number after hardware changes.

A better approach is something like:

```text
Find candidate serial devices
        ↓
Identify PrintBit ESP32
        ↓
Open the matching COM port
        ↓
Start heartbeat
```

You can identify the board through USB VID/PID, device description, or a startup handshake.

### Physical kiosk consideration

For your actual deployment, I would also make the USB connection physically secure.

Do not simply leave:

```text
ESP32 ─── loose USB-C cable ─── Tablet
```

inside the kiosk.

Use:

```text
ESP32
  │
  └── secured USB cable
          │
          ├── strain relief
          └── tablet USB port
```

The cable should not be able to get pulled out when the kiosk door is opened or when someone handles the tablet.

### One caveat for your tablet

Your Windows 10 tablet already has the **Epson L5290 connected by USB**, so check how many usable USB ports you actually have.

If the tablet has only one suitable USB port, you may need a **powered USB hub/dock** so you can keep:

```text
Tablet
 ├── Epson L5290
 └── ESP32
```

while still allowing the tablet to charge.

For a kiosk that runs **8-10 hours continuously**, power management and physical cable reliability matter as much as the communication protocol.

### My recommendation for PrintBit

I would use this architecture:

```text
                    PRINTBIT KIOSK

                Windows 10 Tablet
                       │
        ┌──────────────┼──────────────┐
        │              │              │
      USB           USB/other       Wi-Fi
        │              │              │
        ▼              ▼              ▼
      ESP32          Epson       Admin/Users
        │             L5290
        │
   Coin Acceptor
      Hopper
     Sensors
```

**For critical hardware communication: USB.**

**For network/user/admin communication: Wi-Fi.**

That is a more appropriate design for a **long-running self-service kiosk**, especially since PrintBit is intended to operate for an entire school day without someone constantly checking whether the ESP32 is still reachable.

I would also make the C# Worker **USB-first with automatic reconnect + heartbeat + explicit `ENABLE_COINS`/`DISABLE_COINS` states**, rather than simply replacing your current Wi-Fi implementation with raw serial commands.
