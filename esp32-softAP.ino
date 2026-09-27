#include <WiFi.h>
#include <NetworkClient.h>
#include <WiFiAP.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <esp_wifi.h>
#include <esp_netif.h>
#include <esp_system.h>
#include <ESPmDNS.h>
#include <time.h>
#include <sys/time.h>

#define coinAcceptorPin 4
#define hopperSensorPin 22
#define relayPin 27
#define bootButtonPin 0

const char* defaultApSsid = "PrintBit";
const char* defaultApPassword = "";
const char* defaultAdminUsername = "admin";
const char* defaultAdminPassword = "printbitadmin";
const unsigned long credentialRecoveryWindowMs = 15000;

Preferences preferences;
String apSsid = "";
String apPassword = "";
bool apPasswordEnabled = false;
String adminUsername = "";
String adminPassword = "";
String adminSessionToken = "";
String protectedAdminMac = "";
const IPAddress apIp(192, 168, 4, 1);

const char* fallbackKioskIp = "192.168.4.2";
const uint16_t fallbackKioskPort = 3000;
const char* fallbackKioskPortalPath = "/portal";
const char* kioskRegisterToken = "printbit-register-token";
const char* coinBridgeSource = "esp32";
const char* coinBridgeApiKey = "printbit-coin-bridge-key";
const char* hopperControlToken = "printbit-coin-bridge-key";

NetworkServer server(80);

String kioskIp = fallbackKioskIp;
uint16_t kioskPort = fallbackKioskPort;
String kioskPortalPath = fallbackKioskPortalPath;
String kioskPortalUrl = "";
String tabletServer = "";
String kioskMac = "";
bool hasKioskRegistration = false;

// COIN ACCEPTOR
volatile uint16_t pulseCount = 0;
volatile unsigned long lastPulseMicros = 0;
volatile unsigned long lastPulseMillis = 0;
volatile uint16_t glitchPulseCount = 0;

const unsigned long debounceMicros = 100000;
const unsigned long coinTimeout = 730;
const int maxCoinSendAttempts = 3;
const int maxDispenseCoins = 50;
const uint16_t pulseCountCap = 200;
const uint16_t pulseSaturationWarnAt = 8;

// HOPPER
volatile int coinDispensed = 0;
volatile int targetCoins = 0;

volatile unsigned long lastCoinTime = 0;
const unsigned long hopperDebounce = 620000;

bool dispensing = false;
bool hopperManualOn = false;
bool dispenseAllMode = false;
bool dispenseDone = false;
bool dispenseTimedOut = false;
volatile bool dispenseProgressDirty = false;
int lastProgressReported = -1;

// SAFETY
unsigned long hopperStartTime = 0;
const unsigned long hopperMaxRunTime = 30000;

unsigned long coinEventCounter = 0;
String activeDispenseRequestId = "";
String lastDispenseRequestId = "";
String lastDispenseOutcome = "idle";
String lastDispenseError = "";
unsigned long lastDispenseFinishedAt = 0;
String serialLineBuffer = "";

// HEAP MONITORING
const unsigned long heapCheckIntervalMs = 10000;
const uint32_t lowHeapWarnThreshold = 20000;
unsigned long lastHeapCheckAt = 0;
uint32_t minFreeHeapSeen = UINT32_MAX;

// ADMIN DIAGNOSTICS / MAINTENANCE
bool coinTestMode = false;
unsigned long coinTestStartedAt = 0;
unsigned long lastCoinDetectedAt = 0;
int lastCoinValue = 0;
uint16_t lastCoinPulseCount = 0;
uint16_t lastCoinPulseGlitchCount = 0;
unsigned long lastCoinPulseDurationMs = 0;
unsigned long coinAcceptedCount = 0;
unsigned long coinInvalidCount = 0;
unsigned long coinTestCount = 0;
String lastSystemError = "";
String lastAdminAction = "";

// ADMIN CLOCK
bool adminClockSynced = false;

// DEVICE ACCESS CONTROL
bool blockOtherDevices = false;
unsigned long blockOtherDevicesUntil = 0;
const int maxAdminLogEntries = 30;
String adminEventLog[maxAdminLogEntries];
int adminEventLogCount = 0;
const int maxAdminErrorEntries = 20;
String adminErrorLog[maxAdminErrorEntries];
int adminErrorLogCount = 0;

String adminTimestamp() {
  time_t now = time(nullptr);
  if (adminClockSynced && now > 1000000000) {
    struct tm localTm;
    localtime_r(&now, &localTm);
    char buffer[24];
    strftime(buffer, sizeof(buffer), "%Y-%m-%d %H:%M:%S", &localTm);
    return String(buffer);
  }

  unsigned long total = millis() / 1000UL;
  unsigned long h = total / 3600UL;
  unsigned long m = (total % 3600UL) / 60UL;
  unsigned long sec = total % 60UL;
  char buffer[24];
  snprintf(buffer, sizeof(buffer), "BOOT+%02lu:%02lu:%02lu", h, m, sec);
  return String(buffer);
}

void addAdminEvent(const String& message);

void addAdminError(const String& message) {
  lastSystemError = message;
  String entry = adminTimestamp() + " | ERROR | " + message;
  if (adminErrorLogCount < maxAdminErrorEntries) {
    adminErrorLog[adminErrorLogCount++] = entry;
  } else {
    for (int i = 1; i < maxAdminErrorEntries; i++) adminErrorLog[i - 1] = adminErrorLog[i];
    adminErrorLog[maxAdminErrorEntries - 1] = entry;
  }
  addAdminEvent(String("ERROR: ") + message);
}

void addAdminEvent(const String& message) {
  String entry = adminTimestamp() + " | INFO | " + message;
  if (adminEventLogCount < maxAdminLogEntries) {
    adminEventLog[adminEventLogCount++] = entry;
  } else {
    for (int i = 1; i < maxAdminLogEntries; i++) adminEventLog[i - 1] = adminEventLog[i];
    adminEventLog[maxAdminLogEntries - 1] = entry;
  }
  Serial.print("admin_event:");
  Serial.println(message);
}

bool startDispense(
  int coins,
  const String& requestId,
  const String& sourceLabel);
void handleAdminWifiSave(NetworkClient& client, const String& body);
void handleAdminCredentials(NetworkClient& client, const String& body);
void handleAdminDisconnectDevice(NetworkClient& client, const String& body);
void handleAdminDisconnectAllDevices(NetworkClient& client);
String stationMacToString(const uint8_t* mac);
bool getStationMacByIp(const IPAddress& ip, String& macText);
bool getStationIpByMac(const uint8_t* mac, IPAddress& stationIp);

void handleAdminHopperDispense(NetworkClient& client, const String& body);
void handleAdminHopperDispenseAll(NetworkClient& client);
void handleAdminHopperOn(NetworkClient& client);
void handleAdminHopperStop(NetworkClient& client);
void replyPlain(NetworkClient& client, int statusCode, const String& statusText, const String& message);
bool saveApCredentials(const String& newSsid, const String& newPassword, bool passwordEnabled);
void loadApCredentials();
void handleAdminCoinTestStart(NetworkClient& client);
void handleAdminCoinTestStop(NetworkClient& client);
void handleAdminExportConfig(NetworkClient& client);
void handleAdminDeviceAccess(NetworkClient& client, const String& body);
void handleAdminTimeSync(NetworkClient& client, const String& body);

String decodeUrlComponent(const String& value) {
  String decoded = "";
  for (size_t i = 0; i < value.length(); i++) {
    char c = value.charAt(i);
    if (c == '+') {
      decoded += ' ';
      continue;
    }
    if (c == '%' && i + 2 < value.length()) {
      auto hexToInt = [](char h) -> int {
        if (h >= '0' && h <= '9') return h - '0';
        if (h >= 'A' && h <= 'F') return h - 'A' + 10;
        if (h >= 'a' && h <= 'f') return h - 'a' + 10;
        return -1;
      };
      int hi = hexToInt(value.charAt(i + 1));
      int lo = hexToInt(value.charAt(i + 2));
      if (hi >= 0 && lo >= 0) {
        decoded += char((hi << 4) | lo);
        i += 2;
        continue;
      }
    }
    decoded += c;
  }
  return decoded;
}

String getFormValue(const String& body, const String& key) {
  String needle = key + "=";
  int start = body.indexOf(needle);
  if (start < 0) return "";
  start += needle.length();
  int end = body.indexOf('&', start);
  if (end < 0) end = body.length();
  return decodeUrlComponent(body.substring(start, end));
}

String htmlEscape(const String& value) {
  String escaped = "";
  escaped.reserve(value.length() + 16);
  for (size_t i = 0; i < value.length(); i++) {
    char c = value.charAt(i);
    if (c == '&') escaped += "&amp;";
    else if (c == '<') escaped += "&lt;";
    else if (c == '>') escaped += "&gt;";
    else if (c == '"') escaped += "&quot;";
    else if (c == '\'') escaped += "&#39;";
    else escaped += c;
  }
  return escaped;
}

void resetApCredentials() {
  preferences.begin("printbit", false);
  preferences.remove("ssid");
  preferences.remove("password");
  preferences.remove("passwordEnabled");
  preferences.end();
  apSsid = defaultApSsid;
  apPassword = "";
  apPasswordEnabled = false;
}

String makeAdminSessionToken() {
  return String((uint32_t)esp_random(), HEX) + String((uint32_t)esp_random(), HEX);
}

bool hasAdminAuthorization(const String& authorizationHeader) {
  const String prefix = "Bearer ";
  if (!authorizationHeader.startsWith(prefix)) return false;
  String token = authorizationHeader.substring(prefix.length());
  token.trim();
  return token.length() > 0 && token == adminSessionToken;
}

void replyAdminRedirect(NetworkClient& client, const String& location) {
  client.println("HTTP/1.1 302 Found");
  client.print("Location: ");
  client.println(location);
  client.println("Cache-Control: no-store");
  client.println("Content-Length: 0");
  client.println("Connection: close");
  client.println();
}

void replyAdminHtml(NetworkClient& client, const String& html, const String& extraHeaders = "") {
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: text/html; charset=utf-8");
  client.println("Cache-Control: no-store");
  if (extraHeaders.length() > 0) client.print(extraHeaders);
  client.print("Content-Length: ");
  client.println(html.length());
  client.println("Connection: close");
  client.println();
  client.print(html);
}

void replyAdminUnauthorized(NetworkClient& client) {
  client.println("HTTP/1.1 401 Unauthorized");
  client.println("Content-Type: text/plain; charset=utf-8");
  client.println("Cache-Control: no-store");
  client.println("Content-Length: 20");
  client.println("Connection: close");
  client.println();
  client.print("Admin login required");
}

void replyAdminJson(NetworkClient& client, const String& json, int statusCode = 200, const String& statusText = "OK") {
  client.print("HTTP/1.1 ");
  client.print(statusCode);
  client.print(" ");
  client.println(statusText);
  client.println("Content-Type: application/json; charset=utf-8");
  client.println("Cache-Control: no-store");
  client.print("Content-Length: ");
  client.println(json.length());
  client.println("Connection: close");
  client.println();
  client.print(json);
}

void loadAdminCredentials() {
  preferences.begin("printbit", true);
  adminUsername = preferences.getString("admin_user", defaultAdminUsername);
  adminPassword = preferences.getString("admin_pass", defaultAdminPassword);
  preferences.end();

  if (adminUsername.length() == 0 || adminUsername.length() > 32) {
    adminUsername = defaultAdminUsername;
  }
  if (adminPassword.length() < 8 || adminPassword.length() > 63) {
    adminPassword = defaultAdminPassword;
  }
}

bool saveAdminCredentials(const String& newUsername, const String& newPassword) {
  if (newUsername.length() == 0 || newUsername.length() > 32) return false;
  if (newPassword.length() < 8 || newPassword.length() > 63) return false;

  preferences.begin("printbit", false);
  bool ok = preferences.putString("admin_user", newUsername) > 0;
  ok = preferences.putString("admin_pass", newPassword) > 0 && ok;
  preferences.end();

  if (ok) {
    adminUsername = newUsername;
    adminPassword = newPassword;
  }
  return ok;
}

