export interface AppConfig {
  port: number;
  frontendUrl: string;
  db: { host: string; port: number; database: string; user: string; password: string; svPrefix: string; rcPrefix: string; garageTable: string };
  billItemIds: number[];
  discord: { clientId: string; clientSecret: string; redirectUri: string };
  jwt: { secret: string; expiresIn: string };
  /** Shared secret for bot->API service calls (X-Bot-Secret). Empty disables the bot endpoints (fail closed). */
  botApiSecret: string;
  adminDiscordIds: string[];
  ngrok: { authtoken: string; domain: string };
  firebase: { serviceAccountPath: string; apiUrlDoc: string };
  wealthTax: { percent: number; threshold: number; cron: string };
  p2p: { commissionPercent: number; ttlDays: number; expireCron: string; refundCodeTtlDays: number; cancelPenaltyPct: number };
  /** Commission taken when a player sells to the shop. Mirror SellVault's BaseCommissionPercent. */
  shop: { sellCommissionPercent: number };
  /**
   * Player-to-player Coin transfers. FLAT fee paid by the sender ON TOP of the amount
   * (sender pays amount + fee, recipient receives the full amount, fee is a burned sink).
   * transferMin must be > transferFee so a transfer always moves more than it burns.
   */
  coin: { transferFee: number; transferMin: number };
  /**
   * XP -> Coins conversion. The player burns in-game experience for coins, minus a percentage fee.
   * These values MUST mirror the GameMenu plugin's config (XpToCoinRate / XpConvertFeePercent /
   * XpConvertMin): the plugin is the authority that actually deducts XP + credits coins, so the web
   * only previews. rate = coins per 1 XP before the fee; feePercent burned; min = least XP per convert.
   */
  xp: { rate: number; feePercent: number; min: number };
  /**
   * Real-money top-up settings. The Meowcoin wallet + top-up records live in a SEPARATE
   * Pi5-local MariaDB (topupDb), never the external shop DB.
   */
  topup: {
    meowcoinPerBaht: number;
    minBaht: number;
    maxBaht: number;
    pollCron: string;
    /** Max pending rows polled per tick — keeps us well under PlernPay's 30 req/min. */
    pollBatch: number;
    /** Soft-launch gate: when true only admins can create a top-up. Default false (donations open to all). */
    adminOnly: boolean;
    /** Donate: max baht a single user may donate per calendar month (resets monthly). */
    monthlyCapBaht: number;
    /** Donate: community-wide monthly goal (baht) the progress bar fills toward (resets monthly). */
    monthlyGoalBaht: number;
  };
  topupDb: { host: string; port: number; user: string; password: string; database: string };
  /** PlernPay PromptPay top-up gateway credentials (server-only secret). */
  plernpay: { baseUrl: string; clientId: string; clientSecret: string };
  /** Thunder slip-verification gateway (manual PromptPay + slip upload). */
  thunder: { apiKey: string; promptpayId: string; receiverName: string; baseUrl: string };
  /** BuyMeACoffee webhook donations (donor self-reports steamID64 in the supporter message). */
  bmc: { webhookSecret: string; usdToThb: number; pageUrl: string };
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
    // Unprefixed table the VirtualGarage Unturned plugin owns (shared DB). One row per stored vehicle.
    garageTable: process.env.GARAGE_TABLE || 'virtual_garage',
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
    // Penalty (% of listing price) charged to the seller when they CANCEL an active listing.
    // Not applied on expire or admin force-close. Seller balance may go negative.
    cancelPenaltyPct: parseFloat(process.env.P2P_CANCEL_PENALTY_PCT || '25'),
  },
  shop: {
    // Default 40 mirrors SellVault.BaseCommissionPercent (player receives 60% of market price).
    sellCommissionPercent: parseFloat(process.env.SELL_COMMISSION || '40'),
  },
  coin: {
    // Flat fee burned on every P2P transfer; min transfer must exceed it.
    transferFee: parseInt(process.env.COIN_TRANSFER_FEE || '200', 10),
    transferMin: parseInt(process.env.COIN_TRANSFER_MIN || '201', 10),
  },
  xp: {
    // MUST match the GameMenu plugin (XpToCoinRate / XpConvertFeePercent / XpConvertMin).
    rate: parseFloat(process.env.XP_COIN_RATE || '1'),
    feePercent: parseFloat(process.env.XP_CONVERT_FEE_PERCENT || '10'),
    min: parseInt(process.env.XP_CONVERT_MIN || '100', 10),
  },
  topup: {
    // Backward-compat: prefer MEOWCOIN_PER_BAHT, fall back to the legacy VCOIN_PER_BAHT.
    meowcoinPerBaht: parseFloat(process.env.MEOWCOIN_PER_BAHT ?? process.env.VCOIN_PER_BAHT ?? '1'),
    minBaht: parseInt(process.env.TOPUP_MIN_BAHT || '1', 10),
    maxBaht: parseInt(process.env.TOPUP_MAX_BAHT || '10000', 10),
    // Poller fires every 15s; batch-cap keeps us well under PlernPay's 30 req/min.
    pollCron: process.env.TOPUP_POLL_CRON || '*/15 * * * * *',
    pollBatch: parseInt(process.env.TOPUP_POLL_BATCH || '5', 10),
    // Donations are OPEN to all by default. Set TOPUP_ADMIN_ONLY=true to re-gate to admins only.
    adminOnly: process.env.TOPUP_ADMIN_ONLY === 'true',
    // Donate: per-user monthly cap (baht) and community monthly goal (baht). Both reset each calendar month.
    monthlyCapBaht: parseInt(process.env.TOPUP_MONTHLY_CAP_BAHT || '150', 10),
    monthlyGoalBaht: parseInt(process.env.TOPUP_MONTHLY_GOAL_BAHT || '1200', 10),
  },
  topupDb: {
    host: process.env.TOPUP_DB_HOST || '127.0.0.1',
    port: parseInt(process.env.TOPUP_DB_PORT || '3306', 10),
    user: process.env.TOPUP_DB_USER || '',
    password: process.env.TOPUP_DB_PASSWORD || '',
    database: process.env.TOPUP_DB_NAME || 'unturned_topup',
  },
  plernpay: {
    baseUrl: process.env.PLERNPAY_BASE_URL || 'https://api.plernpay.com',
    clientId: process.env.PLERNPAY_CLIENT_ID || '',
    clientSecret: process.env.PLERNPAY_CLIENT_SECRET || '',
  },
  thunder: {
    apiKey: process.env.THUNDER_API_KEY || '',
    promptpayId: process.env.THUNDER_PROMPTPAY_ID || '',
    receiverName: process.env.THUNDER_RECEIVER_NAME || '',
    baseUrl: process.env.THUNDER_BASE_URL || 'https://api.thunder.in.th/v2',
  },
  bmc: {
    // BuyMeACoffee webhook signing secret (Settings -> Webhooks on the BMC dashboard).
    webhookSecret: process.env.BMC_WEBHOOK_SECRET || '',
    // Fixed USD->THB rate used to convert BMC donations (USD) into baht for the
    // shared monthly cap/tier system. Update as the real rate drifts.
    usdToThb: parseFloat(process.env.BMC_USD_TO_THB || '36'),
    // Public BuyMeACoffee page URL shown as a donate link on the web. Empty hides the link.
    pageUrl: process.env.BMC_PAGE_URL || '',
  },
});
