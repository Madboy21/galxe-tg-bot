const crypto = require("crypto");

function verifyTelegramInitData(initData, botToken) {
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get("hash");
    if (!hash) return false;

    const data = [];
    for (const [k, v] of urlParams) {
      if (k === "hash") continue;
      data.push(`${k}=${v}`);
    }
    data.sort();
    const dataCheckString = data.join("\n");

    const secretKey = crypto.createHash("sha256").update(botToken).digest();
    const hmac = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    return hmac === hash;
  } catch {
    return false;
  }
}

module.exports = { verifyTelegramInitData };
