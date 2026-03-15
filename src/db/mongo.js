const { MongoClient } = require('mongodb');

let client;
let db;

async function connectDB() {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set in environment variables');
  }

  client = new MongoClient(uri);
  await client.connect();

  db = client.db(process.env.MONGODB_DB_NAME || 'lunevo');
  console.log(`Connected to MongoDB: ${db.databaseName}`);

  // Ensure indexes (idempotent — safe to call on every startup)
  await ensureIndexes(db);

  return db;
}

async function ensureIndexes(database) {
  try {
    // Unique compound index: one check-in per clientId per user.
    // This prevents duplicate check-ins when the iOS app retries upserts.
    await database.collection('checkins').createIndex(
      { uid: 1, clientId: 1 },
      { unique: true, name: 'uid_clientId_unique', partialFilterExpression: { clientId: { $exists: true, $type: 'string' } } }
    );

    // Fast lookup for fetching a user's check-ins sorted by time.
    await database.collection('checkins').createIndex(
      { uid: 1, timestamp: -1 },
      { name: 'uid_timestamp' }
    );

    // Unique index on user profiles by Firebase uid.
    await database.collection('users').createIndex(
      { uid: 1 },
      { unique: true, name: 'uid_unique' }
    );

    // Broadcast messages: fast lookup by status + scheduledAt for active-message queries.
    await database.collection('broadcast_messages').createIndex(
      { status: 1, scheduledAt: 1 },
      { name: 'status_scheduledAt' }
    );

    // Message reads: fast lookup to check which messages a user has dismissed.
    await database.collection('message_reads').createIndex(
      { uid: 1, messageId: 1 },
      { unique: true, name: 'uid_messageId_unique' }
    );

    console.log('MongoDB indexes ensured');
  } catch (err) {
    console.error('Failed to ensure indexes (non-fatal):', err.message);
  }
}

function getDB() {
  if (!db) {
    throw new Error('Database not initialized. Call connectDB() first.');
  }
  return db;
}

async function closeDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = { connectDB, getDB, closeDB };
