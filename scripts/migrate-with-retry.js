const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const maxAttempts = parseInt(process.env.DB_MIGRATE_MAX_ATTEMPTS || '12', 10);
const delayMs = parseInt(process.env.DB_MIGRATE_DELAY_MS || '5000', 10);
// Per-attempt timeout: a hung db push otherwise blocks the deploy forever.
const attemptTimeoutMs = parseInt(process.env.DB_MIGRATE_ATTEMPT_TIMEOUT_MS || '120000', 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const migrationsDir = path.join(process.cwd(), 'prisma', 'migrations');
  const hasMigrationFiles =
    fs.existsSync(migrationsDir) &&
    fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .some((entry) => entry.isDirectory() || entry.name.endsWith('.sql'));

  const prismaCommand = hasMigrationFiles
    ? ['migrate', 'deploy']
    : ['db', 'push', '--skip-generate'];

  if (!hasMigrationFiles) {
    console.log('No prisma/migrations found. Using "prisma db push" to bootstrap schema.');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.log(`DB migrate attempt ${attempt}/${maxAttempts}...`);
      execFileSync(
        './node_modules/.bin/prisma',
        prismaCommand,
        { stdio: 'inherit', timeout: attemptTimeoutMs, killSignal: 'SIGKILL' }
      );
      execFileSync(
        process.execPath,
        ['scripts/run-app-migrations.js'],
        { stdio: 'inherit', timeout: attemptTimeoutMs, killSignal: 'SIGKILL' }
      );
      console.log('DB migrate succeeded.');
      return;
    } catch (error) {
      console.error(`DB migrate failed (attempt ${attempt}).`);
      if (attempt === maxAttempts) {
        console.error('DB migrate exhausted retries. Exiting.');
        process.exit(1);
      }
      await sleep(delayMs);
    }
  }
}

run().catch((error) => {
  console.error('DB migrate runner failed:', error);
  process.exit(1);
});
