"use strict";

const _ = require("lodash");
const crypto = require("crypto");
const { sanitizeEntity } = require("strapi-utils");
const QRCode = require("qrcode");
const moment = require("moment");

const sanitizeUser = (user) =>
  sanitizeEntity(user, {
    model: strapi.query("user", "users-permissions").model,
  });

const formatError = (error) => [
  { messages: [{ id: error.id, message: error.message, field: error.field }] },
];

const checkUser = async (ctx) => {
  let body = ctx.request.body;
  let { phone, email } = body;

  if (!phone || !email) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: "No phone or email provided",
    };

    return;
  }

  let checkPhone = await strapi
    .query("user", "users-permissions")
    .findOne({ phone });
  let checkEmail = await strapi
    .query("user", "users-permissions")
    .findOne({ email: email });

  if (checkPhone) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: "User with this phone exists",
    };
    return;
  }

  if (checkEmail) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: "User with this email exists",
    };
    return;
  }

  ctx.body = {
    success: true,
    message: "User with this phone or email is not exists",
  };
};

const signup = async (ctx) => {
  let body = ctx.request.body;

  // Considering profile image is optional — fall back to empty object so the files check
  // below behaves correctly instead of crashing with a destructure error.
  let { files } = ctx.request.files || {};
  let userData = {
    ...body,
    confirmed: true,
    blocked: false,
    role: 1,
  };

  const advanced = await strapi
    .store({
      environment: "",
      type: "plugin",
      name: "users-permissions",
      key: "advanced",
    })
    .get();

  const { email, username, password, role } = userData;

  if (!email) return ctx.badRequest("missing.email");
  if (!username) return ctx.badRequest("missing.username");
  if (!password) return ctx.badRequest("missing.password");

  const userWithSameUsername = await strapi
    .query("user", "users-permissions")
    .findOne({ username });

  if (userWithSameUsername) {
    return ctx.badRequest(
      null,
      formatError({
        id: "Auth.form.error.username.taken",
        message: "Username already taken.",
        field: ["username"],
      }),
    );
  }

  if (advanced.unique_email) {
    const userWithSameEmail = await strapi
      .query("user", "users-permissions")
      .findOne({ email: email.toLowerCase() });

    if (userWithSameEmail) {
      return ctx.badRequest(
        null,

        formatError({
          id: "Auth.form.error.email.taken",
          message: "Email already taken.",
          field: ["email"],
        }),
      );
    }
  }

  const user = {
    ...userData,
    provider: "local",
    special: false,
  };

  user.email = user.email.toLowerCase();

  const protectCitizenID = userData.citizen_id
    ? `xxxxx${userData.citizen_id.substring(5)}`
    : undefined;
  const protectPassport = userData.passport_no
    ? `xxxxx${userData.passport_no.substring(3)}`
    : undefined;
  strapi.log.info("[Signup] userData:", {
    ...userData,
    password: "xxxxxx",
    citizen_id: protectCitizenID,
    username: protectCitizenID,
    passport_no: protectPassport,
  });

  if (!role) {
    const defaultRole = await strapi
      .query("role", "users-permissions")
      .findOne({ type: advanced.default_role }, []);

    user.role = defaultRole.id;
  }

  if (files) {
    let [fileResponse] = await strapi.plugins.upload.services.upload.upload({
      data: {},
      files,
    });

    if (fileResponse) {
      try {
        const data = await strapi.plugins[
          "users-permissions"
        ].services.user.add({
          ...user,
          profile_image: fileResponse.id,
        });

        ctx.created(sanitizeUser(data));
      } catch (error) {
        ctx.badRequest(null, formatError(error));
      }
    } else {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: "Upload file failed",
      };
    }
  } else {
    try {
      const data =
        await strapi.plugins["users-permissions"].services.user.add(user);

      ctx.created(sanitizeUser(data));
    } catch (error) {
      ctx.badRequest(null, formatError(error));
    }
  }
};

const changePassword = async (ctx) => {
  let body = ctx.request.body;
  let { current_password, new_password, user: userId } = body;
  const user = await strapi.query("user", "users-permissions").findOne({
    id: userId,
  });

  if (!user) {
    return ctx.badRequest(
      null,
      formatError({
        id: "Auth.form.error.invalid",
        message: "This user is not exists.",
      }),
    );
  }

  const validPassword = await strapi.plugins[
    "users-permissions"
  ].services.user.validatePassword(current_password, user.password);

  if (validPassword) {
    let newPassword = await strapi.plugins[
      "users-permissions"
    ].services.user.hashPassword({ password: new_password });

    let response = await strapi.query("user", "users-permissions").update(
      {
        id: userId,
      },
      {
        password: newPassword,
      },
    );

    ctx.body = response;
  } else {
    return ctx.badRequest(
      null,
      formatError({
        id: "Auth.form.error.invalid",
        message: "Identifier or password invalid.",
      }),
    );
  }
};

