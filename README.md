# Middleware

The entitlement/access-control layer between Nuxt and Strapi. Nuxt never talks
to Strapi directly, and never sees the payment gateway's secret keys — both
only exist here.

## The rule this encodes (`src/services/access.js`)

- **Today's edition** → requires an **active subscription**. Nothing else grants it.
- **Any archive date** → requires a **completed purchase for that exact date**.
  An active subscription does *not* unlock archive dates — by design, per spec.

Every request for a page image re-checks this (`GET /api/editions/:date/pages/:num.jpg`),
not just the initial edition metadata request — so a shared/bookmarked image
URL can't bypass the paywall.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/editions/:date` | optional | Edition metadata always; page images + story text only if entitled. `:date` is `YYYY-MM-DD` or the literal `today` |
| GET | `/api/editions/:date/pages/:num.jpg` | required (checked) | Streams one page image |
| GET | `/api/editions/me/purchased-dates` | optional | Dates the signed-in user has unlocked, for the Archive UI's lock badges |
| POST | `/api/pay/checkout` | required | Starts a checkout (subscription or one-off archive purchase) |
| POST | `/api/pay/webhook` | gateway-signed | Your payment gateway's completion callback |
| GET | `/api/account/me` | required | Subscription status + purchased dates |

## Auth

Assumes Strapi's Users & Permissions JWT, forwarded from Nuxt as either an
`Authorization: Bearer <token>` header or a `token` cookie. `JWT_SECRET` here
must match Strapi's, since this service verifies the token itself rather than
round-tripping to Strapi on every request.

## Running

```bash
cp .env.example .env   # fill in STRAPI_API_TOKEN, JWT_SECRET, PAYMENT_WEBHOOK_SECRET
npm install
npm run dev             # http://localhost:4161
```

## Before this goes anywhere near production

- `routes/payments.js` has a **placeholder** signature-verification scheme —
  replace it with your actual gateway's documented method (header name and
  signing string both differ per provider).
- Page images are proxied through this Node process
  (`getPageImageUrl` → `fetch` → pipe). Fine for a scaffold; for real traffic,
  have this route issue short-lived **signed CDN URLs** instead, so image
  bytes don't flow through your Node process for every page view.
