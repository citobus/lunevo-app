const admin = require('firebase-admin');

if (!admin.apps.length) {
  let credential;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    credential = admin.credential.cert(serviceAccount);
    console.log('Firebase Admin: using service account cert for project:', serviceAccount.project_id);
  } else {
    credential = admin.credential.applicationDefault();
    console.log('Firebase Admin: using Application Default Credentials (not recommended on Railway)');
  }

  // Do NOT pass projectId separately — the cert already contains it.
  // Passing projectId alongside cert() can cause "aud mismatch" errors
  // in firebase-admin v13 even when the values look identical.
  admin.initializeApp({ credential });

  console.log('Firebase Admin initialized');
}

module.exports = admin;
