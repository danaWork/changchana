"use strict";

/**
 * Wallet Controllers (User-facing)
 * Handles wallet operations for mobile app users
 */

/**
 * Transfer funds to another user
 * POST /api/wallet/transfer
 */
const transferFunds = async (ctx) => {
  try {
    const userId = ctx.state.user?.id;
    if (!userId) {
      return ctx.unauthorized("Authentication required");
    }

    const { receiverUserId, amount, description } = ctx.request.body;

    if (!receiverUserId || !amount) {
      return ctx.badRequest("receiverUserId and amount are required");
    }

    // Execute transfer
    const result = await strapi.services.transfer.transferFunds(
      userId,
      receiverUserId,
      parseFloat(amount),
      description,
    );

    // Get updated balance
    const balance = await strapi.services.wallet.getBalance(userId);

    ctx.body = {
      success: true,
      data: {
        transfer: result,
        newBalance: balance.balance,
      },
    };
  } catch (error) {
    strapi.log.error("[WalletUser] transferFunds error:", error);
    ctx.badRequest(error.message || "Transfer failed");
  }
};

/**
 * Redeem points for wallet balance
 * POST /api/wallet/redeem-points
 */
const redeemPoints = async (ctx) => {
  try {
    const userId = ctx.state.user?.id;
    if (!userId) {
      return ctx.unauthorized("Authentication required");
    }

    const { points, description } = ctx.request.body;

    if (!points) {
      return ctx.badRequest("points is required");
    }

    // Execute redemption
    const result = await strapi.services.redemption.redeemPoints(
      userId,
      parseInt(points),
      description,
    );

    ctx.body = {
      success: true,
      data: {
        redemption: result,
        newWalletBalance: result.newWalletBalance,
        newPointsBalance: result.newPointsBalance,
      },
    };
  } catch (error) {
    strapi.log.error("[WalletUser] redeemPoints error:", error);
    ctx.badRequest(error.message || "Redemption failed");
  }
};

/**
 * Get user's transfer history
 * GET /api/wallet/transfers
 */
const getUserTransfers = async (ctx) => {
  try {
    const userId = ctx.state.user?.id;
    if (!userId) {
      return ctx.unauthorized("Authentication required");
    }

    const { limit, offset } = ctx.query;

    const result = await strapi.services.transfer.getUserTransfers(userId, {
      limit,
      offset,
    });

    ctx.body = {
      success: true,
      data: result,
    };
  } catch (error) {
    strapi.log.error("[WalletUser] getUserTransfers error:", error);
    ctx.badRequest("Failed to load transfers");
  }
};

/**
 * Get user's point redemption history
 * GET /api/wallet/point-redemptions
 */
const getUserPointRedemptions = async (ctx) => {
  try {
    const userId = ctx.state.user?.id;
    if (!userId) {
      return ctx.unauthorized("Authentication required");
    }

    const { limit, offset } = ctx.query;

    const result = await strapi.services.redemption.getUserRedemptions(userId, {
      limit,
      offset,
    });

    ctx.body = {
      success: true,
      data: result,
    };
  } catch (error) {
    strapi.log.error("[WalletUser] getUserPointRedemptions error:", error);
    ctx.badRequest("Failed to load redemptions");
  }
};

/**
 * Get user's wallet balance and info
 * GET /api/wallet/balance
 */
const getWalletBalance = async (ctx) => {
  try {
    const userId = ctx.state.user?.id;
    if (!userId) {
      return ctx.unauthorized("Authentication required");
    }

    const balance = await strapi.services.wallet.getBalance(userId);

    ctx.body = {
      success: true,
      data: balance,
    };
  } catch (error) {
    strapi.log.error("[WalletUser] getWalletBalance error:", error);
    ctx.badRequest("Failed to load wallet balance");
  }
};

/**
 * Get user's wallet transactions
 * GET /api/wallet/transactions
 */
