#!/usr/bin/env bash
set -euo pipefail

# One-time setup for Man Night Google Calendar write-back Service Account.
# Run after `gcloud auth login` with tyler.miranda@gmail.com.

PROJECT_ID="${1:-questly-b4e95}"
SA_NAME="man-night-cal"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
KEY_FILE="$(mktemp -t man-night-gcal-sa.XXXXXX.json)"
trap 'rm -f "$KEY_FILE"' EXIT

gcloud config set project "$PROJECT_ID" >/dev/null
gcloud services enable calendar-json.googleapis.com --project "$PROJECT_ID"

if ! gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Man Night Calendar Sync" \
    --project "$PROJECT_ID"
fi

gcloud iam service-accounts keys create "$KEY_FILE" \
  --iam-account="$SA_EMAIL" \
  --project "$PROJECT_ID"

PRIVATE_KEY=$(node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(j.private_key);" "$KEY_FILE")

printf '%s' "$SA_EMAIL" | npx wrangler secret put GCAL_SERVICE_ACCOUNT_EMAIL
printf '%s' "$PRIVATE_KEY" | npx wrangler secret put GCAL_PRIVATE_KEY

echo ""
echo "Done! Next one-click step in Google Calendar:"
echo "  Open Google Calendar -> Settings for 'Man Night' -> Share with specific people"
echo "  Add: ${SA_EMAIL}"
echo "  Permission: Make changes to events"
