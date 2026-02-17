#!/bin/bash

echo "🚀 Calendar Sync App - Quick Setup Script"
echo "=========================================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

echo "✅ Node.js version: $(node --version)"
echo ""

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

echo "✅ npm version: $(npm --version)"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

echo "✅ Dependencies installed"
echo ""

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env file from template..."
    cp .env.example .env
    echo "✅ .env file created"
    echo ""
    echo "⚠️  IMPORTANT: Edit .env file and add your Google OAuth credentials"
    echo ""
else
    echo "ℹ️  .env file already exists"
    echo ""
fi

# Check if DATABASE_URL is set
if ! grep -q "^DATABASE_URL=" .env || grep -q "your-" .env; then
    echo "⚠️  WARNING: Please configure your .env file with:"
    echo "   1. DATABASE_URL (PostgreSQL connection string)"
    echo "   2. GOOGLE_CLIENT_ID"
    echo "   3. GOOGLE_CLIENT_SECRET"
    echo "   4. SESSION_SECRET (generate a random string)"
    echo ""
    echo "💡 Get Google OAuth credentials from: https://console.cloud.google.com/"
    echo ""
fi

# Setup database
echo "🗄️  Setting up database..."
echo "   (Make sure PostgreSQL is running and DATABASE_URL is configured)"
echo ""

read -p "Do you want to push the Prisma schema to the database now? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    npm run db:push
    
    if [ $? -eq 0 ]; then
        echo "✅ Database schema created successfully"
    else
        echo "⚠️  Database setup failed. You can run 'npm run db:push' manually later."
    fi
else
    echo "⏭️  Skipped database setup. Run 'npm run db:push' when ready."
fi

echo ""
echo "✨ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Configure .env file with your credentials"
echo "2. Set up Google OAuth in Google Cloud Console"
echo "3. Run 'npm run db:push' if you haven't already"
echo "4. Run 'npm run dev' to start the development server"
echo ""
echo "📚 See README.md for detailed instructions"
echo ""
