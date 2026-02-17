import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { setupWebhook } from './webhook';

const prisma = new PrismaClient();

export function setupWebhookRenewal() {
  // Run every day at 2 AM
  cron.schedule('0 2 * * *', async () => {
    console.log('Running webhook renewal check...');

    try {
      // Find syncs with webhooks expiring in the next 2 days
      const expiringDate = new Date();
      expiringDate.setDate(expiringDate.getDate() + 2);

      const syncs = await prisma.sync.findMany({
        where: {
          isActive: true,
          OR: [
            {
              sourceExpiration: {
                lte: expiringDate,
              },
            },
            {
              targetExpiration: {
                lte: expiringDate,
              },
            },
          ],
        },
      });

      console.log(`Found ${syncs.length} syncs with expiring webhooks`);

      for (const sync of syncs) {
        try {
          // Renew source webhook
          if (sync.sourceExpiration && sync.sourceExpiration <= expiringDate) {
            console.log(`Renewing source webhook for sync ${sync.id}`);
            await setupWebhook(
              sync.id,
              sync.userId,
              sync.sourceGoogleAccountId || sync.googleAccountId,
              sync.sourceCalendarId,
              'source'
            );
          }

          // Renew target webhook if two-way sync
          if (
            sync.isTwoWay &&
            sync.targetExpiration &&
            sync.targetExpiration <= expiringDate
          ) {
            console.log(`Renewing target webhook for sync ${sync.id}`);
            await setupWebhook(
              sync.id,
              sync.userId,
              sync.targetGoogleAccountId || sync.googleAccountId,
              sync.targetCalendarId,
              'target'
            );
          }
        } catch (error) {
          console.error(`Error renewing webhooks for sync ${sync.id}:`, error);
        }
      }

      console.log('Webhook renewal check completed');
    } catch (error) {
      console.error('Error in webhook renewal cron job:', error);
    }
  });

  console.log('📡 Webhook renewal cron job scheduled (daily at 2 AM)');
}