const changeProfileImage = async (ctx) => {
  let body = ctx.request.body;
  let { files } = ctx.request.files || {};

  if (body.id) {
    if (files) {
      let [fileResponse] = await strapi.plugins.upload.services.upload.upload({
        data: {},
        files,
      });

      if (fileResponse) {
        try {
          let response = await strapi.query("user", "users-permissions").update(
            {
              id: body.id,
            },
            {
              profile_image: fileResponse.id,
            },
          );

          ctx.body = response;
        } catch (error) {
          ctx.badRequest(null, formatError(error));
        }
      } else {
        ctx.status = 500;
        ctx.body = {
          success: false,
          message: "Upload file failed",
        };
      }
    } else {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: `No profile image provided.`,
      };
    }
  } else {
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: `No user id provided.`,
    };
  }
};

const generateQR = async (ctx) => {
  let { id } = ctx.request.query;

  if (id) {
    try {
      let response = await QRCode.toDataURL(id);
      ctx.body = response;
    } catch (err) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: `Failed to generate QR Code`,
      };
    }
  } else {
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: `Missing ID`,
    };
  }
};

const requestOTP = async (ctx) => {
  let body = ctx.request.body;
  strapi.log.info("[OTP Request] body:", body);

  try {
    const response = await strapi.config.functions.otpService.request({
      mobile: body.recipient,
    });
    strapi.log.info("[OTP Request] Response:", response);

    if (!response.success) {
      ctx.status = Number(response.statusCode ?? 400);
    }
    ctx.body = response;
  } catch (error) {
    strapi.log.error("[OTP Request] error:", error.message);
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error.message,
    };
  }
};

const verifyOTP = async (ctx) => {
  let body = ctx.request.body;
  strapi.log.info("[OTP Verify] body:", body);

  try {
    const response = await strapi.config.functions.otpService.verify({
      token: body.token,
      code: body.code,
    });
    strapi.log.info("[OTP Verify] Response:", response);

    if (!response.success) {
      ctx.status = Number(response.statusCode ?? 400);
    }
    ctx.body = response;
  } catch (error) {
    strapi.log.error("[OTP Request] error:", error.message);
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error.message,
    };
  }
};

const forgetPassword = async (ctx) => {
  const { mobile } = ctx.request.body;
  strapi.log.info("[Forget password] ", ctx.request.body);
  if (!/0\d{9}$/.test(mobile)) {
    return ctx.badRequest(
      "Please provide a valid mobile number.",
      formatError({
        id: "Auth.form.error.mobile.format",
        message: "Please provide a valid mobile number.",
      }),
    );
  }
  const user = await strapi
    .query("user", "users-permissions")
    .findOne({ phone: mobile });

  // User not found.
  if (!user) {
    return ctx.badRequest(
      "This mobile does not exist.",
      formatError({
        id: "Auth.form.error.user.not-exist",
        message: "This mobile does not exist.",
      }),
    );
  }

  // User blocked
  if (user.blocked) {
    return ctx.badRequest(
      "This user is disabled.",
      formatError({
        id: "Auth.form.error.user.blocked",
        message: "This user is disabled.",
      }),
    );
  }

  try {
    const response = await strapi.config.functions.otpService.request({
      mobile,
    });

    if (!response.success) {
      ctx.status = Number(response.statusCode ?? 400);
    } else {
      await strapi
        .query("user", "users-permissions")
        .update({ id: user.id }, { resetPasswordToken: response.data.token });
    }
    ctx.body = response;
  } catch (error) {
    strapi.log.error("[Forget password] error:", error.message);
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error.message,
    };
  }
};

