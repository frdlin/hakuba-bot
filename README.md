# Hakuba Bot — Multi-Channel AI Concierge

An AI concierge for [The 1/3rd Hakuba](https://1-3rd.com/), a villa rental in Hakuba, Nagano. It answers guest enquiries in Chinese, English, and Japanese across WhatsApp, LINE, and an embedded web widget, takes airport pickup bookings, and hands off to a human when it should.

Built and deployed solo — architecture, backend, admin panel, and knowledge base pipeline.

## Why

Guests arrive from Taiwan, Japan, and English-speaking countries, and they ask the same forty questions at all hours across three different messaging apps. Answering manually across time zones did not scale, and a scripted FAQ bot could not handle *"we land at Narita at 6pm on the 14th, can someone pick us up?"* — which is a question and a booking request at the same time.

## Stack

- **Node.js 20** (ESM, no framework)
- **Anthropic Claude API** — conversation and intent handling
- **Supabase / PostgreSQL** — conversations, FAQs, bookings
- **WhatsApp Cloud API** + **LINE Messaging API** + custom web widget
- **Notion API** — knowledge base authoring and sync
- **Render** — hosting (`render.yaml`)

## Architecture

```
src/
├── index.js              # HTTP entry, webhook routing
├── chat.js               # Claude conversation orchestration
├── system-prompt.js      # Persona, guardrails, language handling
├── knowledge.js          # Knowledge base retrieval
├── channels/
│   ├── whatsapp.js       # WhatsApp Cloud API adapter
│   └── line.js           # LINE Messaging API adapter
├── pickupBooking.js      # Airport pickup booking flow
├── availability.js       # Slot availability logic
├── webEscalation.js      # Human handoff
├── rateLimit.js          # Abuse protection
├── auth.js               # Admin authentication
├── db/                   # Supabase data access
│   ├── conversations.js
│   ├── dedupe.js         # Webhook idempotency
│   ├── faqs.js
│   └── pickupBookings.js
└── utils/
    ├── serviceHours.js   # Business hours (JST)
    └── timeSlots.js      # Booking slot generation
```

## Problems worth noting

**Webhook idempotency**
WhatsApp and LINE both retry webhooks when they do not get a fast enough acknowledgement. Without deduplication, a slow model response means the guest receives the same reply two or three times. `db/dedupe.js` records processed message IDs so retries are acknowledged and dropped.

**Channel abstraction**
WhatsApp and LINE differ in payload shape, media handling, and reply semantics. Each adapter normalises inbound messages into one internal format and translates outbound replies back, so conversation logic never branches on channel.

**Booking as conversation, not form**
Pickup requests arrive as free text mixed into ordinary chat. The booking flow extracts flight time and passenger count from the conversation, checks slot availability against service hours in JST, and confirms — without pushing the guest into a separate form.

**Knowing when to stop**
`webEscalation.js` hands the conversation to a human for anything involving pricing exceptions, complaints, or repeated failure to answer. A concierge bot that improvises on refund policy is worse than no bot at all.

**Knowledge base in Notion**
FAQ content is authored in Notion by non-technical staff and synced via `scripts/`, so updating an answer does not require a deploy.

## Local setup

```bash
cp .env.example .env    # fill in your own API keys
npm install
npm run dev
```

Requires Node 20.6+ (uses native `--env-file`).

## Security

- `.env` is git-ignored and has never been committed
- All credentials are read via `process.env`, never hard-coded
- `.env.example` documents required keys with placeholder values only

---

**Fred Lim** — WordPress Web Designer | Japan E-Commerce & Web Specialist
[LinkedIn](https://www.linkedin.com/in/frdlin/)
