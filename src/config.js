import 'dotenv/config';

export const config = {
  port: process.env.PORT || 4161,
  strapiUrl: process.env.STRAPI_URL || 'http://localhost:1397',
  strapiApiToken: process.env.STRAPI_API_TOKEN,
  // JWT_SECRET (singular) from before is gone — that was for the old
  // design where Strapi issued and verified tokens itself. We sign our own
  // now, with two separate secrets on purpose (see services/tokens.js for
  // why access and refresh shouldn't share one).
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  // Separate secret for handle.epapers admin sessions — must match
  // apps/cms's own HANDLE_ADMIN_JWT_SECRET exactly (that's what actually
  // signs the token; this only verifies it). Deliberately not shared
  // with jwtAccessSecret/jwtRefreshSecret above — those are the reader-
  // facing epaper-user identity system, completely separate from
  // handle-admin.
  handleAdminJwtSecret: process.env.HANDLE_ADMIN_JWT_SECRET,
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:3871',
  paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
  pricing: {
    subscription: Number(process.env.SUBSCRIPTION_PRICE || 45000),
    subscriptionCurrency: process.env.SUBSCRIPTION_CURRENCY || 'UGX',
    archiveEdition: Number(process.env.ARCHIVE_EDITION_PRICE || 1000)
  }
};