void handleAdminLogin(NetworkClient& client, const String& body) {
  String username = getFormValue(body, "username");
  String password = getFormValue(body, "password");
  username.trim();
  password.trim();
  if (username != adminUsername || password != adminPassword) {
    Serial.print("admin_login_failed:invalid_credentials:username=");
    Serial.println(username.length() > 0 ? "provided" : "missing");
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Invalid username or password\"}", 401, "Unauthorized");
    return;
  }
  wifi_sta_list_t stationList;
  memset(&stationList, 0, sizeof(stationList));
  String loginAdminMac = "";
  if (esp_wifi_ap_get_sta_list(&stationList) == ESP_OK) {
    for (int i = 0; i < stationList.num; i++) {
      IPAddress stationIp;
      if (getStationIpByMac(stationList.sta[i].mac, stationIp) && stationIp == client.remoteIP()) {
        loginAdminMac = stationMacToString(stationList.sta[i].mac);
        break;
      }
    }
  }
  if (loginAdminMac.length() == 0) {
    Serial.println("admin_login_failed:device_identity_not_found");
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Could not identify this connected device\"}", 409, "Conflict");
    return;
  }

  adminSessionToken = makeAdminSessionToken();
  protectedAdminMac = loginAdminMac;
  Serial.print("admin_login_success:session_created:admin_mac=");
  Serial.println(protectedAdminMac);
  addAdminEvent(String("Admin device logged in: ") + protectedAdminMac);
  replyAdminJson(client, "{\"ok\":true,\"token\":\"" + adminSessionToken + "\"}");
}

void replyAdminLoginPage(NetworkClient& client) {
  String html = R"HTML(<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>PrintBit Admin</title><style>body{margin:0;background:#f4f6f8;font-family:Arial,sans-serif;color:#18202a}.wrap{max-width:430px;margin:70px auto;padding:20px}.card{background:#fff;border:1px solid #e0e5ea;border-radius:18px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.06)}.brand{font-size:13px;font-weight:700;letter-spacing:1.5px;color:#66717d;text-transform:uppercase}h1{margin:8px 0 6px;font-size:28px}p{color:#66717d;line-height:1.5}label{display:block;margin-top:18px;font-weight:700;font-size:14px}input{box-sizing:border-box;width:100%;padding:13px 14px;margin-top:7px;border:1px solid #cbd3db;border-radius:10px;font-size:16px}button{width:100%;border:0;border-radius:10px;padding:13px;margin-top:22px;background:#18202a;color:#fff;font-size:16px;font-weight:700;cursor:pointer}.error{display:none;margin-top:16px;padding:11px;border-radius:9px;background:#fff0f0;color:#a22b2b;font-size:14px}</style></head><body><div class="wrap"><div class="card"><div class="brand">PrintBit</div><h1>Admin Login</h1><p>Sign in to manage this kiosk locally.</p><form id="login"><label>Username</label><input id="username" autocomplete="username" required><label>Password</label><input id="password" type="password" autocomplete="current-password" required><div id="error" class="error"></div><button type="submit">Sign in</button></form></div></div><script>document.getElementById('login').addEventListener('submit',async e=>{e.preventDefault();const er=document.getElementById('error');er.style.display='none';try{const body='username='+encodeURIComponent(username.value)+'&password='+encodeURIComponent(password.value);const r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});const d=await r.json();if(!r.ok)throw Error(d.error||'Login failed');sessionStorage.setItem('printbit_admin_token',d.token);location='/admin';}catch(x){er.textContent=x.message;er.style.display='block';}});</script></body></html>)HTML";
  replyAdminHtml(client, html);
}

String stationMacToString(const uint8_t* mac) {
  char buffer[18];
  snprintf(buffer, sizeof(buffer), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buffer);
}

bool getStationIpByMac(const uint8_t* mac, IPAddress& stationIp) {
  esp_netif_t* apNetif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
  if (apNetif == nullptr) return false;

  esp_netif_pair_mac_ip_t pair;
  memset(&pair, 0, sizeof(pair));
  memcpy(pair.mac, mac, 6);

  esp_err_t result = esp_netif_dhcps_get_clients_by_mac(apNetif, 1, &pair);
  if (result != ESP_OK) {
    result = esp_netif_arp_get_client_by_mac(apNetif, &pair);
    if (result != ESP_OK) return false;
  }

  if (pair.ip.addr == 0) return false;
  stationIp = IPAddress(pair.ip.addr);
  return true;
}

bool getStationMacByIp(const IPAddress& ip, String& macText) {
  wifi_sta_list_t stationList;
  memset(&stationList, 0, sizeof(stationList));
  if (esp_wifi_ap_get_sta_list(&stationList) != ESP_OK) return false;

  for (int i = 0; i < stationList.num; i++) {
    IPAddress stationIp;
    if (getStationIpByMac(stationList.sta[i].mac, stationIp) && stationIp == ip) {
      macText = stationMacToString(stationList.sta[i].mac);
      return true;
    }
  }
  return false;
}

String buildConnectedDevicesJson() {
  wifi_sta_list_t stationList;
  memset(&stationList, 0, sizeof(stationList));

  String json = "[";
  if (esp_wifi_ap_get_sta_list(&stationList) == ESP_OK) {
    bool first = true;
    for (int i = 0; i < stationList.num; i++) {
      IPAddress stationIp;
      bool ipKnown = getStationIpByMac(stationList.sta[i].mac, stationIp);
      String currentMac = stationMacToString(stationList.sta[i].mac);
      bool isAdmin = currentMac == protectedAdminMac;

      if (!first) json += ",";
      first = false;

      json += "{\"mac\":\"" + stationMacToString(stationList.sta[i].mac) + "\",\"rssi\":" + String(stationList.sta[i].rssi) + ",\"ip\":\"";
      json += ipKnown ? stationIp.toString() : "";
      json += "\",\"isAdmin\":" + String(isAdmin ? "true" : "false") + "}";
    }
  }
  json += "]";
  return json;
}

String disconnectErrorCode = "";

// TEMPORARY DISCONNECT BLOCK
// Some phones/tablets immediately reconnect after deauthentication. Keep a
// short block window so a Disconnect action is visible and reliable.
const int maxDisconnectBlocks = 10;
String disconnectBlockedMac[maxDisconnectBlocks];
unsigned long disconnectBlockedUntil[maxDisconnectBlocks] = { 0 };

void blockStationTemporarily(const String& macText, unsigned long durationMs = 5000UL) {
  String mac = macText;
  mac.trim();
  mac.toUpperCase();
  int slot = -1;
  for (int i = 0; i < maxDisconnectBlocks; i++) {
    if (disconnectBlockedMac[i] == mac) {
      slot = i;
      break;
    }
    if (slot < 0 && disconnectBlockedMac[i].length() == 0) slot = i;
  }
  if (slot < 0) slot = 0;
  disconnectBlockedMac[slot] = mac;
  disconnectBlockedUntil[slot] = millis() + durationMs;
}

void enforceTemporaryDisconnectBlocks() {
  unsigned long now = millis();
  wifi_sta_list_t stationList;
  memset(&stationList, 0, sizeof(stationList));
  if (esp_wifi_ap_get_sta_list(&stationList) != ESP_OK) return;

  for (int b = 0; b < maxDisconnectBlocks; b++) {
    if (disconnectBlockedMac[b].length() == 0) continue;
    if ((long)(now - disconnectBlockedUntil[b]) >= 0) {
      disconnectBlockedMac[b] = "";
      disconnectBlockedUntil[b] = 0;
      continue;
    }

    for (int i = 0; i < stationList.num; i++) {
      String current = stationMacToString(stationList.sta[i].mac);
      if (current != disconnectBlockedMac[b]) continue;
      uint16_t aid = 0;
      if (esp_wifi_ap_get_sta_aid(stationList.sta[i].mac, &aid) == ESP_OK && aid != 0) {
        esp_wifi_deauth_sta(aid);
      }
    }
  }
}


void enforceDeviceAccessPolicy() {
  if (!blockOtherDevices) return;

  unsigned long now = millis();
  if (blockOtherDevicesUntil != 0 && (long)(now - blockOtherDevicesUntil) >= 0) {
    blockOtherDevices = false;
    blockOtherDevicesUntil = 0;
    addAdminEvent("Other device access block expired");
    lastAdminAction = "Other device access block expired";
    return;
  }

  if (protectedAdminMac.length() == 0) return;

  wifi_sta_list_t stationList;
  memset(&stationList, 0, sizeof(stationList));
  if (esp_wifi_ap_get_sta_list(&stationList) != ESP_OK) return;

  for (int i = 0; i < stationList.num; i++) {
    String currentMac = stationMacToString(stationList.sta[i].mac);
    if (currentMac == protectedAdminMac) continue;

    uint16_t aid = 0;
    if (esp_wifi_ap_get_sta_aid(stationList.sta[i].mac, &aid) == ESP_OK && aid != 0) {
      esp_wifi_deauth_sta(aid);
    }
  }
}


bool disconnectStationByMac(const String& macText) {
  disconnectErrorCode = "";
  String wanted = macText;
  wanted.trim();
  wanted.toUpperCase();

  if (wanted.length() != 17) {
    disconnectErrorCode = "INVALID_MAC";
    return false;
  }

  wifi_sta_list_t stationList;
  memset(&stationList, 0, sizeof(stationList));
  esp_err_t listResult = esp_wifi_ap_get_sta_list(&stationList);
  if (listResult != ESP_OK) {
    disconnectErrorCode = "STA_LIST_FAILED";
    Serial.print("admin_device_disconnect:failed:sta_list:error=");
    Serial.println((int)listResult);
    return false;
  }

  for (int i = 0; i < stationList.num; i++) {
    String current = stationMacToString(stationList.sta[i].mac);
    if (current != wanted) continue;

    uint16_t aid = 0;
    esp_err_t aidResult = esp_wifi_ap_get_sta_aid(stationList.sta[i].mac, &aid);
    if (aidResult != ESP_OK || aid == 0) {
      disconnectErrorCode = "AID_LOOKUP_FAILED";
      Serial.print("admin_device_disconnect:failed:aid_lookup:mac=");
      Serial.print(wanted);
      Serial.print(":error=");
      Serial.println((int)aidResult);
      return false;
    }

    Serial.print("admin_device_disconnect:attempt:mac=");
    Serial.print(wanted);
    Serial.print(":aid=");
    Serial.println(aid);

    esp_err_t result = esp_wifi_deauth_sta(aid);
    if (result == ESP_OK) {
      blockStationTemporarily(wanted);
      Serial.print("admin_device_disconnect:success:mac=");
      Serial.print(wanted);
      Serial.print(":aid=");
      Serial.println(aid);
      return true;
    }

    disconnectErrorCode = "DEAUTH_FAILED";
    Serial.print("admin_device_disconnect:failed:deauth:mac=");
    Serial.print(wanted);
    Serial.print(":aid=");
    Serial.print(aid);
    Serial.print(":error=");
    Serial.println((int)result);
    return false;
  }

  disconnectErrorCode = "NOT_CONNECTED";
  Serial.print("admin_device_disconnect:failed:mac_not_connected:mac=");
  Serial.println(wanted);
  return false;
}

const char* resetReasonText() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "Power on";
    case ESP_RST_EXT: return "External reset";
    case ESP_RST_SW: return "Software reset";
    case ESP_RST_PANIC: return "Panic";
    case ESP_RST_INT_WDT: return "Interrupt watchdog";
    case ESP_RST_TASK_WDT: return "Task watchdog";
    case ESP_RST_WDT: return "Other watchdog";
    case ESP_RST_DEEPSLEEP: return "Deep sleep";
    case ESP_RST_BROWNOUT: return "Brownout";
    case ESP_RST_SDIO: return "SDIO reset";
    default: return "Unknown";
  }
}

