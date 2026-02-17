# Calendar Sync App - Project Structure

## Directory Structure

```
calendar-sync-app/
├── prisma/
│   └── schema.prisma          # Database schema
├── src/
│   ├── config/
│   │   └── google.ts          # Google OAuth configuration
│   ├── middleware/
│   │   └── auth.ts            # Authentication middleware
│   ├── routes/
│   │   ├── auth.ts            # Authentication routes
│   │   ├── dashboard.ts       # Dashboard routes
│   │   ├── sync.ts            # Sync management routes
│   │   └── webhook.ts         # Webhook handler
│   ├── services/
│   │   ├── calendar.ts        # Calendar API interactions
│   │   ├── sync.ts            # Sync logic and operations
│   │   ├── webhook.ts         # Webhook setup and handling
│   │   └── webhookRenewal.ts  # Automatic webhook renewal
│   ├── types/
│   │   └── express-session.d.ts # TypeScript definitions
│   └── server.ts              # Main application entry
├── views/
│   ├── index.ejs              # Landing page
│   └── dashboard.ejs          # Main dashboard UI
├── .env.example               # Environment variables template
├── .gitignore                 # Git ignore rules
├── DEPLOYMENT.md              # Deployment guide
├── package.json               # Dependencies and scripts
├── Procfile                   # Railway process definition
├── QUICK_REFERENCE.md         # Quick reference guide
├── railway.json               # Railway configuration
├── README.md                  # Main documentation
├── setup.sh                   # Setup automation script
└── tsconfig.json              # TypeScript configuration
```

## Key Components

### Backend Services

**calendar.ts**
- Fetches user's calendar list
- Authenticates Google Calendar API requests
- Manages OAuth token refresh

**sync.ts**
- Creates and manages sync configurations
- Performs initial event synchronization and bounded backfill
- Handles event updates and deletions
- Implements filtering logic (colors, keywords, RSVP/free-event options)
- Applies event copy settings (title/description/location/meeting links/privacy/reminders/identifier)
- Handles quota-aware retries and invalid_grant safeguards
- Prevents infinite sync loops

**webhook.ts**
- Sets up Google Calendar webhooks
- Processes webhook notifications
- Triggers event synchronization
- Handles webhook lifecycle

**webhookRenewal.ts**
- Cron job for automatic webhook renewal
- Runs daily to check expiring webhooks
- Prevents webhook expiration

### Routes

**auth.ts**
- Google OAuth flow
- Login/logout functionality
- Session management

**sync.ts**
- CRUD operations for syncs
- Calendar list retrieval
- Filter management
- Manual backfill rerun endpoint

**webhook.ts**
- Webhook endpoint for Google
- Processes change notifications

**dashboard.ts**
- Main UI rendering
- User-specific data

### Database

**User**
- Stores Google OAuth tokens
- Links to syncs

**Sync**
- Configuration for calendar pairs
- Filter settings
- Webhook metadata

**SyncedEvent**
- Tracks synced event pairs
- Prevents duplicates
- Enables updates/deletions

**Session**
- User authentication sessions
- Managed by express-session

## Data Flow

### Creating a Sync
```
User → Dashboard → POST /sync → Create Sync Record
  ↓
Setup Webhooks (source & target)
  ↓
Perform Initial Sync (new-only OR bounded backfill)
  ↓
Store Synced Events
```

### Webhook Event Flow
```
Google Calendar Event Changed
  ↓
Webhook Notification → POST /webhook/google
  ↓
Identify Sync by Channel ID
  ↓
Fetch Recent Events
  ↓
Apply Filters (colors, keywords, RSVP/free-event, loop detection)
  ↓
Sync to Target Calendar
  ↓
Update SyncedEvent Record
```

### Two-Way Sync
```
Calendar A Event → Webhook A → Sync to Calendar B
  ↓ (mark with syncId to prevent loop)
Calendar B receives synced event
  ↓ (detects syncId, ignores)
No infinite loop!
```

## Security Features

1. **OAuth Token Storage**: Encrypted in PostgreSQL
2. **Session Management**: Secure HTTP-only cookies
3. **CSRF Protection**: Session-based authentication
4. **Input Validation**: Filters and sanitization
5. **Loop Prevention**: Extended properties tracking
6. **Token Encryption at Rest**: Optional `TOKEN_ENCRYPTION_KEY` support
7. **Revoked Token Safeguard**: Auto-disable sync after repeated `invalid_grant` failures

## Performance Optimizations

1. **Webhooks**: Real-time updates (not polling)
2. **Database Indexes**: Fast event lookups
3. **Batch Operations**: Initial sync processes multiple events
4. **Caching**: OAuth client reuse
5. **Efficient Queries**: Prisma optimizations
6. **Rate-Limit Retry/Backoff**: Handles Google API 429/quota responses

## Scalability Considerations

- **Horizontal Scaling**: Stateless design supports multiple instances
- **Database**: PostgreSQL handles concurrent connections
- **Webhook Distribution**: Each sync has unique channel ID
- **Session Store**: PostgreSQL-backed sessions
- **API Rate Limits**: Google Calendar API has generous limits

## Technology Choices

### Why Node.js + Express?
- Simple, fast HTTP server
- Great Google API SDK support
- Easy Railway deployment

### Why PostgreSQL?
- Relational data (users → syncs → events)
- ACID compliance for data integrity
- Railway provides managed instance
- Great Prisma support

### Why Prisma?
- Type-safe database access
- Automatic migrations
- Great DX with TypeScript
- Relationship management

### Why EJS?
- Simple templating
- Server-side rendering
- No build step needed
- Progressive enhancement

### Why Railway?
- One-click PostgreSQL
- Automatic deployments
- Environment variable management
- Affordable pricing
- Great DX

## Development Workflow

1. **Local Development**
   - Run PostgreSQL locally or use Docker
   - Use `.env` for local configuration
   - `npm run dev` for hot-reload

2. **Testing**
   - Test OAuth flow locally
   - Create test syncs
   - Verify webhook setup (use ngrok for local webhooks)

3. **Deployment**
   - Push to GitHub
   - Railway auto-deploys
   - Monitor logs
   - Test production

## Maintenance

### Daily
- Webhook renewal cron runs automatically
- Check for any error logs

### Weekly
- Monitor Railway usage
- Check sync health

### Monthly
- Review and rotate SESSION_SECRET
- Update dependencies
- Check Google API quotas

## Future Enhancements

Potential features to add:
- [ ] Multiple calendar providers (Outlook, iCloud)
- [ ] Sync scheduling (specific time ranges)
- [ ] Event field mapping (customize what syncs)
- [ ] Sync analytics dashboard
- [ ] Email notifications for errors
- [ ] Bulk sync management
- [ ] API for programmatic access
- [ ] Mobile app
- [ ] Team/organization support
- [ ] Advanced filtering (regex, time-based)

## Contributing

If you want to extend this app:
1. Fork the repository
2. Create feature branch
3. Test thoroughly
4. Submit pull request

## License

MIT - Use and modify as needed!
