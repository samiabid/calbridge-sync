# 🚀 Railway Deployment Guide

Complete step-by-step guide to deploy your Calendar Sync app to Railway.

## Prerequisites

- GitHub account
- Railway account (sign up at [railway.app](https://railway.app))
- Google Cloud Console project

---

## Part 1: Google Cloud Setup (5 minutes)

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click on the project dropdown → "New Project"
3. Name it "Calendar Sync App"
4. Click "Create"

### 2. Enable Google Calendar API

1. In the left sidebar, go to "APIs & Services" → "Library"
2. Search for "Google Calendar API"
3. Click on it and press "Enable"

### 3. Create OAuth Credentials

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. Configure consent screen (if prompted):
   - User Type: External
   - App name: Calendar Sync App
   - User support email: your email
   - Developer contact: your email
   - Click "Save and Continue" through all screens
4. Back to Create OAuth client ID:
   - Application type: Web application
   - Name: Calendar Sync App
   - Authorized redirect URIs:
     - Add: `http://localhost:3000/auth/google/callback` (for testing)
     - We'll add Railway URL later
5. Click "Create"
6. **SAVE** your Client ID and Client Secret (you'll need these!)

---

## Part 2: Push to GitHub (2 minutes)

### 1. Initialize Git Repository

```bash
cd calendar-sync-app
git init
git add .
git commit -m "Initial commit: Calendar Sync App"
```

### 2. Create GitHub Repository

1. Go to [github.com](https://github.com)
2. Click "+" → "New repository"
3. Name: `calendar-sync-app`
4. Make it Private (recommended)
5. DON'T initialize with README (we already have one)
6. Click "Create repository"

### 3. Push to GitHub

```bash
# Replace YOUR_USERNAME with your GitHub username
git remote add origin https://github.com/YOUR_USERNAME/calendar-sync-app.git
git branch -M main
git push -u origin main
```

---

## Part 3: Deploy to Railway (5 minutes)

### 1. Create Railway Project

1. Go to [railway.app](https://railway.app)
2. Sign in with GitHub
3. Click "New Project"
4. Select "Deploy from GitHub repo"
5. Authorize Railway to access your repositories
6. Select `calendar-sync-app` repository

### 2. Bootstrap Railway Service (Recommended)

Railway deploy-from-GitHub does not auto-attach Postgres or auto-generate a public domain from repository config alone.

After your first deploy, run:

```bash
railway link -e production
npm run railway:bootstrap
```

This script will:
- create a `Postgres` service when missing
- set `DATABASE_URL=${{Postgres.DATABASE_URL}}`
- generate a public domain (prevents "unexposed service")
- set `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `NODE_ENV=production`, and `PUBLIC_URL`

### 3. Configure Google Environment Variables

1. Click on your web service (not the database)
2. Go to "Variables" tab
3. Click "Raw Editor"
4. Paste the following (replace with your actual values):

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=https://your-app.railway.app/auth/google/callback
```

4. Click "Update Variables"

### 4. Get Your Railway URL

1. Go to "Settings" tab in your web service
2. Scroll to "Domains"
3. Click "Generate Domain"
4. Copy the generated URL (e.g., `your-app.railway.app`)

### 5. Update OAuth Redirect URI if Needed

1. Go back to "Variables" tab
2. Update this variable with your actual Railway URL:
   - `GOOGLE_REDIRECT_URI=https://your-actual-url.railway.app/auth/google/callback`
3. Save changes

### 6. Trigger Deployment

1. Go to "Deployments" tab
2. Railway should auto-deploy, or click "Deploy"
3. Wait for build to complete (~2-3 minutes)

### 7. Expose Service Publicly

If you skipped the bootstrap script, do this manually:
1. Open your web service
2. Go to "Settings" → "Networking"
3. Click "Generate Domain"
4. Use this generated URL for browser access and OAuth redirect URL

---

## Part 4: Update Google OAuth (2 minutes)

### 1. Add Railway URL to Google Console

1. Go back to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to "APIs & Services" → "Credentials"
3. Click on your OAuth 2.0 Client ID
4. Under "Authorized redirect URIs", click "+ Add URI"
5. Add: `https://your-actual-url.railway.app/auth/google/callback`
6. Click "Save"

---

## Part 5: Initialize Database (1 minute)

Railway needs to run Prisma migrations. You have two options:

### Option A: Add Build Command (Recommended)

1. In Railway, go to your web service
2. Go to "Settings" tab
3. Scroll to "Build Settings"
4. Add this to "Build Command":
   ```
   npm run db:generate && npm run db:push && npm run build
   ```
5. Save and redeploy

### Option B: Use Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to your project
railway link

# Run migration
railway run npm run db:push
```

---

## Part 6: Test Your Deployment 🎉

1. Open your Railway URL in a browser
2. Click "Connect with Google"
3. Authorize the app
4. You should see the dashboard!
5. Try creating a sync between two calendars

---

## Monitoring & Logs

### View Logs

1. In Railway project, click on your web service
2. Go to "Deployments" tab
3. Click on latest deployment
4. View logs in real-time

### Check Webhook Status

- Webhooks are automatically set up when you create a sync
- They're renewed daily by a cron job
- Check logs for webhook-related messages

---

## Cost Estimation

**Railway Pricing:**
- **Free Tier**: $5 credit/month + 500 hours
- **Hobby Plan**: $5/month for unlimited hours
- **Database**: Included in plan

**Your app will use approximately:**
- 720 hours/month (always running)
- ~100 MB memory
- Minimal CPU

**Total**: Should fit in Hobby plan (~$5/month)

---

## Troubleshooting

### Build Fails

**Error**: `MODULE_NOT_FOUND`
- Solution: Ensure all dependencies are in `package.json`
- Run: `railway run npm install`

**Error**: `Database connection failed`
- Solution: Check if PostgreSQL service is running
- Verify `DATABASE_URL` is set

### OAuth Errors

**Error**: `redirect_uri_mismatch`
- Solution: Double-check redirect URI in Google Console matches Railway URL exactly
- Include `/auth/google/callback` path

**Error**: `invalid_client`
- Solution: Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are correct

### Webhooks Not Working

**Error**: Events not syncing in real-time
- Solution: Verify `PUBLIC_URL` is set to Railway URL (not localhost)
- Check webhook logs in Railway console
- Webhooks require publicly accessible URL

### Database Issues

**Error**: `Table does not exist`
- Solution: Run `railway run npm run db:push`
- Or add build command as shown in Part 5

---

## Updating Your App

### Push Updates

```bash
git add .
git commit -m "Your update message"
git push
```

Railway automatically detects changes and redeploys!

### Environment Variable Changes

1. Update variables in Railway dashboard
2. No need to redeploy - changes apply immediately

---

## Security Checklist

✅ Environment variables are set in Railway (not in code)  
✅ `.env` file is in `.gitignore`  
✅ OAuth credentials are kept secret  
✅ PostgreSQL database is private to your Railway project  
✅ HTTPS is enforced (automatic with Railway)  
✅ Session secret is randomly generated  

---

## Backup & Restore

### Backup Database

```bash
# Install Railway CLI
railway login
railway link

# Backup
railway run pg_dump $DATABASE_URL > backup.sql
```

### Restore Database

```bash
railway run psql $DATABASE_URL < backup.sql
```

---

## Custom Domain (Optional)

1. In Railway, go to "Settings"
2. Scroll to "Domains"
3. Click "Custom Domain"
4. Follow instructions to configure DNS

---

## Need Help?

- **Railway Docs**: [docs.railway.app](https://docs.railway.app)
- **Google Calendar API**: [developers.google.com/calendar](https://developers.google.com/calendar)
- **Check Logs**: Always check Railway logs first

---

## Success! 🎉

Your Calendar Sync app is now live and saving you money on subscriptions!

**Share with friends** who also juggle multiple calendars! 👥

---

**Next Steps:**
1. Set up your first sync
2. Test with a few events
3. Monitor logs for any issues
4. Enjoy automated calendar syncing!