void replyAdminDashboardPage(NetworkClient& client) {
  String html = R"HTML(<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>PrintBit Admin Control Center</title><style>
:root{--bg:#f4f6f8;--card:#fff;--text:#17202a;--muted:#66717d;--line:#e3e8ed;--primary:#17202a;--soft:#eef2f5;--ok:#197a4b;--okbg:#eaf7f0;--warn:#9a6700;--warnbg:#fff7df;--danger:#b42318;--dangerbg:#fff0ee;--shadow:0 7px 24px rgba(16,24,40,.06)}*{box-sizing:border-box}body{margin:0;background:var(--bg);font-family:Arial,sans-serif;color:var(--text)}button,input{font:inherit}.wrap{max-width:1180px;margin:auto;padding:26px 18px 50px}.top{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:22px}.brand{font-size:12px;font-weight:800;letter-spacing:1.8px;color:var(--muted);text-transform:uppercase}.top h1{margin:5px 0;font-size:29px}.muted{color:var(--muted);font-size:13px}.section{margin-top:25px}.section-title{display:flex;justify-content:space-between;align-items:end;margin-bottom:10px}.section-title h2{margin:0;font-size:17px}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}.card{grid-column:span 6;background:var(--card);border:1px solid var(--line);border-radius:15px;padding:18px;box-shadow:var(--shadow)}.wide{grid-column:span 12}.third{grid-column:span 4}.card h3{margin:0;font-size:15px}.head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px}.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 9px;font-size:11px;font-weight:800;background:var(--soft);color:var(--muted)}.badge:before{content:"";width:7px;height:7px;border-radius:50%;background:#98a2b3}.badge.ok{background:var(--okbg);color:var(--ok)}.badge.ok:before{background:var(--ok)}.badge.warn{background:var(--warnbg);color:var(--warn)}.badge.warn:before{background:#d89b00}.badge.danger{background:var(--dangerbg);color:var(--danger)}.badge.danger:before{background:var(--danger)}.rows{border-top:1px solid var(--line)}.row{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}.row:last-child{border-bottom:0}.label{font-size:13px;color:var(--muted)}.value{font-size:13px;font-weight:700;text-align:right;word-break:break-word}.hint{font-size:12px;color:var(--muted);line-height:1.5;margin:0 0 14px}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn{border:0;border-radius:9px;padding:9px 12px;background:var(--primary);color:#fff;font-weight:700;font-size:13px;cursor:pointer}.btn.secondary{background:var(--soft);color:var(--text)}.btn.danger{background:var(--danger)}.btn.warn{background:#b77900}.btn:disabled{opacity:.5;cursor:not-allowed}.field{margin-bottom:11px}.field label{display:block;font-size:12px;font-weight:700;margin-bottom:5px}.field input{width:100%;padding:10px;border:1px solid #cbd3db;border-radius:9px}.notice{margin-top:12px;padding:10px 11px;background:#f8fafb;border-radius:9px;color:#596675;font-size:12px;line-height:1.5}.alert{padding:12px;border-radius:10px;background:var(--warnbg);color:var(--warn);font-size:13px;display:none}.danger-zone{border-color:#f0cbc7}.device{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}.device-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.device-controls{display:grid;grid-template-columns:minmax(180px,260px) 1fr;gap:12px;align-items:end}.control-buttons{display:flex;gap:8px;flex-wrap:wrap}.control-status{margin-top:8px}.device:last-child{border-bottom:0}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.log{max-height:250px;overflow:auto;border-top:1px solid var(--line)}.logline{padding:8px 0;border-bottom:1px solid var(--line);font-size:12px}@media(max-width:850px){.card,.wide,.third{grid-column:span 12}}@media(max-width:650px){.device-controls{grid-template-columns:1fr}.control-buttons .btn{flex:1 1 100%}.device{align-items:flex-start;flex-direction:column}.device-actions{width:100%;justify-content:flex-start}}@media(max-width:500px){.wrap{padding:18px 12px 35px}.top{align-items:flex-start;flex-direction:column}.top .btn{width:100%}}
</style></head><body><div class="wrap"><header class="top"><div><div class="brand">PrintBit</div><h1>Admin Control Center</h1><div class="muted">Physical kiosk control, diagnostics and maintenance</div></div><button id="logout" class="btn secondary">Log out</button></header><div id="alert" class="alert"></div>
<section class="section"><div class="section-title"><h2>1. System Overview</h2><span class="muted">Live controller state</span></div><div class="grid"><section class="card"><div class="head"><h3>Controller</h3><span id="systemBadge" class="badge">Loading</span></div><div class="rows"><div class="row"><span class="label">ESP32</span><span id="esp" class="value">Online</span></div><div class="row"><span class="label">Firmware</span><span id="firmware" class="value">-</span></div><div class="row"><span class="label">Reset reason</span><span id="resetReason" class="value">-</span></div><div class="row"><span class="label">Uptime</span><span id="uptime" class="value">-</span></div><div class="row"><span class="label">Free heap</span><span id="heap" class="value">-</span></div><div class="row"><span class="label">Minimum heap seen</span><span id="minHeap" class="value">-</span></div></div></section><section class="card"><div class="head"><h3>Network</h3><span id="networkBadge" class="badge">Loading</span></div><div class="rows"><div class="row"><span class="label">SSID</span><span id="ssid" class="value">-</span></div><div class="row"><span class="label">AP address</span><span class="value">192.168.4.1</span></div><div class="row"><span class="label">Tablet / Kiosk</span><span id="kioskRegistration" class="value">-</span></div><div class="row"><span class="label">Tablet IP</span><span id="kioskIp" class="value">-</span></div><div class="row"><span class="label">Tablet portal</span><span id="kioskPortal" class="value">-</span></div><div class="row"><span class="label">Connected devices</span><span id="stations" class="value">-</span></div></div></section></div></section>
<section class="section"><div class="section-title"><h2>2. Connected Devices</h2><span class="muted">Clients currently connected to PrintBit</span></div><div class="grid"><section class="card wide"><div class="head"><h3>Device Management</h3><span id="deviceAccessBadge" class="badge">Allowing devices</span></div><div class="device-controls"><div class="field"><label>Block duration</label><select id="deviceBlockDuration"><option value="0">Until turned off</option><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option></select></div><div class="control-buttons"><button id="deviceAccessToggle" class="btn warn">Block Other Devices</button><button id="disconnectAll" class="btn danger">Disconnect All Other Devices</button></div></div><div id="deviceAccessRemaining" class="muted control-status"></div><div id="devices">Loading...</div><div class="notice">When blocking is enabled, devices other than this admin device are disconnected and prevented from reconnecting until the selected time expires or blocking is turned off. The admin device remains protected.</div></section></div></section>
<section class="section"><div class="section-title"><h2>3. Coin System</h2><span class="muted">Coin acceptor diagnostics</span></div><div class="grid"><section class="card"><div class="head"><h3>Coin Acceptor</h3><span id="coinBadge" class="badge">Ready</span></div><div class="rows"><div class="row"><span class="label">Last coin</span><span id="lastCoin" class="value">None</span></div><div class="row"><span class="label">Pulse count</span><span id="pulseCount" class="value">0</span></div><div class="row"><span class="label">Pulse glitches</span><span id="pulseGlitches" class="value">0</span></div><div class="row"><span class="label">Last pulse timing</span><span id="pulseTiming" class="value">0 ms</span></div><div class="row"><span class="label">Last detected</span><span id="lastCoinTime" class="value">Never</span></div><div class="row"><span class="label">Accepted coins</span><span id="coinAccepted" class="value">0</span></div><div class="row"><span class="label">Invalid pulse trains</span><span id="coinInvalid" class="value">0</span></div><div class="row"><span class="label">Test coins</span><span id="coinTests" class="value">0</span></div></div><div class="actions" style="margin-top:14px"><button id="coinToggle" class="btn">Start Coin Acceptor Test</button></div><div class="notice">During the test, insert a coin and watch the pulse count and detected value. Test coins are recorded locally and are not forwarded to the tablet. The test automatically stops after 5 minutes.</div></section><section class="card"><div class="head"><h3>Coin Mapping</h3><span class="muted">Current firmware mapping</span></div><div class="rows"><div class="row"><span class="label">1 pulse</span><span class="value">₱1</span></div><div class="row"><span class="label">3 pulses</span><span class="value">₱5</span></div><div class="row"><span class="label">5 pulses</span><span class="value">₱10</span></div><div class="row"><span class="label">7 pulses</span><span class="value">₱20</span></div></div><div class="notice">Pulse count is the number of valid input pulses received for the last coin. Glitches are pulses rejected by the debounce/safety logic.</div></section></div></section>
<section class="section"><div class="section-title"><h2>4. Hopper</h2><span class="muted">Physical coin dispenser</span></div><div class="grid"><section class="card wide"><div class="head"><h3>Hopper Control</h3><span id="hopperBadge" class="badge">Loading</span></div><div class="field"><label>Coins to dispense</label><input id="hopperCoins" type="number" min="1" max="50" value="10"></div><div class="actions"><button id="hopperDispense" class="btn">Dispense Coins</button><button id="hopperMotor" class="btn secondary">Turn Hopper Motor On</button><button id="hopperAll" class="btn secondary">Dispense All Coins</button><button id="hopperStop" class="btn danger">Stop Hopper</button></div><div class="rows" style="margin-top:14px"><div class="row"><span class="label">Progress</span><span id="hopperProgress" class="value">0 / 0</span></div><div class="row"><span class="label">Last result</span><span id="hopperResult" class="value">Idle</span></div></div><div class="notice">Motor safety timeout is 30 seconds. Stop Hopper immediately turns the relay off.</div></section></div></section>
<section class="section"><div class="section-title"><h2>5. Hardware Diagnostics</h2><span class="muted">Live hardware states</span></div><div class="grid"><section class="card third"><div class="head"><h3>Coin Input</h3><span class="badge ok">GPIO 4</span></div><div class="row"><span class="label">Current state</span><span id="coinGpio" class="value">-</span></div></section><section class="card third"><div class="head"><h3>Hopper Sensor</h3><span class="badge ok">GPIO 19</span></div><div class="row"><span class="label">Current state</span><span id="sensorGpio" class="value">-</span></div></section><section class="card third"><div class="head"><h3>Relay</h3><span class="badge">GPIO 27</span></div><div class="row"><span class="label">State</span><span id="relayState" class="value">-</span></div></section></div></section>
<section class="section"><div class="section-title"><h2>6. Logs & Activity</h2><span class="muted">Local diagnostics since boot</span></div><div class="grid"><section class="card wide"><div class="head"><h3>Event & Admin Activity</h3></div><div id="logs" class="log">No events yet.</div></section><section class="card wide"><div class="head"><h3>Error History</h3></div><div id="errors" class="log">No errors recorded.</div></section></div></section>
<section class="section"><div class="section-title"><h2>7. Network & System</h2><span class="muted">Configuration and recovery</span></div><div class="grid"><section class="card"><div class="head"><h3>Wi-Fi Settings</h3></div><div class="field"><label>SSID</label><input id="newSsid" maxlength="32"></div><label style="font-size:12px;font-weight:700"><input id="passwordEnabled" type="checkbox"> Enable Wi-Fi password</label><div class="field" style="margin-top:10px"><label>Password</label><input id="newPassword" type="password" minlength="8" maxlength="63"></div><button id="saveWifi" class="btn">Save & Restart</button><div class="notice">Open Wi-Fi is allowed when password is disabled.</div></section><section class="card"><div class="head"><h3>Admin Account</h3></div><div class="field"><label>Username</label><input id="newUsername" maxlength="32"></div><div class="field"><label>New password</label><input id="newAdminPassword" type="password" minlength="8" maxlength="63"></div><button id="saveAccount" class="btn">Save Account</button></section><section class="card"><div class="head"><h3>Recovery</h3></div><div class="actions"><button id="exportConfig" class="btn secondary">Export Configuration (TXT)</button><button id="resetWifi" class="btn danger">Reset Wi-Fi</button><button id="restart" class="btn secondary">Restart ESP32</button></div><div class="notice">Wi-Fi reset restores PrintBit with no password. The admin account remains unchanged.</div></section></div></section></div><script>
const token=sessionStorage.getItem('printbit_admin_token');if(!token){location='/admin/login';}const auth={'Authorization':'Bearer '+token};const $=id=>document.getElementById(id);const api=async(url,opts={})=>{opts.headers=Object.assign({},auth,opts.headers||{});const r=await fetch(url,opts);if(r.status===401){sessionStorage.removeItem('printbit_admin_token');location='/admin/login';throw Error('Admin authorization expired');}return r};const showError=m=>{$('alert').textContent=m;$('alert').style.display='block'};const clearError=()=>{$('alert').style.display='none'};const badge=(id,text,type='')=>{$(id).textContent=text;$(id).className='badge '+type};const fmtUptime=ms=>{let s=Math.floor(ms/1000),d=Math.floor(s/86400);s%=86400;let h=Math.floor(s/3600);s%=3600;let m=Math.floor(s/60);s%=60;return(d?d+'d ':'')+h+'h '+m+'m '+s+'s'};const fmtAgo=t=>{if(!t)return'Never';let sec=Math.max(0,Math.floor((Date.now()/1000)-(t/1000)));return sec+'s ago'};
async function syncClock(){try{await api('/admin/api/time-sync',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'epoch='+Math.floor(Date.now()/1000)})}catch(e){}}
function renderDevices(list){$('devices').innerHTML=!list||!list.length?'<div class="muted">No devices connected.</div>':list.map(d=>'<div class="device"><div><b class="mono">'+d.mac+'</b>'+(d.isAdmin?' <span class="badge ok">ADMIN DEVICE</span>':'')+'<div class="muted">IP '+(d.ip||'unknown')+' · RSSI '+d.rssi+' dBm</div></div><div class="device-actions">'+(d.isAdmin?'<span class="muted">Protected</span>':'<button class="btn danger dc" data-mac="'+d.mac+'">Disconnect Device</button>')+'</div></div>').join('')}
function renderLogs(events){$('logs').innerHTML=!events||!events.length?'<div class="muted">No events yet.</div>':events.slice().reverse().map(x=>'<div class="logline">'+x+'</div>').join('')}
function updateHopper(d){let running=!!d.dispensing||!!d.manualOn;badge('hopperBadge',running?(d.dispenseAllMode?'Dispensing all':'Running'):'Ready',running?'ok':'');$('hopperProgress').textContent=(d.dispensedCoins||0)+' / '+(d.dispenseAllMode?'∞':(d.targetCoins||0));$('hopperResult').textContent=running?'Running':((d.lastOutcome||'idle').replaceAll('_',' '));$('hopperStop').disabled=!running;$('hopperMotor').textContent=d.manualOn?'Turn Hopper Motor Off':'Turn Hopper Motor On'}
async function load(){try{clearError();let r=await api('/admin/api/status');let d=await r.json();$('firmware').textContent=d.firmware;$('resetReason').textContent=d.resetReason;$('kioskRegistration').textContent=d.registration==='Registered'?'Registered':'Waiting for registration';$('kioskIp').textContent=d.registration==='Registered'?(d.kioskIp||'-'):'-';$('kioskPortal').textContent=d.registration==='Registered'?(d.kioskPortalUrl||'-'):'-';$('stations').textContent=d.stations;$('heap').textContent=d.freeHeap+' bytes';$('minHeap').textContent=d.minFreeHeap+' bytes';$('uptime').textContent=fmtUptime(d.uptimeMs);$('coinAccepted').textContent=d.coinAcceptedCount;$('coinInvalid').textContent=d.coinInvalidCount;$('coinTests').textContent=d.coinTestCount;$('lastCoin').textContent=d.lastCoinValue?'₱'+d.lastCoinValue:'None';$('pulseCount').textContent=d.lastCoinPulseCount;$('pulseGlitches').textContent=d.lastCoinPulseGlitchCount;$('pulseTiming').textContent=d.lastCoinPulseDurationMs+' ms';$('coinGpio').textContent=d.coinInputState;$('sensorGpio').textContent=d.hopperSensorState;$('relayState').textContent=d.relayState;$('lastCoinTime').textContent=d.lastCoinDetectedAt?fmtAgo(d.lastCoinDetectedAt):'Never';$('newSsid').value=d.ssid;$('passwordEnabled').checked=!!d.passwordEnabled;$('newPassword').disabled=!d.passwordEnabled;$('newUsername').value=d.adminUsername;badge('systemBadge',d.freeHeap<20000?'Attention':'Online',d.freeHeap<20000?'warn':'ok');badge('networkBadge',d.passwordEnabled?'Protected':'Open','ok');badge('coinBadge',d.coinTestMode?'TEST MODE':'Monitoring',d.coinTestMode?'warn':'ok');$('coinToggle').textContent=d.coinTestMode?'Stop Coin Acceptor Test':'Start Coin Acceptor Test';badge('deviceAccessBadge',d.blockOtherDevices?'Blocking other devices':'Allowing devices',d.blockOtherDevices?'warn':'ok');$('deviceAccessToggle').textContent=d.blockOtherDevices?'Allow Other Devices':'Block Other Devices';$('deviceBlockDuration').disabled=d.blockOtherDevices;let rem=d.blockOtherDevicesRemainingMs||0;$('deviceAccessRemaining').textContent=d.blockOtherDevices?(rem?'Remaining: '+fmtUptime(rem):'Until turned off'):'No block active';renderDevices(d.devices);renderLogs(d.events);$('errors').innerHTML=!d.errors||!d.errors.length?'<div class="muted">No errors recorded.</div>':d.errors.slice().reverse().map(x=>'<div class="logline">'+x+'</div>').join('');;updateHopper(d)}catch(e){showError(e.message)}}
async function post(url,body=''){let r=await api(url,{method:'POST',headers:body?{'Content-Type':'application/x-www-form-urlencoded'}:{},body});let d=await r.json().catch(()=>({}));if(!r.ok||d.ok===false)throw Error(d.error||'Request failed');return d}
$('disconnectAll').onclick=async()=>{if(!confirm('Disconnect all other connected devices? They will be allowed to reconnect normally afterward.'))return;try{await post('/admin/api/disconnect-all');await load()}catch(e){showError(e.message)}};$('logout').onclick=()=>{sessionStorage.removeItem('printbit_admin_token');location='/admin/login'};$('coinToggle').onclick=async()=>{try{let enabled=$('coinBadge').textContent==='TEST MODE';await post(enabled?'/admin/api/coin-test/stop':'/admin/api/coin-test/start');await load()}catch(e){showError(e.message)}};$('deviceAccessToggle').onclick=async()=>{try{let enabled=$('deviceAccessToggle').textContent==='Allow Other Devices';if(!enabled){let duration=Number($('deviceBlockDuration').value);let label=duration===0?'until turned off':duration+' minute'+(duration===1?'':'s');if(!confirm('Block all other devices '+label+'? They will be disconnected and prevented from reconnecting.'))return;await post('/admin/api/device-access','enabled=1&duration='+duration)}else{if(!confirm('Allow other devices to connect again?'))return;await post('/admin/api/device-access','enabled=0')}await load()}catch(e){showError(e.message)}};$('devices').onclick=async e=>{let b=e.target.closest('.dc');if(!b)return;if(!confirm('Disconnect device '+b.dataset.mac+'?'))return;try{await post('/admin/api/disconnect','mac='+encodeURIComponent(b.dataset.mac));await load()}catch(x){showError(x.message)}};$('hopperDispense').onclick=async()=>{let n=Number($('hopperCoins').value);if(!Number.isInteger(n)||n<1||n>50){showError('Enter 1-50 coins');return}if(!confirm('Dispense '+n+' coins?'))return;try{await post('/admin/api/hopper/dispense','coins='+n);await load()}catch(e){showError(e.message)}};$('hopperMotor').onclick=async()=>{try{let active=$('hopperMotor').textContent==='Turn Hopper Motor Off';await post(active?'/admin/api/hopper/stop':'/admin/api/hopper/on');await load()}catch(e){showError(e.message)}};$('hopperAll').onclick=async()=>{if(!confirm('Dispense all coins? Safety timeout remains 30 seconds.'))return;try{await post('/admin/api/hopper/dispense-all');await load()}catch(e){showError(e.message)}};$('hopperStop').onclick=async()=>{try{await post('/admin/api/hopper/stop');await load()}catch(e){showError(e.message)}};$('passwordEnabled').onchange=()=>{$('newPassword').disabled=!$('passwordEnabled').checked};$('saveWifi').onclick=async()=>{if(!confirm('Save Wi-Fi settings and restart ESP32?'))return;try{await api('/admin/api/wifi',{method:'POST',headers:{...auth,'Content-Type':'application/x-www-form-urlencoded'},body:'ssid='+encodeURIComponent($('newSsid').value)+'&password='+encodeURIComponent($('newPassword').value)+'&passwordEnabled='+($('passwordEnabled').checked?'1':'0')})}catch(e){showError(e.message)}};$('saveAccount').onclick=async()=>{if(!confirm('Change admin credentials and log out?'))return;try{await api('/admin/api/credentials',{method:'POST',headers:{...auth,'Content-Type':'application/x-www-form-urlencoded'},body:'username='+encodeURIComponent($('newUsername').value)+'&password='+encodeURIComponent($('newAdminPassword').value)});sessionStorage.removeItem('printbit_admin_token');location='/admin/login'}catch(e){showError(e.message)}};$('exportConfig').onclick=async()=>{try{let r=await api('/admin/api/config-export');let text=await r.text();let blob=new Blob([text],{type:'text/plain'});let a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='printbit-config.txt';a.click();URL.revokeObjectURL(a.href);await load()}catch(e){showError(e.message)}};$('resetWifi').onclick=async()=>{if(!confirm('Reset Wi-Fi to PrintBit defaults and restart?'))return;try{await api('/admin/api/reset-wifi',{method:'POST'})}catch(e){showError(e.message)}};$('restart').onclick=async()=>{if(!confirm('Restart ESP32 now?'))return;try{await api('/admin/api/restart',{method:'POST'})}catch(e){showError(e.message)}};syncClock().then(load);setInterval(load,5000);setInterval(syncClock,30000);</script></body></html>)HTML";
  replyAdminHtml(client, html);
}

