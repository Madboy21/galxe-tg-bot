const admin = require("firebase-admin");

if (!admin.apps.length) {
  // FIREBASE_SERVICE_ACCOUNT = one-line JSON string
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
module.exports = { admin, db };
