# Quick Reference

## Common Commands

### Development
```bash
npm run dev              # Start development server with hot reload
npm run build            # Build for production
npm start                # Start production server
npm run db:studio        # Open Prisma Studio (database GUI)
npm run db:push          # Push schema changes to database
npm run db:generate      # Generate Prisma Client
```

### Database
```bash
# View all syncs
railway run npm run db:studio

# Reset database (WARNING: Deletes all data)
railway run npx prisma migrate reset
```

## Environment Variables Quick Copy

```env
DATABASE_URL="postgresql://<db_user>:<db_password>@<db_host>:5432/<db_name>"
GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="your-client-secret"
GOOGLE_REDIRECT_URI="http://localhost:3000/auth/google/callback"
SESSION_SECRET="generate-random-32-char-string"
NODE_ENV="development"
PORT=3000
PUBLIC_URL="http://localhost:3000"
```

## Google Calendar Color IDs

| Color      | ID | Hex Code |
|------------|----|---------| 
| Lavender   | 1  | #7986cb |
| Sage       | 2  | #33b679 |
| Grape      | 3  | #8e24aa |
| Flamingo   | 4  | #e67c73 |
| Banana     | 5  | #f6c026 |
| Tangerine  | 6  | #f5511d |
| Peacock    | 7  | #039be5 |
| Graphite   | 8  | #616161 |
| Blueberry  | 9  | #3f51b5 |
| Basil      | 10 | #0b8043 |
| Tomato     | 11 | #d60000 |

## API Endpoints

### Authentication
- `GET /auth/google` - Login
- `GET /auth/google/callback` - OAuth callback
- `GET /auth/logout` - Logout

### Syncs
- `GET /sync` - List syncs
- `GET /sync/calendars` - Get calendars
- `POST /sync` - Create sync
- `DELETE /sync/:id` - Delete sync
- `PATCH /sync/:id/toggle` - Toggle active
- `PATCH /sync/:id/filters` - Update filters

### Dashboard
- `GET /dashboard` - Main dashboard

### Webhooks
- `POST /webhook/google` - Google notifications

## Database Schema

```prisma
User {
  id, email, accessToken, refreshToken
  syncs[]
}

Sync {
  id, userId, 
  sourceCalendarId, targetCalendarId,
  isTwoWay, isActive,
  excludedColors[], excludedKeywords[],
  webhook info, timestamps
  syncedEvents[]
}

SyncedEvent {
  id, syncId,
  sourceEventId, targetEventId,
  timestamps
}
```

## Useful SQL Queries

```sql
-- Count total syncs
SELECT COUNT(*) FROM "Sync";

-- Active syncs per user
SELECT u.email, COUNT(s.id) as sync_count
FROM "User" u
LEFT JOIN "Sync" s ON u.id = s."userId"
WHERE s."isActive" = true
GROUP BY u.email;

-- Recent synced events
SELECT * FROM "SyncedEvent"
ORDER BY "lastSyncedAt" DESC
LIMIT 10;
```

## Troubleshooting Quick Fixes

### Webhook not receiving notifications
```bash
# Check PUBLIC_URL is set correctly
echo $PUBLIC_URL

# Verify it's accessible
curl https://your-app.railway.app/webhook/google
```

### Database connection issues
```bash
# Test connection
railway run npx prisma db pull

# Regenerate client
npm run db:generate
```

### Events not syncing
1. Check sync is active
2. Verify filters aren't blocking
3. Check webhook expiration
4. View logs for errors

## Feature Flags & Config

Located in database `Sync` table:
- `isActive`: Enable/disable sync
- `isTwoWay`: Bi-directional sync
- `excludedColors`: Array of color IDs
- `excludedKeywords`: Array of strings

## Railway Specific

```bash
# Install CLI
npm install -g @railway/cli

# Login
railway login

# Link project
railway link

# View logs
railway logs

# Run command
railway run <command>

# Open dashboard
railway open
```

## Security Notes

- Never commit `.env` file
- Rotate `SESSION_SECRET` periodically
- Monitor Google API quotas
- Keep dependencies updated

## Performance Tips

- Webhooks expire in ~7 days (auto-renewed daily)
- Initial sync processes up to 100 events
- Database indexes on frequently queried fields
- Session cleanup runs automatically

## Backup Strategy

```bash
# Backup database
railway run pg_dump $DATABASE_URL > backup-$(date +%Y%m%d).sql

# Restore
railway run psql $DATABASE_URL < backup.sql
```

## Google API Limits

- **Calendar API**: 1,000,000 queries/day
- **Events.watch**: Max 7 days per webhook
- **Rate limit**: 5 requests/second/user

Your app should stay well under limits!

## Cost Optimization

- Use webhooks (not polling) for efficiency
- Limit initial sync to recent events
- Auto-renew webhooks to avoid re-setup
- Monitor Railway usage dashboard

## Monitoring

Watch these metrics:
- Active syncs count
- Events synced per day
- Webhook renewal success rate
- API error rates

Check logs for:
- `Webhook received`
- `Created synced event`
- `Updated event`
- `Error` messages