void handleAdminStatus(NetworkClient& client) {
  String registration = hasKioskRegistration ? "Registered" : "Waiting for kiosk registration";
  int dispensedSnapshot = 0;
  noInterrupts();
  dispensedSnapshot = coinDispensed;
  interrupts();

  String json =
    "{\"ssid\":\"" + htmlEscape(apSsid) + "\",\"passwordEnabled\":" + String(apPasswordEnabled ? "true" : "false") + ",\"stations\":" + String(WiFi.softAPgetStationNum()) + ",\"registration\":\"" + registration + "\",\"freeHeap\":" + String(ESP.getFreeHeap()) + ",\"adminUsername\":\"" + htmlEscape(adminUsername) + "\",\"devices\":" + buildConnectedDevicesJson() + ",\"dispensing\":" + String((dispensing || hopperManualOn) ? "true" : "false") + ",\"manualOn\":" + String(hopperManualOn ? "true" : "false") + ",\"dispenseAllMode\":" + String(dispenseAllMode ? "true" : "false") + ",\"targetCoins\":" + String(targetCoins) + ",\"dispensedCoins\":" + String(dispensedSnapshot) + ",\"lastOutcome\":\"" + lastDispenseOutcome + "\",\"lastError\":\"" + lastDispenseError + "\",\"uptimeMs\":" + String(millis()) + ",\"minFreeHeap\":" + String(minFreeHeapSeen == UINT32_MAX ? ESP.getFreeHeap() : minFreeHeapSeen) + ",\"coinTestMode\":" + String(coinTestMode ? "true" : "false") + ",\"lastCoinValue\":" + String(lastCoinValue) + ",\"lastCoinPulseCount\":" + String(lastCoinPulseCount) + ",\"lastCoinPulseGlitchCount\":" + String(lastCoinPulseGlitchCount) + ",\"lastCoinPulseDurationMs\":" + String(lastCoinPulseDurationMs) + ",\"lastCoinDetectedAt\":" + String(lastCoinDetectedAt) + ",\"coinAcceptedCount\":" + String(coinAcceptedCount) + ",\"coinInvalidCount\":" + String(coinInvalidCount) + ",\"coinTestCount\":" + String(coinTestCount) + ",\"lastSystemError\":\"" + htmlEscape(lastSystemError) + "\",\"lastAdminAction\":\"" + htmlEscape(lastAdminAction) + "\",\"firmware\":\"PrintBit ESP32 Controller 1.0.0\"" + ",\"resetReason\":\"" + String(resetReasonText()) + "\"" + ",\"kioskIp\":\"" + htmlEscape(kioskIp) + "\"" + ",\"kioskPort\":" + String(kioskPort) + ",\"kioskPortalUrl\":\"" + htmlEscape(kioskPortalUrl) + "\"" + ",\"coinInputState\":\"" + String(digitalRead(coinAcceptorPin) == LOW ? "LOW" : "HIGH") + "\"" + ",\"hopperSensorState\":\"" + String(digitalRead(hopperSensorPin) == LOW ? "LOW" : "HIGH") + "\"" + ",\"relayState\":\"" + String(digitalRead(relayPin) == HIGH ? "ON" : "OFF") + "\"" + ",\"blockOtherDevices\":" + String(blockOtherDevices ? "true" : "false") + ",\"blockOtherDevicesUntil\":" + String(blockOtherDevicesUntil) + ",\"blockOtherDevicesRemainingMs\":" + String((blockOtherDevices && blockOtherDevicesUntil != 0 && (long)(millis() - blockOtherDevicesUntil) < 0) ? (blockOtherDevicesUntil - millis()) : 0) + ",\"clockSynced\":" + String(adminClockSynced ? "true" : "false") + ",\"currentTime\":\"" + htmlEscape(adminTimestamp()) + "\"}";
  String events = "[";
  for (int i = 0; i < adminEventLogCount; i++) {
    if (i > 0) events += ",";
    events += "\"" + htmlEscape(adminEventLog[i]) + "\"";
  }
  events += "]";
  json.remove(json.length() - 1);
  json += ",\"events\":" + events;
  String errors = "[";
  for (int i = 0; i < adminErrorLogCount; i++) {
    if (i > 0) errors += ",";
    errors += "\"" + htmlEscape(adminErrorLog[i]) + "\"";
  }
  errors += "]";
  json += ",\"errors\":" + errors + "}";
  replyAdminJson(client, json);
}