const getWalletTransactions = async (ctx) => {
  try {
    const userId = ctx.state.user?.id;
    if (!userId) {
      return ctx.unauthorized("Authentication required");
    }

    const { limit = 50, offset = 0, type, status } = ctx.query;

    const knex = strapi.connections.default;
    let query = knex("wallet_transactions")
      .where({ user_id: userId })
      .orderBy("created_at", "desc");

    if (type) {
      query = query.where({ type });
    }
    if (status) {
      query = query.where({ status });
    }

    const transactions = await query
      .limit(parseInt(limit))
      .offset(parseInt(offset));
    const [{ count }] = await knex("wallet_transactions")
      .where({ user_id: userId })
      .count("* as count");

    ctx.body = {
      success: true,
      data: {
        transactions,
        total: count,
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    };
  } catch (error) {
    strapi.log.error("[WalletUser] getWalletTransactions error:", error);
    ctx.badRequest("Failed to load transactions");
  }
};

/**
 * Create payment source for wallet top-up (Mobile Banking)
 * POST /api/wallet/payment/create-source
 */
const createPaymentSource = async (ctx) => {
  try {
    const userId = ctx.state.user?.id;
    if (!userId) {
      return ctx.unauthorized("Authentication required");
    }

    const { amount, paymentMethod, returnUri } = ctx.request.body;

    if (!amount || !paymentMethod || !returnUri) {
      return ctx.badRequest(
        "amount, paymentMethod, and returnUri are required",
      );
    }

    if (amount < 10) {
      return ctx.badRequest("Minimum top-up amount is 10 THB");
    }

    // Create source based on payment method
    let source;
    if (paymentMethod === "promptpay") {
      source = await strapi.services.payment.createPromptPaySource(
        amount,
        "THB",
      );
    } else if (paymentMethod.startsWith("mobile_banking_")) {
      source = await strapi.services.payment.createMobileBankingSource(
        amount,
        "THB",
        paymentMethod,
        returnUri,
      );
    } else {
      return ctx.badRequest("Invalid payment method");
    }

    // Create charge immediately
    const charge = await strapi.services.payment.createCharge(
      source.id,
      amount,
      "THB",
      `Wallet top-up for user ${userId}`,
      {
        user_id: userId,
        return_uri: returnUri,
      },
    );

    // Store pending transaction
    // Corrected column names and values to match actual schema in
    // migrations/001_create_wallet_tables.sql:
    //   - transaction_id  → id
    //   - type 'topup'    → 'top_up'  (enum value)
    //   - removed updated_at (column does not exist)
    //   - added balance_before and balance_after (NOT NULL columns)
    //   - added payment_transaction_id to link back to the Omise charge
    // balance_before/after are 0 here because payment is still pending —
    // the real values are set in processSuccessfulPayment on confirmation.
    const knex = strapi.connections.default;
    await knex("wallet_transactions").insert({
      id: `pending_${charge.id}`,
      user_id: userId,
      type: "top_up",
      amount: amount,
      balance_before: 0,
      balance_after: 0,
      status: "pending",
      payment_transaction_id: charge.id,
      description: "Pending wallet top-up",
      metadata: JSON.stringify({
        charge_id: charge.id,
        source_id: source.id,
        payment_method: paymentMethod,
      }),
      created_at: knex.fn.now(),
    });

    ctx.body = {
      success: true,
      data: {
        chargeId: charge.id,
        sourceId: source.id,
        authorizeUri: charge.authorize_uri,
        amount: amount,
        status: charge.status,
        // For PromptPay, include QR code data
        scannable_code: source.scannable_code,
      },
    };
  } catch (error) {
    strapi.log.error("[WalletUser] createPaymentSource error:", error);
    ctx.badRequest(error.message || "Failed to create payment source");
  }
};

/**
 * Check payment status
 * GET /api/wallet/payment/status/:chargeId
 */
const checkPaymentStatus = async (ctx) => {
  try {
    const userId = ctx.state.user?.id;
    if (!userId) {
      return ctx.unauthorized("Authentication required");
    }

    const { chargeId } = ctx.params;

    if (!chargeId) {
      return ctx.badRequest("chargeId is required");
    }

    const charge = await strapi.services.payment.getChargeStatus(chargeId);

    // If payment is successful and not yet processed, process it
    if (charge.paid && charge.status === "successful") {
      const knex = strapi.connections.default;

      // Check if already processed
      const existing = await knex("wallet_transactions")
        .where({ transaction_id: `topup_${chargeId}` })
        .first();

      if (!existing) {
        // Process the payment
        await strapi.services.payment.processSuccessfulPayment(
          chargeId,
          userId,
        );
      }
    }

    ctx.body = {
      success: true,
      data: {
        chargeId: charge.id,
        status: charge.status,
        paid: charge.paid,
        amount: charge.amount / 100,
        failureCode: charge.failure_code,
        failureMessage: charge.failure_message,
      },
    };
  } catch (error) {
    strapi.log.error("[WalletUser] checkPaymentStatus error:", error);
    ctx.badRequest(error.message || "Failed to check payment status");
  }
};

/**
 * Handle Omise webhook events
 * POST /api/wallet/payment/webhook
 */
const handlePaymentWebhook = async (ctx) => {
  try {
    const event = ctx.request.body;

    strapi.log.info("[Payment] Webhook received:", {
      type: event.key,
      id: event.id,
    });

    // Handle charge.complete event
    if (event.key === "charge.complete") {
      const charge = event.data;

      if (charge.paid && charge.status === "successful") {
        const metadata = charge.metadata;
        const userId = metadata?.user_id;

        if (userId) {
          try {
            // For transaction testing
            // Pass charge data directly to skip redundant Omise re-fetch.
            // The webhook payload has already confirmed paid: true — passing it
            // avoids a second API call and handles cases where the charge status
            // hasn't propagated yet on Omise's side.
            // NOTE: This relies on the webhook being genuine. Implement webhook
            // signature verification (OMISE_WEBHOOK_SECRET) before going to production.
            await strapi.services.payment.processSuccessfulPayment(
              charge.id,
              userId,
              // charge,
            );
            strapi.log.info(
              "[Payment] Webhook processed successfully:",
              charge.id,
            );
          } catch (error) {
            strapi.log.error("[Payment] Webhook processing error:", error);
          }
        }
      }
    }

    ctx.body = { received: true };
  } catch (error) {
    strapi.log.error("[Payment] handlePaymentWebhook error:", error);
    ctx.body = { received: true }; // Always return 200 to Omise
  }
};

/**
 * Get supported payment methods
 * GET /api/wallet/payment/methods
 */
const getPaymentMethods = async (ctx) => {
  try {
    const methods = await strapi.services.payment.getSupportedPaymentMethods();

    ctx.body = {
      success: true,
      data: {
        ...methods,
        omisePublicKey: process.env.OMISE_PUBLIC_KEY,
      },
    };
  } catch (error) {
    strapi.log.error("[WalletUser] getPaymentMethods error:", error);
    ctx.badRequest("Failed to load payment methods");
  }
};

module.exports = {
  transferFunds,
  redeemPoints,
  getUserTransfers,
  getUserPointRedemptions,
  getWalletBalance,
  getWalletTransactions,
  createPaymentSource,
  checkPaymentStatus,
  handlePaymentWebhook,
  getPaymentMethods,
};
