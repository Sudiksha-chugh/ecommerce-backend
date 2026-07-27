const app = require('./app');
const { startConsumer } = require('./consumer');
require('dotenv').config();

const PORT = process.env.PORT;

app.listen(PORT, () => {
  console.log(`payments-service HTTP server running on port ${PORT}`);
});

startConsumer();