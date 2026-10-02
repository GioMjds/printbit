// PrintBit Minimal ESP32 Serial Firmware
// Pure USB-Serial communication: Coin Acceptor (GPIO 4), Hopper Sensor (GPIO 19), Relay (GPIO 27)
// Zero Wi-Fi, Zero HTTP, Zero dependencies.

#define coinAcceptorPin 4
#define hopperSensorPin 19
#define relayPin 27

// Coin pulse tracking
volatile uint16_t pulseCount = 0;
volatile unsigned long lastPulseMicros = 0;
volatile unsigned long lastPulseMillis = 0;
const unsigned long debounceMicros = 100000;
const unsigned long coinTimeout = 700;

// Hopper tracking
volatile int coinDispensed = 0;
volatile int targetCoins = 0;
volatile unsigned long lastCoinTime = 0;
volatile bool progressDirty = false;
const unsigned long hopperDebounce = 150000;
const unsigned long hopperMaxRunTime = 30000;

bool dispensing = false;
int lastProgressReported = -1;
unsigned long hopperStartTime = 0;
String activeRequestId = "";
String serialBuffer = "";

void IRAM_ATTR countPulse() {
  unsigned long now = micros();
  if (now - lastPulseMicros > debounceMicros) {
    pulseCount++;
    lastPulseMicros = now;
    lastPulseMillis = millis();
  }
}

void IRAM_ATTR coinDetected() {
  unsigned long now = micros();
  if (now - lastCoinTime > hopperDebounce) {
    coinDispensed++;
    progressDirty = true;
    lastCoinTime = now;
    if (dispensing && targetCoins > 0 && coinDispensed >= targetCoins) {
      digitalWrite(relayPin, LOW);
      dispensing = false;
    }
  }
}

void startDispense(int coins, const String& requestId) {
  if (dispensing) {
    Serial.print("HOPPER ERR "); Serial.print(requestId); Serial.println(" BUSY");
    return;
  }
  targetCoins = coins;
  noInterrupts();
  coinDispensed = 0;
  progressDirty = false;
  interrupts();

  dispensing = true;
  lastProgressReported = -1;
  hopperStartTime = millis();
  activeRequestId = requestId.length() > 0 ? requestId : String(millis());

  digitalWrite(relayPin, HIGH);
  Serial.print("HOPPER ACK "); Serial.println(activeRequestId);
}

void handleCommand(String line) {
  line.trim();
  if (line.length() == 0) return;

  // 1. Selftest
  if (line.startsWith("HOPPER SELFTEST") || line.startsWith("HOPPER_SELFTEST")) {
    int idx = line.lastIndexOf(' ');
    if (idx < 0) idx = line.lastIndexOf(':');
    String reqId = idx > 0 ? line.substring(idx + 1) : String(millis());
    reqId.trim();
    Serial.print("HOPPER ACK "); Serial.println(reqId);
    Serial.print("HOPPER DONE "); Serial.print(reqId); Serial.println(" 0");
    return;
  }

  // 2. Status probe
  if (line == "HOPPER STATUS" || line == "HOPPER_STATUS") {
    Serial.print("HOPPER STATUS ");
    Serial.print(dispensing ? "dispensing " : "idle ");
    Serial.print(coinDispensed);
    Serial.print(" ");
    Serial.println(targetCoins);
    return;
  }

  // 3. Dispense command format A: "HOPPER DISPENSE <reqId> <coins>" or "HOPPER DISPENSE <coins>"
  if (line.startsWith("HOPPER DISPENSE")) {
    int s1 = line.indexOf(' ');
    int s2 = line.indexOf(' ', s1 + 1);
    int s3 = line.indexOf(' ', s2 + 1);

    String reqId = s3 > 0 ? line.substring(s2 + 1, s3) : String(millis());
    String coinsRaw = s3 > 0 ? line.substring(s3 + 1) : line.substring(s2 + 1);
    reqId.trim();
    coinsRaw.trim();

    int coins = coinsRaw.toInt();
    if (coins <= 0 || coins > 50) {
      Serial.print("HOPPER ERR "); Serial.print(reqId); Serial.println(" INVALID_COIN_COUNT");
      return;
    }
    startDispense(coins, reqId);
    return;
  }

  // 4. Dispense command format B: "HOPPER_DISPENSE:<count>[:<reqId>]"
  if (line.startsWith("HOPPER_DISPENSE:")) {
    int firstColon = line.indexOf(':');
    int secondColon = line.indexOf(':', firstColon + 1);
    String coinsRaw = secondColon > 0 ? line.substring(firstColon + 1, secondColon) : line.substring(firstColon + 1);
    String reqId = secondColon > 0 ? line.substring(secondColon + 1) : String(millis());
    coinsRaw.trim();
    reqId.trim();

    int coins = coinsRaw.toInt();
    if (coins <= 0 || coins > 50) {
      Serial.print("HOPPER ERR "); Serial.print(reqId); Serial.println(" INVALID_COIN_COUNT");
      return;
    }
    startDispense(coins, reqId);
    return;
  }

  // 5. Legacy numeric command fallback (e.g. sending "5" dispenses 5 coins)
  int num = line.toInt();
  if (num > 0 && num <= 50) {
    startDispense(num, String(millis()));
    return;
  }

  Serial.print("ERR_UNKNOWN_CMD:"); Serial.println(line);
}

