const axios = require('axios');
require('dotenv').config();

async function getProduct(productId, requestId, authorization) {
  const response = await axios.get(
    `${process.env.CATALOG_SERVICE_URL}/products/${productId}`,
    {
      timeout: 3000,
      headers: {
        'X-Request-ID': requestId,
        Authorization: authorization,
      },
    }
  );

  return response.data;
}

module.exports = { getProduct };