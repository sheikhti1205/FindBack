# Development Guide

## Setup

```bash
# Clone the repository
git clone https://github.com/sheikhti1205/FindBack.git
cd FindBack

# Install dependencies
npm install

# Start development server
npm run dev
```

## Stack

- **Frontend:** React + TypeScript + Vite
- **Mobile:** Capacitor + Android (Kotlin)
- **Backend:** Supabase (PostgreSQL + Edge Functions)
- **AI:** Local models (Qwen, SmolVLM2) + cloud (OpenRouter)

## Repository Layout

```
apps/mobile/          # React + Capacitor mobile app
services/api/         # Node.js API server
supabase/             # Migrations, functions, config
docs/                 # Documentation
scripts/              # Build and utility scripts
```

## Checks

```bash
# Typecheck
npx tsc --noEmit -p apps/mobile/tsconfig.json

# Lint
npx eslint apps/mobile/src

# Tests
npx vitest run --maxWorkers=2

# Migration verification
node scripts/verify-migrations.mjs

# Link validation
node scripts/check-links.mjs docs
```