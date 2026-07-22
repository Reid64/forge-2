---
id: twilio
name: Twilio Integration Patterns
domain: telephony
tags: [twilio, telephony, sms, voice]
applicablePromptTypes: [api, feature, agent]
---

CLIENT INIT: Never initialize Twilio client in route handlers directly. Use a singleton getTwilioClient() from src/lib/twilio/client.ts that reads TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN from env. Throw descriptive error if env vars missing.

WEBHOOK VALIDATION: Every Twilio webhook route validates signature using twilio.validateRequest(authToken, signature, url, params). Return 403 if invalid. Never skip validation.

TWIML: Never hand-build TwiML strings. Use twilio.twiml.VoiceResponse() and twilio.twiml.MessagingResponse(). Always set Content-Type: text/xml on TwiML responses.

CALL FLOW: Every call has: initiate -> in-progress -> completed or failed lifecycle. Persist call SID immediately on initiation. Update status on every webhook. Never assume call completed without webhook confirmation.

ERROR RECOVERY: Twilio API calls wrapped in try/catch with exponential backoff retry (3 attempts, 1s/2s/4s delays). Log every failed attempt with error code and message.

PHONE NUMBERS: Always format E.164 (+1XXXXXXXXXX). Validate before any Twilio API call using libphonenumber-js.

STATUS CALLBACKS: Every outbound call and SMS registers status callback URL. Callback updates DB record. Never rely on polling for status.
