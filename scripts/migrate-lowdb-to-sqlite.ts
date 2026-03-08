import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const adapter = new PrismaLibSql({ url: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const raw = readFileSync('db.json', 'utf-8');
  const db = JSON.parse(raw);

  // KioskState
  await prisma.kioskState.upsert({
    where: { id: 1 },
    update: { balance: db.balance, earnings: db.earnings },
    create: { id: 1, balance: db.balance, earnings: db.earnings },
  });

  // CoinStats
  await prisma.coinStats.upsert({
    where: { id: 1 },
    update: {
      one: db.coinStats.one,
      five: db.coinStats.five,
      ten: db.coinStats.ten,
      twenty: db.coinStats.twenty,
    },
    create: { id: 1, ...db.coinStats },
  });

  // JobStats
  await prisma.jobStats.upsert({
    where: { id: 1 },
    update: {
      total: db.jobStats.total,
      print: db.jobStats.print,
      copy: db.jobStats.copy,
      scan: db.jobStats.scan,
    },
    create: { id: 1, ...db.jobStats },
  });

  // AdminSettings (flatten nested pricing)
  const s = db.settings;
  await prisma.adminSettings.upsert({
    where: { id: 1 },
    update: {
      printPerPage: s.pricing.printPerPage,
      copyPerPage: s.pricing.copyPerPage,
      scanDocument: s.pricing.scanDocument,
      colorSurcharge: s.pricing.colorSurcharge,
      idleTimeoutSeconds: s.idleTimeoutSeconds,
      adminPin: s.adminPin,
      adminLocalOnly: s.adminLocalOnly,
    },
    create: {
      id: 1,
      printPerPage: s.pricing.printPerPage,
      copyPerPage: s.pricing.copyPerPage,
      scanDocument: s.pricing.scanDocument,
      colorSurcharge: s.pricing.colorSurcharge,
      idleTimeoutSeconds: s.idleTimeoutSeconds,
      adminPin: s.adminPin,
      adminLocalOnly: s.adminLocalOnly,
    },
  });

  // HopperSettings
  const hs = db.hopperSettings;
  await prisma.hopperSettings.upsert({
    where: { id: 1 },
    update: hs,
    create: { id: 1, ...hs },
  });

  // HopperStats
  const hst = db.hopperStats;
  await prisma.hopperStats.upsert({
    where: { id: 1 },
    update: {
      ...hst,
      lastDispensedAt: hst.lastDispensedAt
        ? new Date(hst.lastDispensedAt)
        : null,
      lastSelfTestAt: hst.lastSelfTestAt ? new Date(hst.lastSelfTestAt) : null,
    },
    create: {
      id: 1,
      ...hst,
      lastDispensedAt: hst.lastDispensedAt
        ? new Date(hst.lastDispensedAt)
        : null,
      lastSelfTestAt: hst.lastSelfTestAt ? new Date(hst.lastSelfTestAt) : null,
    },
  });

  // OwedChanges
  for (const entry of db.owedChanges ?? []) {
    await prisma.owedChange.upsert({
      where: { id: entry.id },
      update: {},
      create: {
        id: entry.id,
        timestamp: new Date(entry.timestamp),
        amount: entry.amount,
        reason: entry.reason,
        status: entry.status,
        meta: entry.meta ? JSON.stringify(entry.meta) : null,
      },
    });
  }

  // Logs
  for (const log of db.logs ?? []) {
    await prisma.log.upsert({
      where: { id: log.id },
      update: {},
      create: {
        id: log.id,
        timestamp: new Date(log.timestamp),
        type: log.type,
        message: log.message,
        meta: log.meta ? JSON.stringify(log.meta) : null,
      },
    });
  }

  console.log('Migration complete.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
