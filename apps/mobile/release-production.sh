#!/usr/bin/env bash
set -e
npm run version:check
eas build --profile production --platform ios --auto-submit-with-profile=production --no-wait --non-interactive
eas build --profile production --platform android --auto-submit-with-profile=production --no-wait --non-interactive
