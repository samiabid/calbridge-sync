const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const migrationsDir = path.join(process.cwd(), 'prisma', 'app-migrations');

function checksum(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function run() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_AppMigration" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "appliedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  if (!fs.existsSync(migrationsDir)) return;
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const digest = checksum(sql);
    const existing = await prisma.appMigration.findUnique({ where: { id: file } });
    if (existing) {
      if (existing.checksum !== digest) {
        throw new Error(`Applied migration ${file} has changed`);
      }
      continue;
    }

    const statements = sql
      .split('-- migrate:split')
      .map((statement) => statement.trim())
      .filter(Boolean);
    await prisma.$transaction(async (tx) => {
      for (const statement of statements) {
        await tx.$executeRawUnsafe(statement);
      }
      await tx.appMigration.create({ data: { id: file, checksum: digest } });
    });
    console.log(`Applied app migration ${file}`);
  }
}

run()
  .catch((error) => {
    console.error('App migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
