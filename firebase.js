import admin from "firebase-admin";

// যদি কোনো Firebase অ্যাপ ইতিমধ্যেই initialized না থাকে
if (!admin.apps.length) {
  // FIREBASE_SERVICE_ACCOUNT = one-line JSON string
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

export { admin, db };
