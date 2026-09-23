const CATALOG_SERVICE_URL =
  process.env.CATALOG_SERVICE_URL || 'http://localhost:4001';

const CATALOG_REQUEST_TIMEOUT_MS = Number(
  process.env.CATALOG_REQUEST_TIMEOUT_MS || 5000
);

async function updateStock(path, body, requestId) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CATALOG_REQUEST_TIMEOUT_MS
  );

  let response;

  try {
    response = await fetch(`${CATALOG_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
      'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(
        `Catalog service request timed out after ${CATALOG_REQUEST_TIMEOUT_MS}ms`
      );
      timeoutError.code = 'ETIMEDOUT';
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

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