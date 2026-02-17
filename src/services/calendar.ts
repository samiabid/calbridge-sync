import { PrismaClient } from '@prisma/client';
import { google } from 'googleapis';
import { createOAuth2Client } from '../config/google';
import { decryptToken } from './tokenCrypto';

const prisma = new PrismaClient();

function buildCalendarClient(accessToken: string, refreshToken: string) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: decryptToken(accessToken),
    refresh_token: decryptToken(refreshToken),
  });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

export async function getCalendarList(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  // Get all Google accounts for this user
  const googleAccounts = await prisma.googleAccount.findMany({
    where: { userId },
  });

  if (googleAccounts.length === 0) {
    throw new Error('No Google accounts connected');
  }

  const allCalendars: any[] = [];

  // Fetch calendars from each connected account
  for (const account of googleAccounts) {
    try {
      const calendar = buildCalendarClient(account.accessToken, account.refreshToken);
      const response = await calendar.calendarList.list();

      const calendars = response.data.items?.map((cal) => ({
        id: cal.id!,
        name: cal.summary!,
        primary: cal.primary || false,
        backgroundColor: cal.backgroundColor,
        account: account.displayName, // Add account identifier
        accountId: account.id, // Add account ID for sync creation
      })) || [];

      allCalendars.push(...calendars);
    } catch (error) {
      console.error(`Failed to fetch calendars for account ${account.displayName}:`, error);
      // Continue with other accounts
    }
  }

  return allCalendars;
}

export async function getAuthenticatedCalendar(userId: string, googleAccountId?: string) {
  if (googleAccountId) {
    const account = await prisma.googleAccount.findUnique({
      where: { id: googleAccountId },
    });
    if (!account || account.userId !== userId) {
      throw new Error('Google account not found');
    }

    return buildCalendarClient(account.accessToken, account.refreshToken);
  }

  const primaryAccount = await prisma.googleAccount.findFirst({
    where: { userId },
    orderBy: { isPrimary: 'desc' },
  });
  if (primaryAccount) {
    return buildCalendarClient(primaryAccount.accessToken, primaryAccount.refreshToken);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  return buildCalendarClient(user.accessToken, user.refreshToken);
}
