const axios = require('axios');
require('dotenv').config();

async function getProduct(productId, requestId) {
  const response = await axios.get(
    `${process.env.CATALOG_SERVICE_URL}/products/${productId}`,
    {
      timeout: 3000,
      headers: {
        'X-Request-ID': requestId,
      },
    }
  );

  return response.data;
}

module.exports = { getProduct };