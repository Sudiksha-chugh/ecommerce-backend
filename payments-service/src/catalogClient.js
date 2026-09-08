const CATALOG_SERVICE_URL =
  process.env.CATALOG_SERVICE_URL || 'http://localhost:4001';

async function updateStock(path, items) {
  const response = await fetch(`${CATALOG_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY,
    },
    body: JSON.stringify({ items }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Catalog service returned ${response.status}`);
  }

  return data;
}

async function decrementStock(items) {
  return updateStock('/products/decrement-stock', items);
}

async function restoreStock(items) {
  return updateStock('/products/restore-stock', items);
}

module.exports = {
  decrementStock,
  restoreStock,
};
