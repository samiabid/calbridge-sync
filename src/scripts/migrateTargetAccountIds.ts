import { PrismaClient } from '@prisma/client';
import { getAuthenticatedCalendar } from '../services/calendar';

const prisma = new PrismaClient();

async function migrateTargetAccountIds() {
  console.log('Starting migration of targetGoogleAccountId...');

  // Find all syncs without targetGoogleAccountId
  const syncsToMigrate = await prisma.sync.findMany({
    where: {
      targetGoogleAccountId: null,
    },
    include: {
      user: true,
    },
  });

  console.log(`Found ${syncsToMigrate.length} syncs to migrate`);

  for (const sync of syncsToMigrate) {
    try {
      // Get all Google accounts for this user
      const accounts = await prisma.googleAccount.findMany({
        where: { userId: sync.userId },
        orderBy: { isPrimary: 'desc' }, // Try primary first
      });

      console.log(`\nProcessing sync ${sync.id} for user ${sync.userId}`);
      console.log(`Target calendar: ${sync.targetCalendarId}`);

      let foundAccountId: string | null = null;

      // Try each account to see which can access the target calendar
      for (const account of accounts) {
        try {
          console.log(`  Trying account ${account.displayName}...`);
          const calendar = await getAuthenticatedCalendar(sync.userId, account.id);

          // Try to get the calendar to verify access
          const calendarInfo = await calendar.calendars.get({
            calendarId: sync.targetCalendarId,
          });

          if (calendarInfo.data) {
            console.log(`  ✓ Found! Account ${account.displayName} can access this calendar`);
            foundAccountId = account.id;
            break;
          }
        } catch (error: any) {
          // Account doesn't have access, continue
          console.log(`  ✗ Cannot access with this account`);
          continue;
        }
      }

      if (foundAccountId) {
        // Update the sync with the found account ID
        await prisma.sync.update({
          where: { id: sync.id },
          data: { targetGoogleAccountId: foundAccountId },
        });
        console.log(`  Updated: targetGoogleAccountId = ${foundAccountId}`);
      } else {
        console.log(`  WARNING: Could not find account with access to target calendar`);
        // Fall back to primary account (same as googleAccountId)
        const primaryAccount = accounts.find((a) => a.isPrimary);
        if (primaryAccount) {
          await prisma.sync.update({
            where: { id: sync.id },
            data: { targetGoogleAccountId: primaryAccount.id },
          });
          console.log(`  Fallback: Using primary account ${primaryAccount.displayName}`);
        }
      }
    } catch (error) {
      console.error(`Error processing sync ${sync.id}:`, error);
    }
  }

  console.log('\nMigration complete!');
  await prisma.$disconnect();
}

migrateTargetAccountIds().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
