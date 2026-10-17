#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project}"
service="${SERVICE_NAME:-email-auto-labeller}"
region="${REGION:-us-central1}"
release="$(git rev-parse HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Commit source changes before deploying so RELEASE_SHA identifies the build.' >&2
  exit 1
fi
# Bootstrap the service, IAM, environment and secret bindings separately first.
gcloud run services describe "$service" --project="$PROJECT_ID" --region="$region" --format='value(metadata.name)' >/dev/null
updates="RELEASE_SHA=$release"

gcloud run deploy "$service" --source=. --project="$PROJECT_ID" --region="$region" \
  --update-env-vars="$updates" --quiet
