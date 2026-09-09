const app = require('./app');
const { startInventoryExpirationWorker } = require('./inventoryExpiration');

const PORT = process.env.PORT || 4001;

app.listen(PORT, () => {
  console.log(`Catalog service running on port ${PORT}`);

  startInventoryExpirationWorker();
});