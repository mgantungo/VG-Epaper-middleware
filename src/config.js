import 'dotenv/config';

export const config = {
  port: process.env.PORT || 4161,
  strapiUrl: process.env.STRAPI_URL || 'http://localhost:1397',
  strapiApiToken: process.env.STRAPI_API_TOKEN,
  jwtSecret: process.env.JWT_SECRET,
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:3871',
  paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
  pricing: {
    subscription: Number(process.env.SUBSCRIPTION_PRICE || 45000),
    subscriptionCurrency: process.env.SUBSCRIPTION_CURRENCY || 'UGX',
    archiveEdition: Number(process.env.ARCHIVE_EDITION_PRICE || 2000)
  }
};