void setup() {
  pinMode(coinAcceptorPin, INPUT_PULLUP);
  pinMode(hopperSensorPin, INPUT);
  pinMode(relayPin, OUTPUT);
  digitalWrite(relayPin, LOW);

  Serial.begin(115200);

  attachInterrupt(coinAcceptorPin, countPulse, FALLING);
  attachInterrupt(hopperSensorPin, coinDetected, FALLING);

  Serial.println("PRINTBIT_SERIAL_READY");
}

void loop() {
  // 1. Process coin pulses from physical coin acceptor
  uint16_t count;
  unsigned long lastPulse;
  noInterrupts();
  count = pulseCount;
  lastPulse = lastPulseMillis;
  interrupts();

  if (count > 0 && millis() - lastPulse > coinTimeout) {
    int val = 0;
    if (count == 1) val = 1;
    else if (count == 3) val = 5;
    else if (count == 5) val = 10;
    else if (count == 7) val = 20;

    if (val > 0) {
      Serial.print("coin_pulse:"); Serial.println(val);
    } else {
      Serial.print("coin_pulse_error:unrecognized:"); Serial.println(count);
    }

    noInterrupts();
    pulseCount = 0;
    interrupts();
  }

  // 2. Read Serial commands from PC (C# Worker / Node)
  while (Serial.available()) {
    char c = char(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      handleCommand(serialBuffer);
      serialBuffer = "";
    } else if (serialBuffer.length() < 100) {
      serialBuffer += c;
    }
  }

  // 3. Emit real-time dispensing progress
  int currentDispensed = 0;
  bool dirty = false;
  noInterrupts();
  currentDispensed = coinDispensed;
  dirty = progressDirty;
  progressDirty = false;
  interrupts();

  if (dispensing && dirty && currentDispensed != lastProgressReported) {
    lastProgressReported = currentDispensed;
    Serial.print("HOPPER PROGRESS ");
    Serial.print(activeRequestId);
    Serial.print(" ");
    Serial.print(currentDispensed);
    Serial.print(" ");
    Serial.println(targetCoins);
  }

  // 4. Hopper Safety & Completion Checks
  if (dispensing) {
    if (millis() - hopperStartTime > hopperMaxRunTime) {
      digitalWrite(relayPin, LOW);
      dispensing = false;
      Serial.print("HOPPER ERR "); Serial.print(activeRequestId); Serial.println(" MOTOR_TIMEOUT timeout");
    } else if (targetCoins > 0 && currentDispensed >= targetCoins) {
      digitalWrite(relayPin, LOW);
      dispensing = false;
      Serial.print("HOPPER DONE "); Serial.print(activeRequestId); Serial.print(" "); Serial.println(currentDispensed);
    }
  }
}
