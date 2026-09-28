import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { attachUser } from './middleware/auth.js';
import { editionsRouter } from './routes/editions.js';
import { paymentsRouter } from './routes/payments.js';
import { accountRouter } from './routes/account.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';

const app = express();

app.use(cors({ origin: config.webOrigin, credentials: true }));
app.use(cookieParser());

// The webhook needs the *raw* request body to verify the gateway's signature,
// so it gets its own raw parser and is deliberately excluded from the general
// express.json() below — applying both to the same request would try to read
// the request stream twice.
app.use('/api/pay/webhook', express.raw({ type: 'application/json' }));

app.use((req, res, next) => {
  if (req.path === '/api/pay/webhook') return next();
  express.json()(req, res, next);
});
app.use(attachUser);

app.use('/api/editions', editionsRouter);
app.use('/api/pay', paymentsRouter);
app.use('/api/account', accountRouter);
app.use('/api/auth', authRouter);
// Serves handle.epapers.visiongroup.co.ug — a completely separate app
// and origin from config.webOrigin above, but that's irrelevant to CORS
// here: the handle app's own Nitro server calls this router server-to-
// server (see apps/handle/server/api/*.ts), never from its browser
// directly. Server-to-server requests aren't subject to CORS at all —
// no change needed to the cors() config above for this to work.
app.use('/api/admin', adminRouter);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(config.port, () => {
  console.log(`[middleware] listening on :${config.port}`);
});