const checkOut = async (ctx) => {
  const { id: userID } = ctx.state.user;
  const { code } = ctx.request.body;

  strapi.log.info("[CheckOut] Request:", { userID, code });

  if (!code) {
    throw strapi.errors.badRequest("Invalid code");
  }

  const now = moment();
  const nowLocal = moment(now).utcOffset("+07:00");

  const lastCheckIn = await strapi.services["user-log"].findOne({
    user: userID,
    type: "checked_in",
    _sort: "datetime:DESC",
  });

  const checkInDate = lastCheckIn && moment(lastCheckIn.datetime);

  if (!checkInDate || now.diff(checkInDate, "hours") >= 24) {
    throw strapi.errors.badRequest("User not checked in");
  }

  const branch = await strapi.services["branch"].findOne({
    id: lastCheckIn.branch.id,
  });
  const { opening_time } = branch;

  if (!opening_time) {
    throw strapi.errors.badRequest("Branch opening time not found");
  }

  const timeLocal = nowLocal.format("HH:mm:ss");
  const openingTime = moment.parseZone(`${opening_time}+07:00`, "HH:mm:ssZZ");
  const openingDate = moment(nowLocal).set({
    hour: openingTime.hour(),
    minute: openingTime.minute(),
    second: openingTime.second(),
  });

  const codeUsable = {
    from:
      timeLocal < opening_time
        ? moment(openingDate).subtract(24, "hours")
        : openingDate,
    to:
      timeLocal < opening_time
        ? openingDate
        : moment(openingDate).add(24, "hours"),
  };

  if (codeUsable.from > checkInDate || codeUsable.to < checkInDate) {
    throw strapi.errors.badRequest("User not checked in");
  }

  // Check user already checked out
  const alreadyCheckOut = await strapi.services["user-log"].count({
    user: userID,
    type: "checked_out",
    datetime_gte: codeUsable.from.toDate(),
    datetime_lt: codeUsable.to.toDate(),
    _sort: "datetime:DESC",
  });

  if (alreadyCheckOut) {
    throw strapi.errors.badRequest("User already checked out");
  }

  // Find luckyNumber today
  const luckyNumber = await strapi.services["lucky-number"].findOne({
    code,
    begin_date_lte: codeUsable.from.format("YYYY-MM-DD"),
    end_date_gte: codeUsable.from.format("YYYY-MM-DD"),
    active: true,
  });

  if (!luckyNumber) {
    throw strapi.errors.badRequest("Invalid code");
  }

  const userCheckedOut = await strapi.services["user-log"].create({
    user: userID,
    branch: lastCheckIn.branch.id,
    type: "checked_out",
    datetime: nowLocal.toDate(),
  });

  if (luckyNumber.points > 0) {
    await strapi.services["point-logs"].adjustPoints({
      points: luckyNumber.points,
      issueBy: -1,
      userID,
      remark: `checked_out::lucky_code:${code}`,
    });
  }

  ctx.body = {
    success: true,
    data: {
      datetime: userCheckedOut.datetime,
      earnPoints: luckyNumber.points,
    },
  };
};

const otpVerifyForgetPassword = async (ctx) => {
  let { code, token } = ctx.request.body;

  if (!token) {
    return ctx.badRequest(
      "Please provide a token for validate otp.",
      formatError({
        id: "Auth.form.error.token.format",
        message: "Please provide a token for validate otp.",
      }),
    );
  }

  if (!code) {
    return ctx.badRequest(
      "Please provide a code for validate otp.",
      formatError({
        id: "Auth.form.error.code.format",
        message: "Please provide a code for validate otp.",
      }),
    );
  }

  try {
    const response = await strapi.config.functions.otpService.verify({
      token,
      code,
    });
    strapi.log.info("[OTP Verify] Response:", response);

    if (!response.success) {
      ctx.status = Number(response.statusCode ?? 400);
      return ctx.badRequest(response.message);
    }

    // Find the user by email.
    const user = await strapi
      .query("user", "users-permissions")
      .findOne({ resetPasswordToken: token });

    // User not found.
    if (!user) {
      return ctx.badRequest(
        "Data forget password missmatch or somthing wrong.",
        formatError({
          id: "Auth.form.error.token.not-exist",
          message: "Data forget password missmatch or somthing wrong.",
        }),
      );
    }

    // User blocked
    if (user.blocked) {
      return ctx.badRequest(
        "This user is disabled.",
        formatError({
          id: "Auth.form.error.user.blocked",
          message: "This user is disabled.",
        }),
      );
    }

    // Generate random token.
    const resetPasswordToken = crypto.randomBytes(64).toString("hex");

    // Update the user.
    await strapi
      .query("user", "users-permissions")
      .update({ id: user.id }, { resetPasswordToken });

    ctx.send({
      success: true,
      data: {
        code: resetPasswordToken,
      },
    });
  } catch (error) {
    strapi.log.error("[verifyOtpForgetPassword] error:", error.message);
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error.message,
    };
  }
};

const deleteAccount = async (ctx) => {
  try {
    const { id: deleted_by } = ctx.state.user;
    const data = await strapi.plugins["users-permissions"].services.user.remove(
      { id: deleted_by },
    );

    if (data) {
      strapi.services["users-deleted"].createdUserDeleted({
        ...data,
        deleted_by,
      });
    }

    ctx.send(sanitizeUser(data));
  } catch (error) {
    strapi.log.error("[User deleted] error:", error.message);
  }
};

module.exports = {
  signup,
  changePassword,
  changeProfileImage,
  generateQR,
  requestOTP,
  verifyOTP,
  checkUser,
  checkOut,
  forgetPassword,
  otpVerifyForgetPassword,
  deleteAccount,
};
