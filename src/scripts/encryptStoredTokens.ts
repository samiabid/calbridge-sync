import { PrismaClient } from '@prisma/client';
import {
  encryptToken,
  isEncryptedToken,
  isTokenEncryptionEnabled,
} from '../services/tokenCrypto';

const prisma = new PrismaClient();

async function encryptExistingTokens() {
  if (!isTokenEncryptionEnabled()) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be set before running token encryption migration'
    );
  }

  let usersUpdated = 0;
  let accountsUpdated = 0;

  const users = await prisma.user.findMany({
    select: { id: true, accessToken: true, refreshToken: true },
  });

  for (const user of users) {
    const nextAccessToken = isEncryptedToken(user.accessToken)
      ? user.accessToken
      : encryptToken(user.accessToken);
    const nextRefreshToken = isEncryptedToken(user.refreshToken)
      ? user.refreshToken
      : encryptToken(user.refreshToken);

    if (
      nextAccessToken !== user.accessToken ||
      nextRefreshToken !== user.refreshToken
    ) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          accessToken: nextAccessToken,
          refreshToken: nextRefreshToken,
        },
      });
      usersUpdated += 1;
    }
  }

  const accounts = await prisma.googleAccount.findMany({
    select: { id: true, accessToken: true, refreshToken: true },
  });

  for (const account of accounts) {
    const nextAccessToken = isEncryptedToken(account.accessToken)
      ? account.accessToken
      : encryptToken(account.accessToken);
    const nextRefreshToken = isEncryptedToken(account.refreshToken)
      ? account.refreshToken
      : encryptToken(account.refreshToken);

    if (
      nextAccessToken !== account.accessToken ||
      nextRefreshToken !== account.refreshToken
    ) {
      await prisma.googleAccount.update({
        where: { id: account.id },
        data: {
          accessToken: nextAccessToken,
          refreshToken: nextRefreshToken,
        },
      });
      accountsUpdated += 1;
    }
  }

  console.log(
    `Token encryption migration complete. Users updated: ${usersUpdated}, accounts updated: ${accountsUpdated}`
  );
}

encryptExistingTokens()
  .catch((error) => {
    console.error('Failed to encrypt existing tokens:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
