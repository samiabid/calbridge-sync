#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="${1:-twoway-calsync}"
ENV_NAME="${2:-production}"
DB_SERVICE_NAME="Postgres"

if ! command -v railway >/dev/null 2>&1; then
  echo "Railway CLI is required. Install with: npm i -g @railway/cli"
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate secrets."
  exit 1
fi

echo "Checking linked Railway project..."
railway status >/dev/null

echo "Ensuring ${DB_SERVICE_NAME} service exists..."
if railway service status --all | rg -q "^${DB_SERVICE_NAME}[[:space:]]+\\|"; then
  echo "${DB_SERVICE_NAME} already exists."
else
  railway add --database postgres -s "${DB_SERVICE_NAME}" --json >/dev/null
  echo "${DB_SERVICE_NAME} created."
fi

echo "Generating or confirming public domain for ${SERVICE_NAME}..."
DOMAIN_OUTPUT="$(railway domain -s "${SERVICE_NAME}" || true)"
PUBLIC_URL="$(printf '%s\n' "${DOMAIN_OUTPUT}" | rg -o "https://[^[:space:]]+" | tail -n 1 || true)"

if [[ -z "${PUBLIC_URL}" ]]; then
  DOMAIN_VALUE="$(railway variable list -s "${SERVICE_NAME}" -e "${ENV_NAME}" -k | sed -n 's/^RAILWAY_PUBLIC_DOMAIN=//p' | head -n 1)"
  if [[ -n "${DOMAIN_VALUE}" ]]; then
    PUBLIC_URL="https://${DOMAIN_VALUE}"
  fi
fi

if [[ -z "${PUBLIC_URL}" ]]; then
  echo "Could not determine PUBLIC_URL for ${SERVICE_NAME}."
  exit 1
fi

SESSION_SECRET="$(openssl rand -hex 32)"
TOKEN_ENCRYPTION_KEY="$(openssl rand -hex 32)"

echo "Setting production variables on ${SERVICE_NAME} (${ENV_NAME})..."
railway variable set -s "${SERVICE_NAME}" -e "${ENV_NAME}" \
  "DATABASE_URL=\${{${DB_SERVICE_NAME}.DATABASE_URL}}" \
  "SESSION_SECRET=${SESSION_SECRET}" \
  "TOKEN_ENCRYPTION_KEY=${TOKEN_ENCRYPTION_KEY}" \
  "NODE_ENV=production" \
  "PUBLIC_URL=${PUBLIC_URL}" >/dev/null

echo "Bootstrap complete."
echo "PUBLIC_URL=${PUBLIC_URL}"
echo "Next: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then set/update GOOGLE_REDIRECT_URI=${PUBLIC_URL}/auth/google/callback"
