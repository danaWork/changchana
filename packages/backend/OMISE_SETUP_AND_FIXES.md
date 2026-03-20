# Omise Payment Gateway — Setup & Bug Fixes

This document records all changes made to get the Omise payment gateway working in the local development environment.

---

## Infrastructure Setup

### MySQL via Podman

A MySQL 8.0 container was created to serve as the local database:

```bash
podman run -d \
  --name changchana-mysql \
  -e MYSQL_ROOT_PASSWORD=changchana_root \
  -e MYSQL_DATABASE=changchana \
  -e MYSQL_USER=changchana \
  -e MYSQL_PASSWORD=changchana_pass \
  -p 3306:3306 \
  docker.io/library/mysql:8.0 \
  --character-set-server=utf8mb4 \
  --collation-server=utf8mb4_unicode_ci
```

The wallet tables were then created by running the existing migration:

```bash
podman exec -i changchana-mysql mysql -u changchana -pchangchana_pass changchana \
  < migrations/001_create_wallet_tables.sql
```

---

## Files Created

### `.env`

Created from scratch. Contains all environment variables needed to run the backend locally.

Key decisions:
- `NODE_ENV=development` — activates the OTP mock (code `123456`), so ThaiBulk SMS keys are not needed
- `BASIC_AUTHORIZATION=dev_basic_auth_token` — any value works locally; this only guards OTP and forget-password routes, not wallet/payment routes
- `DO_SPACE_*=dummy` — file uploads are not needed for payment testing; the server does not crash with dummy values
- `ONESIGNAL_*=dummy` — push notifications not needed for payment testing
- `CORS_ORIGIN=http://localhost:7001,http://localhost:3000` — added after discovering the server rejected its own origin on startup

### `.env.example`

Created as a reference template with all 18 environment variables documented and grouped by service. Safe to commit.

---

## Files Modified

### 1. `config/functions/bootstrap.js`

**Why:** Strapi requires every endpoint to be explicitly enabled per role in its permissions system. The `signup` and `handlepaymentwebhook` endpoints were not in the bootstrap, so they returned `403 Forbidden`.

**Changes:**

Added public permission for `signup`:
```js
const signupPermission = publicPermissions.find(
  permission => permission.controller === 'api' && permission.action === 'signup'
);
if (signupPermission && !signupPermission.enabled) {
  await strapi.query('permission', 'users-permissions').update(
    { id: signupPermission.id },
    { enabled: true }
  );
}
```

Added public permission for `handlepaymentwebhook`:
```js
const webhookPermission = publicPermissions.find(
  permission => permission.controller === 'api' && permission.action === 'handlepaymentwebhook'
);
if (webhookPermission && !webhookPermission.enabled) {
  await strapi.query('permission', 'users-permissions').update(
    { id: webhookPermission.id },
    { enabled: true }
  );
}
```

**Why webhook must be public:** Omise sends webhooks without any JWT token. It must be accessible without authentication.

---

### 2. `api/api/controllers/users/index.js`

**Why:** The `signup` handler destructured `ctx.request.files` unconditionally. When a JSON request is sent (no file upload), `ctx.request.files` is `undefined`, causing a crash.

**Change (line 65, applied in 2 places):**
```js
// Before
let { files } = ctx.request.files

// After
let { files } = ctx.request.files || {}
```

---

### 3. `api/wallet/services/payment.js`

**Three separate fixes:**

#### Fix 1 — Missing `publicKey` in Omise SDK initialization

**Why:** The Omise Node.js SDK uses `publicKey` to authenticate source creation (`sources.create`). The service only passed `secretKey`, leaving `publicKey` as `undefined`. Omise rejected all source creation calls with `authentication failed`.

```js
// Before
const omise = require('omise')({
  secretKey: process.env.OMISE_SECRET_KEY,
  omiseVersion: '2019-05-29',
});

// After
const omise = require('omise')({
  secretKey: process.env.OMISE_SECRET_KEY,
  publicKey: process.env.OMISE_PUBLIC_KEY,
  omiseVersion: '2019-05-29',
});
```

This was discovered by reading `node_modules/omise/lib/resources/Source.js` which explicitly uses `config['publicKey']` for its auth key.

#### Fix 2 — Schema mismatch in `processSuccessfulPayment`

**Why:** The code was written against a different version of the `wallet_transactions` table schema. The actual schema (from `migrations/001_create_wallet_tables.sql`) has different column names and required fields.

| Code used | Actual column | Issue |
|---|---|---|
| `transaction_id` | `id` | Wrong column name |
| `type: 'topup'` | `type: 'top_up'` | Wrong enum value |
| `updated_at` | — | Column does not exist |
| — | `balance_before` | NOT NULL, was missing |
| — | `balance_after` | NOT NULL, was missing |

