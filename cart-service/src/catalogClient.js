const axios = require('axios');
require('dotenv').config();

async function getProduct(productId) {
  const response = await axios.get(
    `${process.env.CATALOG_SERVICE_URL}/products/${productId}`,
    { timeout: 3000 }
  );
  return response.data;
}

module.exports = { getProduct };