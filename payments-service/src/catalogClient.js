const CATALOG_SERVICE_URL =
  process.env.CATALOG_SERVICE_URL || 'http://localhost:4001';

async function updateStock(path, body, requestId) {
  const response = await fetch(`${CATALOG_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
      'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Catalog service returned non-JSON response (${response.status}): ${text.slice(
        0,
        200
      )}`
    );
  }

  if (!response.ok) {
    const error = new Error(
      data.error || `Catalog service returned ${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  return data;
}

async function reserveStock(orderId, items, requestId) {
  return updateStock(
    '/products/reserve-stock',
    {
      orderId,
      items,
    },
    requestId
  );
}

async function confirmReservation(orderId, requestId) {
  return updateStock(
    '/products/confirm-reservation',
    {
      orderId,
    },
    requestId
  );
}

async function releaseReservation(orderId, requestId) {
  return updateStock(
    '/products/release-reservation',
    {
      orderId,
    },
    requestId
  );
}

async function refundReservation(orderId, requestId) {
  return updateStock(
    '/products/refund-reservation',
    {
      orderId,
    },
    requestId
  );
}

// Legacy stock endpoints kept for compatibility.
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
  refundReservation,
  decrementStock,
  restoreStock,
};