```js
// After (fixed insert)
await trx('wallet_transactions').insert({
  id: transactionId,
  user_id: userId,
  type: 'top_up',
  amount: amount,
  balance_before: balanceBefore,
  balance_after: balanceAfter,
  status: 'completed',
  payment_transaction_id: chargeId,
  description: `Wallet top-up via ${charge.source?.type || 'payment'}`,
  metadata: JSON.stringify({ ... }),
  created_at: knex.fn.now(),
});
```

Also added wallet auto-creation if no wallet record exists for the user yet:
```js
let wallet = await trx('wallets').where({ user_id: userId }).first();
if (!wallet) {
  await trx('wallets').insert({ user_id: userId, balance: 0, ... });
  wallet = await trx('wallets').where({ user_id: userId }).first();
}
```

#### Fix 3 — Webhook re-verification against Omise

**Why:** `processSuccessfulPayment` always re-fetched the charge from Omise to verify it was paid. This is correct for `checkPaymentStatus`, but the webhook handler had already verified `paid: true` from the event data. The re-fetch is redundant and breaks webhook-based crediting when used with simulated events.

Added optional `chargeData` parameter to skip the re-fetch when data is already verified:

```js
// Before
async processSuccessfulPayment(chargeId, userId) {
  const charge = await this.getChargeStatus(chargeId);

// After
async processSuccessfulPayment(chargeId, userId, chargeData = null) {
  const charge = chargeData || await this.getChargeStatus(chargeId);
```

---

### 4. `api/api/controllers/wallet.js`

**Two separate fixes:**

#### Fix 1 — Schema mismatch in `createPaymentSource` (pending transaction insert)

Same schema issue as above. The initial pending transaction insert used wrong column names.

```js
// Before
await knex('wallet_transactions').insert({
  transaction_id: `pending_${charge.id}`,
  type: 'topup',
  updated_at: knex.fn.now(),
  ...
});

// After
await knex('wallet_transactions').insert({
  id: `pending_${charge.id}`,
  type: 'top_up',
  balance_before: 0,
  balance_after: 0,
  payment_transaction_id: charge.id,
  ...
  // updated_at removed (column does not exist)
});
```

#### Fix 2 — Webhook handler passes charge data to `processSuccessfulPayment`

**Why:** To use the Fix 3 above (skip re-verification), the webhook must pass its already-verified charge data through.

```js
// Before
await strapi.services.payment.processSuccessfulPayment(charge.id, userId);

// After
await strapi.services.payment.processSuccessfulPayment(charge.id, userId, charge);
```

---

## End-to-End Test Flow

The following sequence was used to verify the full integration:

```bash
# 1. Register a user
curl -X POST http://localhost:7001/api/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "...", "username": "testuser", "password": "..."}'

# 2. Login and get JWT
curl -X POST http://localhost:7001/auth/local \
  -H "Content-Type: application/json" \
  -d '{"identifier": "...", "password": "..."}'

# 3. Verify Omise keys are loaded
curl http://localhost:7001/api/wallet/payment/methods \
  -H "Authorization: Bearer $JWT"

# 4. Create a charge (hits real Omise API)
curl -X POST http://localhost:7001/api/wallet/payment/create-source \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "paymentMethod": "promptpay", "returnUri": "http://localhost:7001"}'

# 5. Simulate Omise webhook confirming payment
curl -X POST http://localhost:7001/api/wallet/payment/webhook \
  -H "Content-Type: application/json" \
  -d '{"key": "charge.complete", "data": {"id": "CHARGE_ID", "paid": true, "status": "successful", "amount": 10000, "metadata": {"user_id": 1}}}'

# 6. Verify wallet was credited
curl http://localhost:7001/api/wallet/balance \
  -H "Authorization: Bearer $JWT"
# Expected: "balance": 100
```

---

## Cleanup

- Removed temporary `console.log` debug statement from `payment.js` that was used to verify the Omise key was loading correctly at startup.
- `.env` is already listed in `.gitignore` — Omise keys are safe and will not be committed.

---

## Notes for Production

- Set `NODE_ENV=production` — this disables the OTP mock and requires real ThaiBulk credentials
- Register a real webhook URL in the Omise dashboard under **Settings > Webhooks**, pointing to `https://your-domain.com/api/wallet/payment/webhook`, listening for `charge.complete`
- Replace all `dummy` values in `.env` with real DigitalOcean Spaces and OneSignal credentials
- `BASIC_AUTHORIZATION` should be a strong random token shared with the mobile app
