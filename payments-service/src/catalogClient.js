const CATALOG_SERVICE_URL =
  process.env.CATALOG_SERVICE_URL || 'http://localhost:4001';

async function updateStock(path, body) {
  const response = await fetch(`${CATALOG_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data.error || `Catalog service returned ${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  return data;
}

async function reserveStock(orderId, items) {
  return updateStock('/products/reserve-stock', {
    orderId,
    items,
  });
}

async function confirmReservation(orderId) {
  return updateStock('/products/confirm-reservation', {
    orderId,
  });
}

async function releaseReservation(orderId) {
  return updateStock('/products/release-reservation', {
    orderId,
  });
}

// Keep these for now because consumer.js still uses them.
async function decrementStock(items) {
  return updateStock('/products/decrement-stock', { items });
}

async function restoreStock(items) {
  return updateStock('/products/restore-stock', { items });
}

module.exports = {
  reserveStock,
  confirmReservation,
  releaseReservation,
  decrementStock,
  restoreStock,
};