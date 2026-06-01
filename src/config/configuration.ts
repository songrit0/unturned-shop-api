export interface AppConfig {
  port: number;
  frontendUrl: string;
  db: { host: string; port: number; database: string; user: string; password: string; svPrefix: string; rcPrefix: string };
  billItemIds: number[];
  discord: { clientId: string; clientSecret: string; redirectUri: string };
  jwt: { secret: string; expiresIn: string };
  /** Shared secret for bot->API service calls (X-Bot-Secret). Empty disables the bot endpoints (fail closed). */
  botApiSecret: string;
  adminDiscordIds: string[];
  ngrok: { authtoken: string; domain: string };
  firebase: { serviceAccountPath: string; apiUrlDoc: string };
  wealthTax: { percent: number; threshold: number; cron: string };
  p2p: { commissionPercent: number; ttlDays: number; expireCron: string; refundCodeTtlDays: number };
  /** Commission taken when a player sells to the shop. Mirror SellVault's BaseCommissionPercent. */
  shop: { sellCommissionPercent: number };
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT || '3000', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:4200',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    database: process.env.DB_NAME || 'unturned',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    svPrefix: process.env.SV_PREFIX || 'sv_',
    rcPrefix: process.env.RC_PREFIX || 'rc_',
  },
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    redirectUri: process.env.DISCORD_REDIRECT_URI || '',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES || '7d',
  },
  // No default: an unset/empty secret makes BotGuard fail closed (bot endpoints reject all).
  botApiSecret: process.env.BOT_API_SECRET || '',
  adminDiscordIds: (process.env.ADMIN_DISCORD_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  billItemIds: (process.env.BILL_ITEM_IDS || '4254,4255,4256,4257,4258')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)),
  ngrok: {
    authtoken: process.env.NGROK_AUTHTOKEN || '',
    domain: process.env.NGROK_DOMAIN || '',
  },
  firebase: {
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './secrets/firebase-admin.json',
    apiUrlDoc: process.env.FIREBASE_API_URL_DOC || 'config/apiUrl',
  },
  wealthTax: {
    percent: parseFloat(process.env.WEALTH_TAX_PERCENT || '0'),
    threshold: parseInt(process.env.WEALTH_TAX_THRESHOLD || '10000', 10),
    cron: process.env.WEALTH_TAX_CRON || '0 3 * * *',
  },
  p2p: {
    commissionPercent: parseFloat(process.env.P2P_COMMISSION || '5'),
    ttlDays: parseInt(process.env.P2P_TTL_DAYS || '7', 10),
    expireCron: process.env.P2P_EXPIRE_CRON || '*/15 * * * *',
    // Lifetime of the refund redeem code minted when a listing is cancelled/expired/force-closed.
    refundCodeTtlDays: parseInt(process.env.P2P_REFUND_CODE_TTL_DAYS || '7', 10),
  },
  shop: {
    // Default 40 mirrors SellVault.BaseCommissionPercent (player receives 60% of market price).
    sellCommissionPercent: parseFloat(process.env.SELL_COMMISSION || '40'),
  },
});
