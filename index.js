import express from "express";
import cors from "cors";
import { admin, db } from "./firebase.js";   // ES Module import
import { verifyTelegramInitData } from "./utils/telegram.js";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ENV (Vercel Project Settings → Environment Variables)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";   // e.g. 12345:ABC...
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";      // random string

// Helpers
async function ensureDailyReset(userRef, user) {
  const now = admin.firestore.Timestamp.now();
  const last = user.lastReset;
  const nowDate = now.toDate();
  const lastDate = last ? last.toDate() : null;
  const changed =
    !lastDate ||
    nowDate.getUTCFullYear() !== lastDate.getUTCFullYear() ||
    nowDate.getUTCMonth() !== lastDate.getUTCMonth() ||
    nowDate.getUTCDate() !== lastDate.getUTCDate();

  if (changed) {
    await userRef.set({ adsWatchedToday: 0, lastReset: now }, { merge: true });
  }
}

async function getOrCreateUser(uid, referredBy) {
  const ref = db.collection("users").doc(String(uid));
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      balance: 0,
      adsWatchedToday: 0,
      lastReset: admin.firestore.Timestamp.now(),
      referralCount: 0,
      referredBy: referredBy || null,
      isAdmin: false
    });
    if (referredBy && referredBy !== String(uid)) {
      const refRef = db.collection("users").doc(String(referredBy));
      await refRef.set(
        { referralCount: admin.firestore.FieldValue.increment(1) },
        { merge: true }
      );
    }
    return (await ref.get()).data();
  }
  return snap.data();
}

// Routes
app.get("/", (_req, res) => res.json({ ok: true, message: "TG Ads backend up" }));

// INIT
app.post("/init", async (req, res) => {
  try {
    const { initData, testUserId, referrerId } = req.body || {};
    let uid = null;

    if (initData && BOT_TOKEN && verifyTelegramInitData(initData, BOT_TOKEN)) {
      const params = new URLSearchParams(initData);
      const userJson = params.get("user");
      if (!userJson) return res.status(400).json({ ok: false, error: "No user" });
      const user = JSON.parse(userJson);
      uid = String(user.id);
    } else if (testUserId) {
      uid = String(testUserId);
    } else {
      return res.status(400).json({ ok: false, error: "Invalid init data" });
    }

    const userData = await getOrCreateUser(uid, referrerId || null);
    return res.json({ ok: true, userId: uid, user: userData });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "init failed" });
  }
});

// AD WATCHED (+0.5; referrer +10%)
app.post("/adWatched", async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

    const userRef = db.collection("users").doc(String(userId));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error("User not found");
      const user = snap.data();

      await ensureDailyReset(userRef, user);
      const latest = await userRef.get();
      const u = latest.data();

      if ((u.adsWatchedToday || 0) >= 25) throw new Error("Daily ad limit reached");

      tx.update(userRef, {
        adsWatchedToday: (u.adsWatchedToday || 0) + 1,
        balance: (u.balance || 0) + 0.5,
        lastReset: admin.firestore.Timestamp.now(),
      });

      const refId = u.referredBy;
      if (refId && refId !== String(userId)) {
        const refRef = db.collection("users").doc(String(refId));
        tx.set(refRef, { balance: admin.firestore.FieldValue.increment(0.05) }, { merge: true });
      }

      const logRef = db.collection("adLogs").doc();
      tx.set(logRef, { userId: String(userId), ts: admin.firestore.Timestamp.now() });
    });

    return res.json({ ok: true, added: 0.5 });
  } catch (e) {
    console.error(e);
    return res.status(400).json({ ok: false, error: e.message || "error" });
  }
});

// WITHDRAW
app.post("/withdraw", async (req, res) => {
  try {
    const { userId, amount, evmAddress } = req.body || {};
    const amt = Number(amount);
    if (!userId || !evmAddress) return res.status(400).json({ ok: false, error: "Missing fields" });
    if (!Number.isFinite(amt) || amt < 100) return res.status(400).json({ ok: false, error: "Minimum withdraw 100 G" });

    const userRef = db.collection("users").doc(String(userId));
    let wid = null;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error("User not found");
      const u = snap.data();
      if ((u.balance || 0) < amt) throw new Error("Insufficient balance");

      tx.update(userRef, { balance: (u.balance || 0) - amt });

      const wRef = db.collection("withdrawals").doc();
      wid = wRef.id;
      tx.set(wRef, {
        userId: String(userId),
        amount: amt,
        evmAddress,
        status: "pending",
        createdAt: admin.firestore.Timestamp.now(),
      });
    });

    return res.json({ ok: true, withdrawalId: wid });
  } catch (e) {
    console.error(e);
    return res.status(400).json({ ok: false, error: e.message || "error" });
  }
});

// MY WITHDRAWALS
app.get("/myWithdrawals", async (req, res) => {
  try {
    const userId = String(req.query.userId || "");
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
    const q = await db.collection("withdrawals").where("userId", "==", userId)
      .orderBy("createdAt", "desc").limit(50).get();
    const items = q.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: "failed" });
  }
});

// ADMIN GUARD
function requireAdmin(req, res, next) {
  const s = req.headers["x-admin-secret"];
  if (s && s === ADMIN_SECRET) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

// ADMIN: list withdrawals
app.get("/admin/withdrawals", requireAdmin, async (req, res) => {
  const status = String(req.query.status || "pending");
  const q = await db.collection("withdrawals").where("status", "==", status)
    .orderBy("createdAt", "desc").limit(100).get();
  const items = q.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ ok: true, items });
});

// ADMIN: set status
app.post("/admin/withdrawals/:id/status", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { status } = req.body || {};
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Invalid status" });
  }
  await db.collection("withdrawals").doc(id).set({ status }, { merge: true });
  res.json({ ok: true });
});

// Vercel serverless export
export default app;
