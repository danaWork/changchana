"use strict";

/**
 * An asynchronous bootstrap function that runs before
 * your application gets started.
 *
 * This gives you an opportunity to set up your data model,
 * run jobs, or perform some special logic.
 *
 * See more details here: https://strapi.io/documentation/developer-docs/latest/setup-deployment-guides/configurations.html#bootstrap
 */

module.exports = async () => {
  // Set permissions for public role to access staffSignin
  const publicRole = await strapi
    .query("role", "users-permissions")
    .findOne({ type: "public" });

  if (publicRole) {
    const publicPermissions = await strapi
      .query("permission", "users-permissions")
      .find({ role: publicRole.id });

    const staffSigninPermission = publicPermissions.find(
      (permission) =>
        permission.controller === "api" && permission.action === "staffsignin",
    );

    if (staffSigninPermission && !staffSigninPermission.enabled) {
      await strapi
        .query("permission", "users-permissions")
        .update({ id: staffSigninPermission.id }, { enabled: true });
      console.log("✅ Enabled public access to staffSignin endpoint");
    }

    // Allow unauthenticated access to /api/signup.
    // Strapi locks all custom endpoints by default — without this, any POST to
    // /api/signup returns 403 even though the route has no policy defined.
    const signupPermission = publicPermissions.find(
      (permission) =>
        permission.controller === "api" && permission.action === "signup",
    );

    if (signupPermission && !signupPermission.enabled) {
      await strapi
        .query("permission", "users-permissions")
        .update({ id: signupPermission.id }, { enabled: true });
      console.log("Enabled public access to signup endpoint");
    }

    // Allow unauthenticated access to /api/wallet/payment/webhook.
    // Omise sends webhook events without any JWT token, so this endpoint must
    // be public. Without this it returns 403 and payments are never confirmed.
    const webhookPermission = publicPermissions.find(
      (permission) =>
        permission.controller === "api" &&
        permission.action === "handlepaymentwebhook",
    );

    if (webhookPermission && !webhookPermission.enabled) {
      await strapi
        .query("permission", "users-permissions")
        .update({ id: webhookPermission.id }, { enabled: true });
      console.log("Enabled public access to payment webhook endpoint");
    }

    // Set permissions for wallet-admin endpoints
    const walletAdminActions = [
      "listwallet",
      "getwalletdetail",
      "adjustbalance",
      "freezewallet",
      "getalltransactions",
      "refundtransaction",
      "getreports",
      "createvoucher",
    ];

    for (const action of walletAdminActions) {
      const walletPermission = publicPermissions.find(
        (permission) =>
          permission.controller === "admin" &&
          permission.action === action &&
          permission.type === "application" &&
          permission.plugin === "api::wallet.wallet",
      );

      if (walletPermission && !walletPermission.enabled) {
        await strapi
          .query("permission", "users-permissions")
          .update({ id: walletPermission.id }, { enabled: true });
        console.log(`✅ Enabled public access to wallet ${action} endpoint`);
      }
    }
  }

  // Set permissions for authenticated role to access wallet payment endpoints
  const authenticatedRole = await strapi
    .query("role", "users-permissions")
    .findOne({ type: "authenticated" });

  if (authenticatedRole) {
    const authenticatedPermissions = await strapi
      .query("permission", "users-permissions")
      .find({ role: authenticatedRole.id });

    const walletPaymentActions = [
      "getwalletbalance",
      "getwallettransactions",
      "createpaymentsource",
      "checkpaymentstatus",
      "handlepaymentwebhook",
      "getpaymentmethods",
    ];

    for (const action of walletPaymentActions) {
      const walletPermission = authenticatedPermissions.find(
        (permission) =>
          permission.controller === "api" && permission.action === action,
      );

      if (walletPermission && !walletPermission.enabled) {
        await strapi
          .query("permission", "users-permissions")
          .update({ id: walletPermission.id }, { enabled: true });
        console.log(
          `✅ Enabled authenticated access to wallet ${action} endpoint`,
        );
      }
    }
  }
};