void handleAdminWifiSave(NetworkClient& client, const String& body) {
  String newSsid = getFormValue(body, "ssid");
  String newPassword = getFormValue(body, "password");
  String passwordEnabledValue = getFormValue(body, "passwordEnabled");
  newSsid.trim();
  newPassword.trim();
  passwordEnabledValue.trim();
  bool newPasswordEnabled = passwordEnabledValue == "1";

  if (newSsid.length() == 0 || newSsid.length() > 32) {
    Serial.println("wifi_settings_failed:invalid_ssid:length_out_of_range");
    replyPlain(client, 400, "Bad Request", "SSID must be 1-32 characters");
    return;
  }
  if (newPasswordEnabled && (newPassword.length() < 8 || newPassword.length() > 63)) {
    Serial.println("wifi_settings_failed:invalid_password:length_out_of_range");
    replyPlain(client, 400, "Bad Request", "Password must be 8-63 characters when Wi-Fi password is enabled");
    return;
  }
  if (!newPasswordEnabled) newPassword = "";
  if (!saveApCredentials(newSsid, newPassword, newPasswordEnabled)) {
    Serial.println("wifi_settings_failed:storage_write_failed");
    replyPlain(client, 500, "Internal Server Error", "Failed to save AP settings");
    return;
  }

  addAdminEvent(String("Wi-Fi settings changed: ") + newSsid);
  lastAdminAction = "Wi-Fi settings changed";
  Serial.print("wifi_settings_saved:ssid=");
  Serial.println(newSsid);
  replyPlain(client, 200, "OK", "AP settings saved. Restarting with the new SSID and password...");
  delay(500);
  ESP.restart();
}

void handleAdminCredentials(NetworkClient& client, const String& body) {
  String newUsername = getFormValue(body, "username");
  String newPassword = getFormValue(body, "password");
  newUsername.trim();
  newPassword.trim();

  if (newUsername.length() == 0 || newUsername.length() > 32) {
    Serial.println("admin_credentials_failed:invalid_username:length_out_of_range");
    replyPlain(client, 400, "Bad Request", "Username must be 1-32 characters");
    return;
  }
  if (newPassword.length() < 8 || newPassword.length() > 63) {
    Serial.println("admin_credentials_failed:invalid_password:length_out_of_range");
    replyPlain(client, 400, "Bad Request", "Password must be 8-63 characters");
    return;
  }
  if (!saveAdminCredentials(newUsername, newPassword)) {
    Serial.println("admin_credentials_failed:storage_write_failed");
    replyPlain(client, 500, "Internal Server Error", "Failed to save admin credentials");
    return;
  }

  adminSessionToken = makeAdminSessionToken();
  protectedAdminMac = "";
  addAdminEvent("Admin credentials changed");
  lastAdminAction = "Admin credentials changed";
  Serial.print("admin_credentials_saved:username=");
  Serial.println(newUsername);
  replyPlain(client, 200, "OK", "Admin credentials saved. Current session invalidated.");
}

void handleAdminDisconnectDevice(NetworkClient& client, const String& body) {
  String mac = getFormValue(body, "mac");
  mac.trim();
  mac.toUpperCase();
  Serial.print("admin_device_disconnect:request:mac=");
  Serial.println(mac);
  if (mac.length() != 17) {
    Serial.println("admin_device_disconnect:failed:invalid_mac");
    replyAdminJson(client, "{\"ok\":false,\"errorCode\":\"INVALID_MAC\",\"error\":\"Invalid device MAC address\"}", 400, "Bad Request");
    return;
  }

  if (protectedAdminMac.length() > 0 && mac == protectedAdminMac) {
    Serial.println("admin_device_disconnect:failed:admin_device_protected");
    replyAdminJson(client, "{\"ok\":false,\"errorCode\":\"ADMIN_DEVICE_PROTECTED\",\"error\":\"The current admin device cannot be disconnected\"}", 409, "Conflict");
    return;
  }

  if (!disconnectStationByMac(mac)) {
    String code = disconnectErrorCode.length() > 0 ? disconnectErrorCode : "DISCONNECT_FAILED";
    String message = code == "NOT_CONNECTED" ? "Device is no longer connected" : "ESP32 could not disconnect the device";
    int status = code == "NOT_CONNECTED" ? 404 : 500;
    String json = "{\"ok\":false,\"errorCode\":\"" + code + "\",\"error\":\"" + message + "\"}";
    replyAdminJson(client, json, status, status == 404 ? "Not Found" : "Internal Server Error");
    return;
  }

  addAdminEvent(String("Device disconnected: ") + mac);
  lastAdminAction = "Device disconnected";
  replyAdminJson(client, "{\"ok\":true,\"errorCode\":null,\"message\":\"Device disconnected\"}");
}


void handleAdminDisconnectAllDevices(NetworkClient& client) {
  if (protectedAdminMac.length() == 0) {
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Admin device is not identified\"}", 409, "Conflict");
    return;
  }

  wifi_sta_list_t stationList;
  memset(&stationList, 0, sizeof(stationList));
  if (esp_wifi_ap_get_sta_list(&stationList) != ESP_OK) {
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Could not read connected devices\"}", 500, "Internal Server Error");
    return;
  }

  int disconnected = 0;
  for (int i = 0; i < stationList.num; i++) {
    String mac = stationMacToString(stationList.sta[i].mac);
    if (mac == protectedAdminMac) continue;

    uint16_t aid = 0;
    if (esp_wifi_ap_get_sta_aid(stationList.sta[i].mac, &aid) == ESP_OK && aid != 0) {
      if (esp_wifi_deauth_sta(aid) == ESP_OK) disconnected++;
    }
  }

  // This is intentionally NOT a block. Devices may reconnect normally afterward.
  addAdminEvent(String("Disconnected all other devices: ") + String(disconnected));
  lastAdminAction = "Disconnected all other devices";
  replyAdminJson(client, String("{\"ok\":true,\"disconnected\":") + String(disconnected) + "}");
}

void handleAdminHopperDispense(NetworkClient& client, const String& body) {
  String postedCoins = getFormValue(body, "coins");
  postedCoins.trim();
  if (!isNumericString(postedCoins)) {
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Enter a valid coin count\"}", 400, "Bad Request");
    return;
  }
  int coins = postedCoins.toInt();
  if (coins <= 0 || coins > maxDispenseCoins) {
    String json = "{\"ok\":false,\"error\":\"Coin count must be 1-" + String(maxDispenseCoins) + "\"}";
    replyAdminJson(client, json, 400, "Bad Request");
    return;
  }
  if (!startDispense(coins, buildHopperRequestId(), "admin")) {
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Hopper is busy or the request is invalid\"}", 409, "Conflict");
    return;
  }
  replyAdminJson(client, "{\"ok\":true,\"message\":\"Dispensing started\"}");
}

void handleAdminHopperDispenseAll(NetworkClient& client) {
  if (dispensing) {
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Hopper is already running\"}", 409, "Conflict");
    return;
  }
  targetCoins = 0;
  noInterrupts();
  coinDispensed = 0;
  dispenseProgressDirty = false;
  interrupts();
  dispensing = true;
  hopperManualOn = false;
  dispenseAllMode = true;
  dispenseDone = false;
  dispenseTimedOut = false;
  hopperStartTime = millis();
  lastProgressReported = -1;
  activeDispenseRequestId = buildHopperRequestId();
  lastDispenseRequestId = activeDispenseRequestId;
  lastDispenseOutcome = "dispensing_all";
  lastDispenseError = "";
  digitalWrite(relayPin, HIGH);
  emitHopperAck(activeDispenseRequestId);
  Serial.print("hopper_start_all:requestId=");
  Serial.println(activeDispenseRequestId);
  replyAdminJson(client, "{\"ok\":true,\"message\":\"Dispense-all started\"}");
}

void handleAdminHopperOn(NetworkClient& client) {
  if (dispensing || hopperManualOn) {
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Hopper is already running\"}", 409, "Conflict");
    return;
  }
  noInterrupts();
  coinDispensed = 0;
  dispenseProgressDirty = false;
  interrupts();
  targetCoins = 0;
  dispenseAllMode = false;
  dispensing = false;
  dispenseDone = false;
  dispenseTimedOut = false;
  hopperManualOn = true;
  hopperStartTime = millis();
  lastDispenseRequestId = buildHopperRequestId();
  lastDispenseOutcome = "manual_on";
  lastDispenseError = "";
  digitalWrite(relayPin, HIGH);
  Serial.print("hopper_manual_on:requestId=");
  Serial.println(lastDispenseRequestId);
  replyAdminJson(client, "{\"ok\":true,\"message\":\"Hopper motor turned on\"}");
}

void handleAdminHopperStop(NetworkClient& client) {
  bool wasRunning = dispensing || hopperManualOn;
  digitalWrite(relayPin, LOW);
  if (dispensing || hopperManualOn) {
    dispensing = false;
    dispenseAllMode = false;
    dispenseDone = false;
    dispenseTimedOut = false;
    lastDispenseOutcome = "stopped";
    lastDispenseError = "MANUAL_STOP";
    lastDispenseFinishedAt = millis();
    Serial.print("hopper_stop:requestId=");
    Serial.println(lastDispenseRequestId);
    activeDispenseRequestId = "";
  }
  hopperManualOn = false;
  replyAdminJson(client, wasRunning
                           ? "{\"ok\":true,\"message\":\"Hopper stopped\"}"
                           : "{\"ok\":true,\"message\":\"Hopper is already off\"}");
}


void handleAdminCoinTestStart(NetworkClient& client) {
  if (dispensing || hopperManualOn) {
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Stop the hopper before starting coin test\"}", 409, "Conflict");
    return;
  }
  coinTestMode = true;
  coinTestStartedAt = millis();
  lastCoinValue = 0;
  lastCoinPulseCount = 0;
  lastCoinPulseGlitchCount = 0;
  lastCoinPulseDurationMs = 0;
  coinTestCount = 0;
  addAdminEvent("Coin test started");
  lastAdminAction = "Coin test started";
  replyAdminJson(client, "{\"ok\":true,\"message\":\"Coin test mode started. Insert a coin.\"}");
}

void handleAdminCoinTestStop(NetworkClient& client) {
  coinTestMode = false;
  addAdminEvent("Coin test stopped");
  lastAdminAction = "Coin test stopped";
  replyAdminJson(client, "{\"ok\":true,\"message\":\"Coin test mode stopped\"}");
}

void handleAdminExportConfig(NetworkClient& client) {
  String text;
  text += "PRINTBIT CONFIGURATION\r\n";
  text += "======================\r\n\r\n";
  text += "SYSTEM\r\n";
  text += "Firmware: PrintBit ESP32 Controller 1.0.0\r\n";
  text += "Reset Reason: " + String(resetReasonText()) + "\r\n";
  text += "Uptime: " + String(millis() / 1000UL) + " seconds\r\n";
  text += "Current Time: " + adminTimestamp() + "\r\n\r\n";
  text += "WIFI ACCESS POINT\r\n";
  text += "SSID: " + apSsid + "\r\n";
  text += "Password Enabled: " + String(apPasswordEnabled ? "Yes" : "No") + "\r\n";
  text += "AP Address: " + WiFi.softAPIP().toString() + "\r\n\r\n";
  text += "ADMIN\r\n";
  text += "Username: " + adminUsername + "\r\n\r\n";
  text += "KIOSK / TABLET\r\n";
  text += "Registered: " + String(hasKioskRegistration ? "Yes" : "No") + "\r\n";
  text += "IP Address: " + kioskIp + "\r\n";
  text += "Port: " + String(kioskPort) + "\r\n";
  text += "Portal: " + kioskPortalPath + "\r\n\r\n";
  text += "COIN ACCEPTOR\r\n";
  text += "GPIO: 4\r\n";
  text += "1 pulse = P1\r\n";
  text += "3 pulses = P5\r\n";
  text += "5 pulses = P10\r\n";
  text += "7 pulses = P20\r\n\r\n";
  text += "HOPPER\r\n";
  text += "Sensor GPIO: 19\r\n";
  text += "Relay GPIO: 27\r\n";
  text += "Maximum Run Time: 30 seconds\r\n\r\n";
  text += "DEVICE ACCESS\r\n";
  text += "Other Devices: " + String(blockOtherDevices ? "Blocked" : "Allowed") + "\r\n";
  text += "\r\nNOTE: Passwords, session tokens, API keys, and other secrets are intentionally excluded.\r\n";
  addAdminEvent("Configuration exported without secrets");
  lastAdminAction = "Configuration exported";
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: text/plain; charset=utf-8");
  client.println("Content-Disposition: attachment; filename=printbit-config.txt");
  client.println("Cache-Control: no-store");
  client.println("Connection: close");
  client.println();
  client.print(text);
}

void handleAdminTimeSync(NetworkClient& client, const String& body) {
  String value = getFormValue(body, "epoch");
  value.trim();
  uint64_t epoch = strtoull(value.c_str(), nullptr, 10);
  if (epoch < 1600000000ULL || epoch > 2200000000ULL) {
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Invalid time value\"}", 400, "Bad Request");
    return;
  }
  struct timeval tv;
  tv.tv_sec = (time_t)epoch;
  tv.tv_usec = 0;
  settimeofday(&tv, nullptr);
  setenv("TZ", "PHT-8", 1);
  tzset();
  adminClockSynced = true;
  replyAdminJson(client, "{\"ok\":true,\"time\":\"" + htmlEscape(adminTimestamp()) + "\"}");
}

