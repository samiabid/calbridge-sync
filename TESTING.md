# Testing Guide

## Manual Testing Checklist

### 1. Authentication Flow ✓

**Test Login**
```
1. Go to homepage (/)
2. Click "Connect with Google"
3. Select Google account
4. Grant calendar permissions
5. Verify redirect to /dashboard
6. Confirm email displayed in header
```

**Test Logout**
```
1. Click "Logout" button
2. Verify redirect to homepage
3. Try accessing /dashboard (should redirect to /)
```

### 2. Calendar Sync Creation ✓

**Test Basic Sync**
```
1. Login to dashboard
2. Click "Create New Sync"
3. Select source calendar
4. Select different target calendar
5. Leave "Two-way sync" checked
6. Click "Create Sync"
7. Verify sync appears in list
8. Check sync status shows "Active"
```

**Test One-Way Sync**
```
1. Create new sync
2. Uncheck "Two-way sync"
3. Complete creation
4. Verify badge shows "One-way sync"
```

### 3. Event Filtering ✓

**Test Keyword Filtering**
```
1. Create new sync
2. In "Exclude Keywords" field:
   - Type "Personal" and press Enter
   - Type "Private" and press Enter
3. Verify tags appear
4. Click × on one tag to remove
5. Create sync
6. Create test event with "Personal" in title
7. Verify it doesn't sync
8. Create event without keyword
9. Verify it DOES sync
```

**Test Color Filtering**
```
1. Create new sync
2. Click on color options (e.g., "Graphite", "Tomato")
3. Verify selected colors highlight
4. Create sync
5. Create event with filtered color
6. Verify it doesn't sync
7. Create event with different color
8. Verify it DOES sync
```

### 4. Event Synchronization ✓

**Test Initial Sync**
```
1. In Google Calendar, create 3 events in source calendar
2. Create sync in app
3. Wait 10 seconds
4. Check target calendar - all 3 events should appear
```

**Test Real-Time Sync (Create)**
```
1. With active sync, create new event in source calendar
2. Wait 5-10 seconds
3. Check target calendar - event should appear
```

**Test Real-Time Sync (Update)**
```
1. Update an existing synced event (change time/title)
2. Wait 5-10 seconds
3. Check target calendar - changes should reflect
```

**Test Real-Time Sync (Delete)**
```
1. Delete a synced event from source calendar
2. Wait 5-10 seconds
3. Check target calendar - event should be deleted
```

**Test Two-Way Sync**
```
1. Create two-way sync
2. Create event in Calendar A → should appear in B
3. Create event in Calendar B → should appear in A
4. Update event in B → changes appear in A
5. Delete event from A → deleted from B
```

### 5. Loop Prevention ✓

**Test No Infinite Loops**
```
1. Create two-way sync between Calendar A & B
2. Create event in Calendar A
3. Event syncs to Calendar B (check logs)
4. Verify synced event in B doesn't trigger sync back to A
5. Check logs for "Skip events that were created by sync"
```

### 6. Webhook Functionality ✓

**Test Webhook Setup**
```
1. Create sync
2. Check Railway logs for:
   - "Webhook setup for source calendar"
   - "Webhook setup for target calendar" (if two-way)
3. Verify no errors
```

**Test Webhook Notifications**
```
1. With active sync, create event in Google Calendar
2. Check Railway logs for:
   - "Webhook received"
   - "Processing webhook for sync [id]"
   - "Created synced event" or "Updated event"
```

### 7. Multiple Syncs ✓

**Test Multiple Syncs**
```
1. Create sync: Calendar A → Calendar B
2. Create sync: Calendar B → Calendar C
3. Create sync: Calendar C → Calendar A
4. Create event in Calendar A
5. Verify it syncs correctly without loops
```

### 8. Edge Cases ✓

**Test Same Calendar**
```
1. Try to create sync from Calendar A to Calendar A
2. Should still work (for testing)
```

**Test Multiple Users**
```
1. Login with Account 1, create syncs
2. Logout
3. Login with Account 2
4. Verify no access to Account 1's syncs
```

**Test Deleted Calendar**
```
1. Create sync
2. Delete source calendar in Google
3. Verify sync shows error or handles gracefully
```

---

## Automated Testing (Future)

### Unit Tests

Create `tests/services/sync.test.ts`:
```typescript
import { shouldSkipEvent } from '../src/services/sync';

describe('Event Filtering', () => {
  test('filters events with excluded colors', () => {
    const event = { colorId: '1' };
    const excluded = ['1', '2'];
    expect(shouldSkipEvent(event, excluded, [])).toBe(true);
  });

  test('filters events with excluded keywords', () => {
    const event = { summary: 'Personal Meeting' };
    const excluded = ['personal'];
    expect(shouldSkipEvent(event, [], excluded)).toBe(true);
  });
});
```

### Integration Tests

Create `tests/integration/sync.test.ts`:
```typescript
import request from 'supertest';
import app from '../src/server';

describe('Sync API', () => {
  test('GET /sync requires authentication', async () => {
    const response = await request(app).get('/sync');
    expect(response.status).toBe(302); // Redirect to login
  });

  test('POST /sync creates sync', async () => {
    // Mock authenticated session
    const response = await request(app)
      .post('/sync')
      .send({
        sourceCalendarId: 'cal1',
        targetCalendarId: 'cal2',
        isTwoWay: true,
      });
    expect(response.status).toBe(200);
  });
});
```

---

## Load Testing

### Test Webhook Performance

```bash
# Install Apache Bench
brew install ab

# Test webhook endpoint
ab -n 1000 -c 10 https://your-app.railway.app/webhook/google
```

