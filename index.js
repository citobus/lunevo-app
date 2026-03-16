require('dotenv').config();

const { connectDB } = require('./src/db/mongo');
const app = require('./src/app');
const { startScheduler } = require('./src/services/scheduler');

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    // Connect to MongoDB before accepting traffic
    await connectDB();

    app.listen(PORT, () => {
      console.log(`lunevo backend running on port ${PORT}`);
      startScheduler();
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