void handleAdminDeviceAccess(NetworkClient& client, const String& body) {
  String enabledValue = getFormValue(body, "enabled");
  String durationValue = getFormValue(body, "duration");
  enabledValue.trim();
  durationValue.trim();
  bool enabled = enabledValue == "1";
  int durationMinutes = durationValue.length() ? durationValue.toInt() : 0;
  if (durationMinutes != 0 && durationMinutes != 5 && durationMinutes != 15 && durationMinutes != 30 && durationMinutes != 60) {
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Duration must be 0, 5, 15, 30, or 60 minutes\"}", 400, "Bad Request");
    return;
  }

  // The device that successfully logged in owns the admin role. Its MAC is used
  // instead of its IP, so DHCP/IP changes do not change the admin identity.
  wifi_sta_list_t stationList;
  memset(&stationList, 0, sizeof(stationList));
  if (esp_wifi_ap_get_sta_list(&stationList) != ESP_OK) {
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Could not read connected devices\"}", 500, "Internal Server Error");
    return;
  }
  if (protectedAdminMac.length() == 0) {
    for (int i = 0; i < stationList.num; i++) {
      IPAddress stationIp;
      if (getStationIpByMac(stationList.sta[i].mac, stationIp) && stationIp == client.remoteIP()) {
        protectedAdminMac = stationMacToString(stationList.sta[i].mac);
        break;
      }
    }
  }

  if (!enabled) {
    blockOtherDevices = false;
    blockOtherDevicesUntil = 0;
    addAdminEvent("Other device access allowed");
    lastAdminAction = "Other device access allowed";
    replyAdminJson(client, "{\"ok\":true,\"blocked\":false}");
    return;
  }

  if (protectedAdminMac.length() == 0) {
    replyAdminJson(client, "{\"ok\":false,\"error\":\"Admin device could not be identified safely\"}", 409, "Conflict");
    return;
  }

  blockOtherDevices = true;
  blockOtherDevicesUntil = durationMinutes == 0 ? 0 : millis() + (unsigned long)durationMinutes * 60000UL;

  // Immediately disconnect every non-admin station. The loop continues enforcing the block.
  for (int i = 0; i < stationList.num; i++) {
    String mac = stationMacToString(stationList.sta[i].mac);
    if (mac == protectedAdminMac) continue;
    uint16_t aid = 0;
    if (esp_wifi_ap_get_sta_aid(stationList.sta[i].mac, &aid) == ESP_OK && aid != 0) {
      esp_wifi_deauth_sta(aid);
    }
  }

  addAdminEvent(String("Other device access blocked: ") + (durationMinutes == 0 ? "until turned off" : String(durationMinutes) + " minutes"));
  lastAdminAction = "Other device access blocked";
  replyAdminJson(client, String("{\"ok\":true,\"blocked\":true,\"durationMinutes\":") + String(durationMinutes) + "}");
}

void handleAdminResetWifi(NetworkClient& client) {
  resetApCredentials();
  addAdminEvent("Wi-Fi reset to defaults");
  lastAdminAction = "Wi-Fi reset";
  Serial.println("admin_wifi_reset:credentials_cleared:restoring_defaults");
  replyPlain(client, 200, "OK", "Wi-Fi credentials reset to defaults. Restarting...");
  delay(500);
  ESP.restart();
}

void handleAdminRestart(NetworkClient& client) {
  addAdminEvent("ESP32 restart requested");
  lastAdminAction = "ESP32 restart requested";
  Serial.println("admin_restart:requested_from_dashboard");
  replyPlain(client, 200, "OK", "Restarting ESP32...");
  delay(500);
  ESP.restart();
}

void checkPhysicalCredentialRecovery() {
  pinMode(bootButtonPin, INPUT_PULLUP);
  unsigned long start = millis();
  Serial.println("credential_recovery_window:15s:press_boot_to_reset_wifi");

  while (millis() - start < credentialRecoveryWindowMs) {
    if (digitalRead(bootButtonPin) == LOW) {
      delay(60);
      if (digitalRead(bootButtonPin) == LOW) {
        resetApCredentials();
        Serial.println("credential_recovery:boot_pressed:reset_to_defaults");
        Serial.println("credential_recovery:release_boot_to_continue");
        while (digitalRead(bootButtonPin) == LOW) delay(10);
        delay(200);
        ESP.restart();
      }
    }
    delay(10);
  }
  Serial.println("credential_recovery_window:expired:normal_boot");
}

void loadApCredentials() {
  preferences.begin("printbit", true);
  apSsid = preferences.getString("ssid", defaultApSsid);
  apPassword = preferences.getString("password", defaultApPassword);
  apPasswordEnabled = preferences.getBool("passwordEnabled", false);
  preferences.end();

  if (apSsid.length() == 0 || apSsid.length() > 32) apSsid = defaultApSsid;
  if (apPasswordEnabled && (apPassword.length() < 8 || apPassword.length() > 63)) {
    apPasswordEnabled = false;
    apPassword = "";
  }
  if (!apPasswordEnabled) apPassword = "";
}

bool saveApCredentials(const String& newSsid, const String& newPassword, bool passwordEnabled) {
  if (newSsid.length() == 0 || newSsid.length() > 32) return false;
  if (passwordEnabled && (newPassword.length() < 8 || newPassword.length() > 63)) return false;

  preferences.begin("printbit", false);
  bool ok = preferences.putString("ssid", newSsid) > 0;
  ok = preferences.putString("password", passwordEnabled ? newPassword : "") > 0 && ok;
  ok = preferences.putBool("passwordEnabled", passwordEnabled) && ok;
  preferences.end();

  if (ok) {
    apSsid = newSsid;
    apPassword = passwordEnabled ? newPassword : "";
    apPasswordEnabled = passwordEnabled;
  }
  return ok;
}

String getQueryValue(const String& query, const String& key) {
  String needle = key + "=";
  int start = query.indexOf(needle);
  if (start < 0) return "";
  start += needle.length();
  int end = query.indexOf('&', start);
  if (end < 0) end = query.length();
  return decodeUrlComponent(query.substring(start, end));
}

bool isNumericString(const String& value) {
  if (value.length() == 0) return false;
  for (size_t i = 0; i < value.length(); i++) {
    if (!isDigit(value.charAt(i))) return false;
  }
  return true;
}

String buildHopperRequestId() {
  return String((uint32_t)esp_random(), HEX) + "-" + String(millis());
}

String normalizedPath(const String& pathCandidate) {
  if (pathCandidate.length() == 0) return "/portal";
  if (pathCandidate.charAt(0) == '/') return pathCandidate;
  return "/" + pathCandidate;
}

bool isValidIpv4Address(const String& ip) {
  int start = 0;
  for (int i = 0; i < 4; i++) {
    int dot = i < 3 ? ip.indexOf('.', start) : ip.length();
    if (dot <= start) return false;
    String part = ip.substring(start, dot);
    if (part.length() > 3) return false;
    for (size_t j = 0; j < part.length(); j++) {
      if (!isDigit(part.charAt(j))) return false;
    }
    int value = part.toInt();
    if (value < 0 || value > 255) return false;
    start = dot + 1;
  }
  return start == ip.length() + 1;
}

void refreshTargets() {
  kioskPortalPath = normalizedPath(kioskPortalPath);
  kioskPortalUrl =
    "http://" + kioskIp + ":" + String(kioskPort) + kioskPortalPath;
  tabletServer = "http://" + kioskIp + ":" + String(kioskPort) + "/coin";
}

void replyRedirect(NetworkClient& client, const String& location) {
  client.println("HTTP/1.1 302 Found");
  client.print("Location: ");
  client.println(location);
  client.println("Content-Length: 0");
  client.println("Connection: close");
  client.println();
}

void replyPlain(
  NetworkClient& client,
  int statusCode,
  const String& statusText,
  const String& body) {
  client.print("HTTP/1.1 ");
  client.print(statusCode);
  client.print(" ");
  client.println(statusText);
  client.println("Content-Type: text/plain; charset=utf-8");
  client.print("Content-Length: ");
  client.println(body.length());
  client.println("Connection: close");
  client.println();
  client.print(body);
}

bool parseRequestLine(const String& requestLine, String& method, String& path) {
  int firstSpace = requestLine.indexOf(' ');
  if (firstSpace <= 0) return false;
  int secondSpace = requestLine.indexOf(' ', firstSpace + 1);
  if (secondSpace <= firstSpace) return false;
  method = requestLine.substring(0, firstSpace);
  path = requestLine.substring(firstSpace + 1, secondSpace);
  return method.length() > 0 && path.length() > 0;
}

String readRequestBody(NetworkClient& client, int contentLength) {
  if (contentLength <= 0) return "";
  String body = "";
  unsigned long start = millis();
  while ((int)body.length() < contentLength && millis() - start < 1500) {
    while (client.available() && (int)body.length() < contentLength) {
      body += char(client.read());
    }
    delay(1);
  }
  if ((int)body.length() < contentLength) {
    Serial.print("http_body_incomplete:expected=");
    Serial.print(contentLength);
    Serial.print(":received=");
    Serial.println(body.length());
  }
  return body;
}


bool isCaptiveProbePath(const String& path) {
  return path == "/hotspot-detect.html" || path == "/generate_204" || path == "/ncsi.txt" || path == "/connecttest.txt";
}

String buildCoinEventId() {
  coinEventCounter++;
  return String((uint32_t)esp_random(), HEX) + "-" + String(millis()) + "-" + String(coinEventCounter);
}

void logCoinSendFailure(const String& classification, int code, const String& body) {
  Serial.print("coin_send_failed:");
  Serial.print(classification);
  Serial.print(":code=");
  Serial.print(code);
  if (body.length() > 0) {
    Serial.print(":body=");
    Serial.print(body);
  }
  Serial.println();
}

void emitHopperAck(const String& requestId) {
  Serial.print("HOPPER ACK ");
  Serial.println(requestId);
}

void emitHopperProgress(const String& requestId, int dispensed, int total) {
  Serial.print("HOPPER PROGRESS ");
  Serial.print(requestId);
  Serial.print(" ");
  Serial.print(dispensed);
  Serial.print(" ");
  Serial.println(total);
}

void emitHopperDone(const String& requestId, int dispensedCount) {
  Serial.print("HOPPER DONE ");
  Serial.print(requestId);
  Serial.print(" ");
  Serial.println(dispensedCount);
}

void emitHopperError(
  const String& requestId,
  const String& errorCode,
  const String& detail) {
  Serial.print("HOPPER ERR ");
  Serial.print(requestId.length() > 0 ? requestId : "n/a");
  Serial.print(" ");
  Serial.print(errorCode);
  if (detail.length() > 0) {
    Serial.print(" ");
    Serial.print(detail);
  }
  Serial.println();
}

void sendCoinToTablet(int value) {
  if (WiFi.softAPgetStationNum() == 0) {
    logCoinSendFailure("network_unreachable_no_station", 0, "");
    return;
  }
  if (tabletServer.length() == 0) {
    logCoinSendFailure("not_registered", 0, "");
    return;
  }

  const String eventId = buildCoinEventId();
  const String url =
    tabletServer + "?value=" + String(value) + "&eventId=" + eventId;

  for (int attempt = 1; attempt <= maxCoinSendAttempts; attempt++) {
    HTTPClient http;
    http.begin(url);
    http.addHeader("x-coin-source", coinBridgeSource);
    http.addHeader("x-coin-api-key", coinBridgeApiKey);
    http.addHeader("x-coin-event-id", eventId);
    int code = http.GET();
    String body = http.getString();
    http.end();

    if (code == 200) {
      Serial.print("coin_sent_ok:eventId=");
      Serial.print(eventId);
      Serial.print(":value=");
      Serial.println(value);
      return;
    }
    // if (code == 409) {
    //   logCoinSendFailure("coin_rejected_409", code, body);
    //   return;
    // }
    // if (code == 400) {
    //   logCoinSendFailure("validation_failed", code, body);
    //   return;
    // }
    // if (code == 401 || code == 403) {
    //   logCoinSendFailure("auth_failed", code, body);
    //   return;
    // }
    // if (code > 0 && code < 500) {
    //   logCoinSendFailure("request_rejected", code, body);
    //   return;
    // }

    // Serial.print("coin_send_retry:attempt=");
    // Serial.print(attempt);
    // Serial.print(":code=");
    // Serial.println(code);

    if (attempt >= maxCoinSendAttempts) {
      if (code < 0) {
        logCoinSendFailure("network_unreachable", code, body);
      } else {
        logCoinSendFailure("server_error", code, body);
      }
      return;
    }
    delay(200 * attempt);
  }
}

