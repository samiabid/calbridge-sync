#!/bin/bash

# Script to run Prisma migrations on Railway
# Make sure you have Railway CLI installed: npm i -g @railway/cli

echo "🚂 Running Prisma migration on Railway..."
echo ""

# Check if railway CLI is installed
if ! command -v railway &> /dev/null
then
    echo "❌ Railway CLI not found. Install it with:"
    echo "   npm i -g @railway/cli"
    echo ""
    exit 1
fi

# Run the migration
echo "Running db:push on Railway..."
railway run npm run db:push

echo ""
echo "Generating Prisma client..."
railway run npm run db:generate

echo ""
echo "✅ Migration complete! Now restart your Railway service:"
echo "   railway service restart"
echo ""
