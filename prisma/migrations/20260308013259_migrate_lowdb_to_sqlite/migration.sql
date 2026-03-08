-- CreateTable
CREATE TABLE "KioskState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "earnings" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "CoinStats" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "one" INTEGER NOT NULL DEFAULT 0,
    "five" INTEGER NOT NULL DEFAULT 0,
    "ten" INTEGER NOT NULL DEFAULT 0,
    "twenty" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "JobStats" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "total" INTEGER NOT NULL DEFAULT 0,
    "print" INTEGER NOT NULL DEFAULT 0,
    "copy" INTEGER NOT NULL DEFAULT 0,
    "scan" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "AdminSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "printPerPage" INTEGER NOT NULL DEFAULT 5,
    "copyPerPage" INTEGER NOT NULL DEFAULT 3,
    "scanDocument" INTEGER NOT NULL DEFAULT 5,
    "colorSurcharge" INTEGER NOT NULL DEFAULT 2,
    "idleTimeoutSeconds" INTEGER NOT NULL DEFAULT 120,
    "adminPin" TEXT NOT NULL DEFAULT '1234',
    "adminLocalOnly" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "HopperSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "timeoutMs" INTEGER NOT NULL DEFAULT 8000,
    "retryCount" INTEGER NOT NULL DEFAULT 1,
    "dispenseCommandPrefix" TEXT NOT NULL DEFAULT 'HOPPER DISPENSE',
    "selfTestCommand" TEXT NOT NULL DEFAULT 'HOPPER SELFTEST'
);

-- CreateTable
CREATE TABLE "HopperStats" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "dispenseAttempts" INTEGER NOT NULL DEFAULT 0,
    "dispenseSuccess" INTEGER NOT NULL DEFAULT 0,
    "dispenseFailures" INTEGER NOT NULL DEFAULT 0,
    "totalDispensed" INTEGER NOT NULL DEFAULT 0,
    "lastDispensedAt" DATETIME,
    "lastError" TEXT,
    "selfTestPassed" BOOLEAN,
    "lastSelfTestAt" DATETIME
);

-- CreateTable
CREATE TABLE "Log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "meta" TEXT
);

-- CreateTable
CREATE TABLE "OwedChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "meta" TEXT
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "response" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UploadSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "uploadUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UploadFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "filePath" TEXT NOT NULL,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UploadFile_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "UploadSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScanDeliveryToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_token_key" ON "UploadSession"("token");

-- CreateIndex
CREATE UNIQUE INDEX "ScanDeliveryToken_token_key" ON "ScanDeliveryToken"("token");