void handleRegisterRequest(NetworkClient& client, const String& body) {
  String postedToken = getFormValue(body, "token");
  String postedIp = getFormValue(body, "ip");
  String postedPort = getFormValue(body, "port");
  String postedPath = getFormValue(body, "path");
  postedToken.trim();
  postedIp.trim();
  postedPort.trim();
  postedPath.trim();

  if (postedToken.length() == 0 || postedToken != kioskRegisterToken) {
    replyPlain(client, 401, "Unauthorized", "Invalid registration token");
    Serial.println("kiosk_register_failed:unauthorized");
    return;
  }
  // The tablet's IP is the actual source IP of this registration request.
  // Do not trust or require a client-supplied IP because DHCP may change it.
  IPAddress registrationIp = client.remoteIP();
  if (registrationIp == IPAddress(0, 0, 0, 0)) {
    replyPlain(client, 400, "Bad Request", "Could not identify tablet IP");
    Serial.println("kiosk_register_failed:source_ip_unavailable");
    return;
  }

  String registrationMac;
  if (!getStationMacByIp(registrationIp, registrationMac)) {
    replyPlain(client, 409, "Conflict", "Could not identify tablet device");
    Serial.println("kiosk_register_failed:device_identity_not_found");
    return;
  }

  int parsedPort = postedPort.toInt();
  if (parsedPort <= 0 || parsedPort > 65535) {
    parsedPort = fallbackKioskPort;
  }

  kioskIp = registrationIp.toString();
  kioskMac = registrationMac;
  kioskPort = uint16_t(parsedPort);
  kioskPortalPath = normalizedPath(postedPath);
  hasKioskRegistration = true;
  refreshTargets();
  addAdminEvent(String("Kiosk registered: ") + kioskIp + ":" + String(kioskPort));

  Serial.print("kiosk_registered:coin_target=");
  Serial.println(tabletServer);
  Serial.print("kiosk_registered:portal_target=");
  Serial.println(kioskPortalUrl);

  replyPlain(client, 200, "OK", "registered");
}

void handleWifiRequest(NetworkClient& client) {
  client.setTimeout(250);
  String requestLine = client.readStringUntil('\r');
  client.readStringUntil('\n');
  if (requestLine.length() == 0) {
    Serial.println("http_request_error:empty_request_line");
    client.stop();
    return;
  }

  String method = "";
  String path = "";
  if (!parseRequestLine(requestLine, method, path)) {
    Serial.print("http_request_error:malformed_request_line:");
    Serial.println(requestLine);
    replyPlain(client, 400, "Bad Request", "Invalid request line");
    client.stop();
    return;
  }

  String routePath = path;
  String query = "";
  int querySep = path.indexOf('?');
  if (querySep >= 0) {
    routePath = path.substring(0, querySep);
    query = path.substring(querySep + 1);
  }

  int contentLength = 0;
  String hopperTokenHeader = "";
  String authorizationHeader = "";
  while (client.connected()) {
    String headerLine = client.readStringUntil('\r');
    client.readStringUntil('\n');
    if (headerLine.length() == 0) break;
    int colonPos = headerLine.indexOf(':');
    if (colonPos <= 0) continue;
    String headerKey = headerLine.substring(0, colonPos);
    headerKey.toLowerCase();
    if (headerKey == "content-length") {
      String lengthPart = headerLine.substring(colonPos + 1);
      lengthPart.trim();
      contentLength = lengthPart.toInt();
    } else if (headerKey == "x-hopper-token") {
      hopperTokenHeader = headerLine.substring(colonPos + 1);
      hopperTokenHeader.trim();
    } else if (headerKey == "authorization") {
      authorizationHeader = headerLine.substring(colonPos + 1);
      authorizationHeader.trim();
    }
  }

  String body = "";
  if (contentLength > 0 && contentLength <= 512) {
    body = readRequestBody(client, contentLength);
  } else if (contentLength > 512) {
    Serial.print("http_request_error:content_length_too_large:");
    Serial.println(contentLength);
  }

  if (routePath == "/admin/login") {
    if (method == "GET") {
      replyAdminLoginPage(client);
      client.stop();
      return;
    }
    if (method == "POST") {
      if (contentLength <= 0 || contentLength > 256) {
        Serial.println("admin_login_failed:invalid_payload_size");
        replyPlain(client, 413, "Payload Too Large", "Invalid login payload size");
        client.stop();
        return;
      }
      handleAdminLogin(client, body);
      client.stop();
      return;
    }
  }

  if (routePath == "/admin") {
    if (method == "GET") {
      replyAdminDashboardPage(client);
      client.stop();
      return;
    }
  }

  if (routePath.startsWith("/admin/api/")) {
    if (!hasAdminAuthorization(authorizationHeader)) {
      Serial.print("admin_auth_failed:path=");
      Serial.print(routePath);
      Serial.print(":reason=");
      Serial.println(authorizationHeader.length() == 0 ? "missing_authorization_header" : "invalid_bearer_token");
      addAdminError("Admin authorization failed");
      replyAdminUnauthorized(client);
      client.stop();
      return;
    }
    if (method == "GET" && routePath == "/admin/api/status") {
      handleAdminStatus(client);
      client.stop();
      return;
    }
    if (method == "GET" && routePath == "/admin/api/hopper/status") {
      handleAdminStatus(client);
      client.stop();
      return;
    }
    if (method == "GET" && routePath == "/admin/api/events") {
      handleAdminStatus(client);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/coin-test/start") {
      handleAdminCoinTestStart(client);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/coin-test/stop") {
      handleAdminCoinTestStop(client);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/device-access") {
      if (contentLength <= 0 || contentLength > 64) {
        replyAdminJson(client, "{\"ok\":false,\"error\":\"Invalid device access payload\"}", 413, "Payload Too Large");
        client.stop();
        return;
      }
      handleAdminDeviceAccess(client, body);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/time-sync") {
      if (contentLength <= 0 || contentLength > 64) {
        replyAdminJson(client, "{\"ok\":false,\"error\":\"Invalid time payload\"}", 413, "Payload Too Large");
        client.stop();
        return;
      }
      handleAdminTimeSync(client, body);
      client.stop();
      return;
    }
    if (method == "GET" && routePath == "/admin/api/config-export") {
      handleAdminExportConfig(client);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/wifi") {
      if (contentLength <= 0 || contentLength > 256) {
        Serial.println("wifi_settings_failed:invalid_payload_size");
        replyPlain(client, 413, "Payload Too Large", "Invalid Wi-Fi payload size");
        client.stop();
        return;
      }
      handleAdminWifiSave(client, body);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/hopper/dispense") {
      if (contentLength <= 0 || contentLength > 64) {
        replyAdminJson(client, "{\"ok\":false,\"error\":\"Invalid hopper payload size\"}", 413, "Payload Too Large");
        client.stop();
        return;
      }
      handleAdminHopperDispense(client, body);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/hopper/dispense-all") {
      handleAdminHopperDispenseAll(client);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/hopper/on") {
      handleAdminHopperOn(client);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/hopper/stop") {
      handleAdminHopperStop(client);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/reset-wifi") {
      handleAdminResetWifi(client);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/restart") {
      handleAdminRestart(client);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/credentials") {
      if (contentLength <= 0 || contentLength > 160) {
        Serial.println("admin_credentials_failed:invalid_payload_size");
        replyPlain(client, 413, "Payload Too Large", "Invalid admin credentials payload size");
        client.stop();
        return;
      }
      handleAdminCredentials(client, body);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/disconnect") {
      if (contentLength <= 0 || contentLength > 64) {
        Serial.println("admin_device_disconnect:failed:invalid_payload_size");
        replyPlain(client, 413, "Payload Too Large", "Invalid disconnect payload size");
        client.stop();
        return;
      }
      handleAdminDisconnectDevice(client, body);
      client.stop();
      return;
    }
    if (method == "POST" && routePath == "/admin/api/disconnect-all") {
      handleAdminDisconnectAllDevices(client);
      client.stop();
      return;
    }
  }

  if (method == "POST" && routePath.startsWith("/kiosk/register")) {
    if (contentLength <= 0 || contentLength > 512) {
      replyPlain(client, 413, "Payload Too Large", "Invalid payload size");
      client.stop();
      return;
    }
    handleRegisterRequest(client, body);
    client.stop();
    return;
  }

  if (method == "GET" && isCaptiveProbePath(routePath)) {
    if (hasKioskRegistration && kioskPortalUrl.length() > 0) {
      replyRedirect(client, kioskPortalUrl);
    } else {
      replyRedirect(client, "http://printbit.local/admin/login");
    }
    client.stop();
    return;
  }

  if ((method == "POST" || method == "GET") && routePath == "/hopper/dispense") {
    String postedToken = getFormValue(body, "token");
    String postedCoins = getFormValue(body, "coins");
    String postedRequestId = getFormValue(body, "requestId");
    if (postedToken.length() == 0) postedToken = hopperTokenHeader;
    if (postedToken.length() == 0) postedToken = getQueryValue(query, "token");
    if (postedCoins.length() == 0) postedCoins = getQueryValue(query, "coins");
    if (postedRequestId.length() == 0) postedRequestId = getQueryValue(query, "requestId");

    postedToken.trim();
    if (postedToken.length() == 0 || postedToken != hopperControlToken) {
      // NOTE: never print the actual token value to Serial/logs — only length,
      // so a leaked/attached logger can't recover the real secret.
      Serial.print("hopper_dispense_rejected:unauthorized:got_len=");
      Serial.print(postedToken.length());
      Serial.print(":expected_len=");
      Serial.println(strlen(hopperControlToken));
      replyPlain(client, 401, "Unauthorized", "Invalid hopper token");
      client.stop();
      return;
    }
    if (!isNumericString(postedCoins)) {
      Serial.print("hopper_dispense_rejected:invalid_coins:raw=");
      Serial.println(postedCoins);
      replyPlain(client, 400, "Bad Request", "Missing or invalid coins");
      client.stop();
      return;
    }

    int coins = postedCoins.toInt();
    String requestId = postedRequestId.length() > 0 ? postedRequestId : buildHopperRequestId();
    if (!startDispense(coins, requestId, "http")) {
      replyPlain(client, 409, "Conflict", "Dispense busy or invalid");
      client.stop();
      return;
    }
    replyPlain(client, 202, "Accepted", "hopper_dispense_started");
    client.stop();
    return;
  }

  if (method == "GET" && routePath == "/hopper/status") {
    String providedToken = getQueryValue(query, "token");
    if (providedToken.length() == 0) providedToken = hopperTokenHeader;
    if (providedToken.length() == 0 || providedToken != hopperControlToken) {
      Serial.println("hopper_status_rejected:unauthorized");
      replyPlain(client, 401, "Unauthorized", "Invalid hopper token");
      client.stop();
      return;
    }
    int dispensedSnapshot = 0;
    noInterrupts();
    dispensedSnapshot = coinDispensed;
    interrupts();

    String response = "{";

    response += "\"dispensing\":";
    response += (dispensing || hopperManualOn) ? "true" : "false";

    response += ",\"targetCoins\":";
    response += String(targetCoins);

    response += ",\"dispensedCoins\":";
    response += String(dispensedSnapshot);

    response += ",\"activeRequestId\":\"";
    response += activeDispenseRequestId;

    response += "\",\"lastRequestId\":\"";
    response += lastDispenseRequestId;

    response += "\",\"lastOutcome\":\"";
    response += lastDispenseOutcome;

    response += "\",\"lastError\":\"";
    response += lastDispenseError;

    response += "\",\"hopperLow\":";
    response += (lastDispenseOutcome == "failed" && lastDispenseError == "MOTOR_TIMEOUT")
                  ? "true"
                  : "false";

    response += ",\"success\":";
    response += (!dispensing && lastDispenseOutcome == "done" && dispensedSnapshot >= targetCoins)
                  ? "true"
                  : "false";

    response += ",\"lastFinishedAtMs\":";
    response += String(lastDispenseFinishedAt);

    response += ",\"manualOn\":";
    response += hopperManualOn ? "true" : "false";
    response += ",\"dispenseAllMode\":";
    response += dispenseAllMode ? "true" : "false";

    response += "}";

    replyPlain(client, 200, "OK", response);
    client.stop();
    return;
  }

  if (method == "GET" && routePath == "/" && query.startsWith("coins=")) {
    int coins = getQueryValue(query, "coins").toInt();
    startDispense(coins, buildHopperRequestId(), "legacy_query");
  }

  if (routePath != "/") {
    Serial.print("http_request_unmatched:method=");
    Serial.print(method);
    Serial.print(":path=");
    Serial.println(path);
  }

  replyPlain(client, 200, "OK", "PRINTBIT OK");
  client.stop();
}