### Test Concurrent Syncs

```javascript
// tests/load/concurrent-syncs.js
const axios = require('axios');

async function createManyEvents() {
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(
      axios.post('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        summary: `Test Event ${i}`,
        start: { dateTime: '2026-02-10T10:00:00Z' },
        end: { dateTime: '2026-02-10T11:00:00Z' },
      })
    );
  }
  await Promise.all(promises);
}
```

---

## Debugging Tips

### Enable Verbose Logging

Add to `.env`:
```env
DEBUG=true
LOG_LEVEL=verbose
```

### Check Webhook Status

```bash
# Railway CLI
railway logs --tail

# Filter for webhook events
railway logs | grep "Webhook"
```

### Database Inspection

```bash
# Open Prisma Studio
npm run db:studio

# Or use psql
railway run psql $DATABASE_URL
```

### Google Calendar API Debugging

1. Go to [Google Calendar API Playground](https://developers.google.com/calendar/api/v3/reference)
2. Test API calls directly
3. Check quota usage in Google Console

---

## Common Issues & Solutions

### Issue: Webhooks not triggering

**Symptoms**: Events created but not syncing  
**Check**:
- `PUBLIC_URL` is set to Railway URL (not localhost)
- Webhook setup succeeded (check logs)
- Railway app is publicly accessible

**Solution**:
```bash
# Verify PUBLIC_URL
railway vars | grep PUBLIC_URL

# Check webhook in database
SELECT * FROM "Sync" WHERE "sourceChannelId" IS NOT NULL;
```

### Issue: Infinite loop

**Symptoms**: Same event syncing repeatedly  
**Check**:
- `extendedProperties.private.syncId` is set on synced events
- Loop detection in `shouldSkipEvent()` function

**Solution**: Check logs for "Skip events that were created by sync"

### Issue: Events not filtering

**Symptoms**: Filtered events still syncing  
**Check**:
- Color IDs match (1-11)
- Keywords are exact match (case-insensitive)
- Filters saved in database

**Solution**:
```bash
# Check sync filters
railway run npx prisma studio
# View Sync table, check excludedColors and excludedKeywords
```

### Issue: OAuth token expired

**Symptoms**: 401 errors in logs  
**Check**: Refresh token stored correctly

**Solution**:
- Logout and login again
- Verify `refresh_token` in User table

---

## Performance Benchmarks

**Expected Performance:**
- Initial sync (100 events): ~30-60 seconds
- Webhook notification processing: <5 seconds
- Real-time sync: 5-10 seconds
- API response times: <500ms

**Database Queries:**
- Get syncs: <50ms
- Create sync: <100ms
- Find synced event: <20ms (indexed)

---

## Security Testing

### Test Session Security
```bash
# Try accessing dashboard without session
curl https://your-app.railway.app/dashboard
# Should redirect to /

# Try CSRF
curl -X POST https://your-app.railway.app/sync
# Should fail without valid session
```

### Test OAuth Flow
1. Attempt to skip OAuth and go directly to /dashboard
2. Verify redirect to login
3. Test with invalid OAuth code
4. Verify error handling

---

## Monitoring in Production

### Key Metrics to Track

1. **Active Syncs**: `SELECT COUNT(*) FROM "Sync" WHERE "isActive" = true`
2. **Events Synced Today**: 
   ```sql
   SELECT COUNT(*) FROM "SyncedEvent" 
   WHERE "lastSyncedAt" > NOW() - INTERVAL '1 day'
   ```
3. **Webhook Health**: Check expiration dates
4. **Error Rate**: Count of error logs

### Set Up Alerts

**Railway Notifications:**
1. Go to project settings
2. Enable deployment notifications
3. Add webhook for error alerts

**Custom Monitoring:**
```javascript
// Add to src/server.ts
setInterval(async () => {
  const activeWebhooks = await prisma.sync.count({
    where: {
      isActive: true,
      sourceExpiration: { gt: new Date() }
    }
  });
  console.log(`Active webhooks: ${activeWebhooks}`);
}, 3600000); // Every hour
```

---

## Before Going Live

### Pre-Launch Checklist

- [ ] All environment variables set correctly
- [ ] Database schema pushed
- [ ] Google OAuth configured with production URL
- [ ] Test login/logout flow
- [ ] Create test sync and verify it works
- [ ] Check webhook setup succeeds
- [ ] Test event creation, update, deletion
- [ ] Verify filtering works
- [ ] Check logs for errors
- [ ] Test with multiple users
- [ ] Verify two-way sync works
- [ ] Confirm no infinite loops
- [ ] Load test with 10+ syncs
- [ ] Monitor memory and CPU usage
- [ ] Set up error notifications
- [ ] Document any known issues

### Post-Launch Monitoring

**First 24 Hours:**
- Check logs every 2 hours
- Monitor sync success rate
- Watch for webhook failures
- Track API quota usage

**First Week:**
- Daily log review
- User feedback collection
- Performance optimization
- Bug fixes as needed

**Ongoing:**
- Weekly database backup
- Monthly dependency updates
- Quarterly security review
- Regular performance checks

---

## Success Criteria

Your app is working correctly if:

✅ Users can authenticate with Google  
✅ Calendars load in dashboard  
✅ Syncs can be created and deleted  
✅ Events sync within 10 seconds  
✅ Filters work as expected  
✅ Two-way sync works without loops  
✅ Webhooks renew automatically  
✅ No crashes or memory leaks  
✅ Error handling is graceful  
✅ Logs are informative  

---

Congratulations! Your Calendar Sync app is ready for production! 🎉