// INTERRUPTS
void IRAM_ATTR countPulse() {
  unsigned long nowMicros = micros();

  if (nowMicros - lastPulseMicros > debounceMicros) {
    if (pulseCount < pulseCountCap) {
      pulseCount++;
    } else {
      glitchPulseCount++;
    }
    lastPulseMicros = nowMicros;
    lastPulseMillis = millis();
  }
}

void IRAM_ATTR coinDetected() {
  unsigned long now = micros();

  if (now - lastCoinTime > hopperDebounce) {
    coinDispensed++;
    dispenseProgressDirty = true;
    lastCoinTime = now;

    if (dispensing && targetCoins > 0 && coinDispensed >= targetCoins) {
      digitalWrite(relayPin, LOW);
      dispensing = false;
      dispenseDone = true;
    }
  }
}

// DISPENSE
bool startDispense(
  int coins,
  const String& requestId,
  const String& sourceLabel) {
  if (dispensing) {
    emitHopperError(requestId, "UNKNOWN", "BUSY");
    return false;
  }
  if (coins <= 0 || coins > maxDispenseCoins) {
    emitHopperError(requestId, "UNKNOWN", "INVALID_COIN_COUNT");
    return false;
  }

  targetCoins = coins;
  dispenseAllMode = false;
  hopperManualOn = false;
  noInterrupts();
  coinDispensed = 0;
  dispenseProgressDirty = false;
  interrupts();
  dispensing = true;
  dispenseDone = false;
  dispenseTimedOut = false;
  hopperStartTime = millis();
  lastProgressReported = -1;
  activeDispenseRequestId = requestId.length() > 0 ? requestId : buildHopperRequestId();
  lastDispenseRequestId = activeDispenseRequestId;
  lastDispenseOutcome = "dispensing";
  lastDispenseError = "";

  digitalWrite(relayPin, HIGH);
  emitHopperAck(activeDispenseRequestId);

  Serial.print("hopper_start:requestId=");
  Serial.print(activeDispenseRequestId);
  Serial.print(":coins=");
  Serial.print(targetCoins);
  Serial.print(":source=");
  Serial.println(sourceLabel);
  return true;
}

void handleSerialCommand(const String& rawLine) {
  String line = rawLine;
  line.trim();
  if (line.length() == 0) return;

  if (line.startsWith("HOPPER ")) {
    int first = line.indexOf(' ');
    int second = line.indexOf(' ', first + 1);
    String verb = second > 0 ? line.substring(first + 1, second) : "";
    verb.toUpperCase();

    if (verb == "SELFTEST") {
      String requestId =
        second > 0 ? line.substring(second + 1) : buildHopperRequestId();
      requestId.trim();
      if (requestId.length() == 0) requestId = buildHopperRequestId();
      emitHopperAck(requestId);
      emitHopperDone(requestId, 0);
      return;
    }

    if (verb == "DISPENSE") {
      int third = line.indexOf(' ', second + 1);
      String requestId = third > 0 ? line.substring(second + 1, third) : "";
      String coinsRaw = third > 0 ? line.substring(third + 1) : "";
      requestId.trim();
      coinsRaw.trim();
      if (requestId.length() == 0) requestId = buildHopperRequestId();
      if (!isNumericString(coinsRaw)) {
        emitHopperError(requestId, "UNKNOWN", "INVALID_COIN_COUNT");
        return;
      }

      int coins = coinsRaw.toInt();
      startDispense(coins, requestId, "serial_protocol");
      return;
    }

    Serial.print("serial_command_error:unsupported_verb:");
    Serial.println(verb);
    emitHopperError(buildHopperRequestId(), "UNKNOWN", "UNSUPPORTED_COMMAND");
    return;
  }

  if (isNumericString(line)) {
    int command = line.toInt();
    if (command > 0 && command <= maxDispenseCoins) {
      startDispense(command, buildHopperRequestId(), "serial_legacy");
    } else {
      Serial.print("serial_command_error:coin_count_out_of_range:");
      Serial.println(command);
    }
    return;
  }

  Serial.print("serial_command_error:unrecognized_line:");
  Serial.println(line);
}

// SETUP
void setup() {
  pinMode(coinAcceptorPin, INPUT_PULLUP);
  pinMode(hopperSensorPin, INPUT);
  pinMode(relayPin, OUTPUT);

  digitalWrite(relayPin, LOW);

  Serial.begin(115200);
  setenv("TZ", "PHT-8", 1);
  tzset();

  checkPhysicalCredentialRecovery();

  attachInterrupt(coinAcceptorPin, countPulse, FALLING);
  attachInterrupt(hopperSensorPin, coinDetected, FALLING);

  refreshTargets();

  WiFi.onEvent([](WiFiEvent_t event) {
    if (event == ARDUINO_EVENT_WIFI_AP_STACONNECTED) {
      Serial.println("wifi_ap_event:station_connected");
    } else if (event == ARDUINO_EVENT_WIFI_AP_STADISCONNECTED) {
      Serial.println("wifi_ap_event:station_disconnected");
      // A registered tablet is only considered registered while that same
      // device remains connected to the PrintBit AP.
      if (hasKioskRegistration && kioskMac.length() > 0) {
        wifi_sta_list_t stationList;
        memset(&stationList, 0, sizeof(stationList));
        bool stillConnected = false;
        if (esp_wifi_ap_get_sta_list(&stationList) == ESP_OK) {
          for (int i = 0; i < stationList.num; i++) {
            if (stationMacToString(stationList.sta[i].mac) == kioskMac) {
              stillConnected = true;
              break;
            }
          }
        }
        if (!stillConnected) {
          hasKioskRegistration = false;
          kioskMac = "";
          kioskIp = "";
          kioskPortalUrl = "";
          tabletServer = "";
          addAdminEvent("Tablet disconnected; registration cleared");
        }
      }
    }
  });

  loadApCredentials();
  loadAdminCredentials();
  WiFi.mode(WIFI_AP);

  if (!WiFi.softAP(apSsid.c_str(), apPasswordEnabled ? apPassword.c_str() : nullptr, 1, 0)) {
    Serial.println("wifi_ap_error:softAP_start_failed");
  }

  Serial.println("AP Started");

  if (MDNS.begin("printbit")) {
    MDNS.addService("http", "tcp", 80);
    Serial.println("MDNS:http://printbit.local");
  } else {
    Serial.println("mdns_error:start_failed");
  }

  Serial.print("AP_SSID:");
  Serial.println(apSsid);
  Serial.print("AP_PASSWORD:");
  Serial.println(apPasswordEnabled ? "enabled" : "disabled");
  Serial.print("AP_IP:");
  Serial.println(WiFi.softAPIP());
  Serial.println("tablet_target:waiting_for_registration");
  Serial.println("portal_target:waiting_for_registration");

  adminSessionToken = makeAdminSessionToken();
  server.begin();
  addAdminEvent("ESP32 controller booted");

  Serial.println("ADMIN:http://192.168.4.1/admin");
  Serial.print("ADMIN_USERNAME:");
  Serial.println(adminUsername);
  Serial.println("ADMIN_AUTH:Authorization Bearer session header");

  minFreeHeapSeen = ESP.getFreeHeap();
  Serial.println("k kDY");
}

// LOOP
void loop() {
  uint16_t tempCount;
  unsigned long tempLastPulse;
  uint16_t tempGlitchCount;

  noInterrupts();
  tempCount = pulseCount;
  tempLastPulse = lastPulseMillis;
  tempGlitchCount = glitchPulseCount;
  interrupts();

  if (coinTestMode && millis() - coinTestStartedAt > 300000UL) {
    coinTestMode = false;
    addAdminEvent("Coin test auto-stopped after 5 minutes");
  }

  if (tempCount > 0 && millis() - tempLastPulse > coinTimeout) {
    int value = 0;
    if (tempCount == 1) value = 1;
    else if (tempCount == 3) value = 5;
    else if (tempCount == 5) value = 10;
    else if (tempCount == 7) value = 20;

    unsigned long pulseDurationMs = tempLastPulse > 0 ? (millis() - tempLastPulse) : 0;
    lastCoinDetectedAt = millis();
    lastCoinPulseCount = tempCount;
    lastCoinPulseGlitchCount = tempGlitchCount;
    lastCoinPulseDurationMs = pulseDurationMs;
    if (value > 0) {
      lastCoinValue = value;
      coinAcceptedCount++;
      Serial.print("coin_pulse:");
      Serial.println(value);
      if (coinTestMode) {
        coinTestCount++;
        addAdminEvent(String("Coin test detected: P") + String(value));
      } else {
        sendCoinToTablet(value);
      }
    } else if (tempCount >= pulseCountCap || tempGlitchCount > 0) {
      coinInvalidCount++;
      addAdminError("Coin pulse train saturated");
      Serial.print("coin_pulse_error:pulse_train_saturated:count=");
      Serial.print(tempCount);
      Serial.print(":overflow=");
      Serial.println(tempGlitchCount);
    } else {
      coinInvalidCount++;
      addAdminError("Unrecognized coin pulse count");
      Serial.print("coin_pulse_error:unrecognized_pulse_count:");
      Serial.println(tempCount);
    }

    noInterrupts();
    pulseCount = 0;
    glitchPulseCount = 0;
    interrupts();
  }

  // SERIAL COMMAND
  while (Serial.available()) {
    char c = char(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      handleSerialCommand(serialLineBuffer);
      serialLineBuffer = "";
      continue;
    }
    if (serialLineBuffer.length() < 120) {
      serialLineBuffer += c;
    } else {
      Serial.println("serial_command_error:line_too_long_truncated");
    }
  }

  // Enforce short disconnect windows so auto-reconnecting clients are kicked again.
  enforceTemporaryDisconnectBlocks();
  enforceDeviceAccessPolicy();

  // WIFI REQUEST
  NetworkClient client = server.accept();
  if (client) {
    handleWifiRequest(client);
  }

  int dispensedSnapshot = 0;
  bool progressDirtySnapshot = false;
  noInterrupts();
  dispensedSnapshot = coinDispensed;
  progressDirtySnapshot = dispenseProgressDirty;
  dispenseProgressDirty = false;
  interrupts();

  if (dispensing && progressDirtySnapshot && dispensedSnapshot != lastProgressReported) {
    lastProgressReported = dispensedSnapshot;
    emitHopperProgress(activeDispenseRequestId, dispensedSnapshot, targetCoins);
  }

  // HOPPER TIMEOUT
  if ((dispensing || hopperManualOn) && millis() - hopperStartTime > hopperMaxRunTime) {
    digitalWrite(relayPin, LOW);
    dispensing = false;
    dispenseAllMode = false;
    hopperManualOn = false;
    dispenseTimedOut = true;
  }

  if (dispenseTimedOut) {
    dispenseTimedOut = false;
    lastDispenseOutcome = "failed";
    lastDispenseError = "MOTOR_TIMEOUT";
    addAdminError("Hopper motor timeout");
    lastDispenseFinishedAt = millis();
    emitHopperError(activeDispenseRequestId, "MOTOR_TIMEOUT", "timeout");
    Serial.print("hopper_done:requestId=");
    Serial.print(activeDispenseRequestId);
    Serial.println(":outcome=failed");
    activeDispenseRequestId = "";
  }

  if (dispenseDone) {
    dispenseDone = false;
    dispenseAllMode = false;
    hopperManualOn = false;
    lastDispenseOutcome = "done";
    lastDispenseError = "";
    lastDispenseFinishedAt = millis();
    emitHopperDone(activeDispenseRequestId, dispensedSnapshot);
    Serial.print("hopper_done:requestId=");
    Serial.print(lastDispenseRequestId);
    Serial.print(":dispensed=");
    Serial.println(dispensedSnapshot);
    activeDispenseRequestId = "";
  }

  static unsigned long lastRegistrationStatusAt = 0;
  if (!hasKioskRegistration && millis() - lastRegistrationStatusAt > 15000) {
    lastRegistrationStatusAt = millis();
    Serial.println("kiosk_register_pending:waiting_for_post");
  }

  // HEAP HEALTH
  if (millis() - lastHeapCheckAt > heapCheckIntervalMs) {
    lastHeapCheckAt = millis();
    uint32_t freeHeap = ESP.getFreeHeap();
    if (freeHeap < minFreeHeapSeen) minFreeHeapSeen = freeHeap;
    if (freeHeap < lowHeapWarnThreshold) {
      Serial.print("system_warning:low_heap:free=");
      Serial.print(freeHeap);
      Serial.print(":min_seen=");
      Serial.println(minFreeHeapSeen);
    }
  }
}
