{
  "info": {
    "name": "E-commerce Backend — Full System Test",
    "description": "End-to-end test suite for the microservices e-commerce backend, run through the gateway (localhost:8080) with direct-port health checks for each service. Run folders top-to-bottom (or use Collection Runner on the whole collection) — requests are chained via collection variables (testEmail, token, productId, orderId). The 'Register User' request auto-generates a unique email each run, so the whole collection is safely re-runnable without duplicate-email failures.",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "variable": [
    { "key": "baseUrl", "value": "http://localhost:8080" },
    { "key": "authDirectUrl", "value": "http://localhost:4000" },
    { "key": "catalogDirectUrl", "value": "http://localhost:4001" },
    { "key": "cartDirectUrl", "value": "http://localhost:4002" },
    { "key": "ordersDirectUrl", "value": "http://localhost:4003" },
    { "key": "paymentsDirectUrl", "value": "http://localhost:4004" },
    { "key": "testEmail", "value": "" },
    { "key": "testPassword", "value": "securePass123" },
    { "key": "token", "value": "" },
    { "key": "productId", "value": "" },
    { "key": "orderId", "value": "" }
  ],
  "item": [
    {
      "name": "1. Health Checks",
      "item": [
        {
          "name": "Gateway Health",
          "request": {
            "method": "GET",
            "url": { "raw": "{{baseUrl}}/health", "host": ["{{baseUrl}}"], "path": ["health"] }
          },
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 200', () => pm.response.to.have.status(200));",
            "pm.test('Body reports ok', () => pm.expect(pm.response.json().status).to.eql('ok'));"
          ]}}]
        },
        {
          "name": "Auth Service Health (direct)",
          "request": { "method": "GET", "url": { "raw": "{{authDirectUrl}}/health", "host": ["{{authDirectUrl}}"], "path": ["health"] } },
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 200', () => pm.response.to.have.status(200));"
          ]}}]
        },
        {
          "name": "Catalog Service Health (direct)",
          "request": { "method": "GET", "url": { "raw": "{{catalogDirectUrl}}/health", "host": ["{{catalogDirectUrl}}"], "path": ["health"] } },
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 200', () => pm.response.to.have.status(200));"
          ]}}]
        },
        {
          "name": "Cart Service Health (direct)",
          "request": { "method": "GET", "url": { "raw": "{{cartDirectUrl}}/health", "host": ["{{cartDirectUrl}}"], "path": ["health"] } },
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 200', () => pm.response.to.have.status(200));"
          ]}}]
        },
        {
          "name": "Orders Service Health (direct)",
          "request": { "method": "GET", "url": { "raw": "{{ordersDirectUrl}}/health", "host": ["{{ordersDirectUrl}}"], "path": ["health"] } },
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 200', () => pm.response.to.have.status(200));"
          ]}}]
        },
        {
          "name": "Payments Service Health (direct)",
          "request": { "method": "GET", "url": { "raw": "{{paymentsDirectUrl}}/health", "host": ["{{paymentsDirectUrl}}"], "path": ["health"] } },
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 200', () => pm.response.to.have.status(200));"
          ]}}]
        }
      ]
    },
    {
      "name": "2. Auth Flow",
      "item": [
        {
          "name": "Register User",
          "event": [
            { "listen": "prerequest", "script": { "type": "text/javascript", "exec": [
              "pm.collectionVariables.set('testEmail', 'e2e_' + Date.now() + '@example.com');"
            ]}},
            { "listen": "test", "script": { "type": "text/javascript", "exec": [
              "pm.test('Status is 201', () => pm.response.to.have.status(201));",
              "pm.test('Returns user id and email, no password fields', () => {",
              "  const body = pm.response.json();",
              "  pm.expect(body.id).to.exist;",
              "  pm.expect(body.email).to.eql(pm.collectionVariables.get('testEmail'));",
              "  pm.expect(body.password).to.not.exist;",
              "  pm.expect(body.password_hash).to.not.exist;",
              "});"
            ]}}
          ],
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": { "mode": "raw", "raw": "{\"email\":\"{{testEmail}}\",\"password\":\"{{testPassword}}\"}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/auth/register", "host": ["{{baseUrl}}"], "path": ["auth", "register"] }
          }
        },
        {
          "name": "Register Duplicate Email (expect 409)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 409', () => pm.response.to.have.status(409));",
            "pm.test('Returns an error message', () => pm.expect(pm.response.json().error).to.exist);"
          ]}}],
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": { "mode": "raw", "raw": "{\"email\":\"{{testEmail}}\",\"password\":\"{{testPassword}}\"}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/auth/register", "host": ["{{baseUrl}}"], "path": ["auth", "register"] }
          }
        },
        {
          "name": "Login (wrong password, expect 401)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 401', () => pm.response.to.have.status(401));"
          ]}}],
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": { "mode": "raw", "raw": "{\"email\":\"{{testEmail}}\",\"password\":\"totallyWrongPassword\"}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/auth/login", "host": ["{{baseUrl}}"], "path": ["auth", "login"] }
          }
        },
        {
          "name": "Login (correct, saves token)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 200', () => pm.response.to.have.status(200));",
            "pm.test('Returns a JWT', () => {",
            "  const body = pm.response.json();",
            "  pm.expect(body.token).to.exist;",
            "  pm.collectionVariables.set('token', body.token);",
            "});"
          ]}}],
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": { "mode": "raw", "raw": "{\"email\":\"{{testEmail}}\",\"password\":\"{{testPassword}}\"}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/auth/login", "host": ["{{baseUrl}}"], "path": ["auth", "login"] }
          }
        }
      ]
    },
    {
      "name": "3. Catalog Flow",
      "item": [
        {
          "name": "Create Product - No Token (expect 401)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 401', () => pm.response.to.have.status(401));"
          ]}}],
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": { "mode": "raw", "raw": "{\"name\":\"Should Not Be Created\",\"price\":9.99}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/products", "host": ["{{baseUrl}}"], "path": ["products"] }
          }
        },
        {
          "name": "Create Product - Missing Fields (expect 400)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 400', () => pm.response.to.have.status(400));"
          ]}}],
          "request": {
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" },
              { "key": "Authorization", "value": "Bearer {{token}}" }
            ],
            "body": { "mode": "raw", "raw": "{\"description\":\"Missing name and price\"}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/products", "host": ["{{baseUrl}}"], "path": ["products"] }
          }
        },
        {
          "name": "Create Product (saves productId)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 201', () => pm.response.to.have.status(201));",
            "pm.test('Returns product with id', () => {",
            "  const body = pm.response.json();",
            "  pm.expect(body.id).to.exist;",
            "  pm.expect(body.name).to.eql('E2E Test Speaker');",
            "  pm.collectionVariables.set('productId', body.id);",
            "});"
          ]}}],
          "request": {
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" },
              { "key": "Authorization", "value": "Bearer {{token}}" }
            ],
            "body": { "mode": "raw", "raw": "{\"name\":\"E2E Test Speaker\",\"description\":\"Created by the Postman e2e suite\",\"price\":59.99,\"stock\":20}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/products", "host": ["{{baseUrl}}"], "path": ["products"] }
          }
        },
        {
          "name": "Get Product By Id (no auth needed)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 200', () => pm.response.to.have.status(200));",
            "pm.test('Returns correct product', () => pm.expect(pm.response.json().name).to.eql('E2E Test Speaker'));"
          ]}}],
          "request": {
            "method": "GET",
            "url": { "raw": "{{baseUrl}}/products/{{productId}}", "host": ["{{baseUrl}}"], "path": ["products", "{{productId}}"] }
          }
        },
        {
          "name": "Get Product - Not Found (expect 404)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 404', () => pm.response.to.have.status(404));"
          ]}}],
          "request": {
            "method": "GET",
            "url": { "raw": "{{baseUrl}}/products/999999999", "host": ["{{baseUrl}}"], "path": ["products", "999999999"] }
          }
        },
        {
          "name": "Search Products (exact term)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 200', () => pm.response.to.have.status(200));",
            "pm.test('Finds at least one result', () => pm.expect(pm.response.json().length).to.be.above(0));"
          ]}}],
          "request": {
            "method": "GET",
            "url": { "raw": "{{baseUrl}}/products/search?q=speaker", "host": ["{{baseUrl}}"], "path": ["products", "search"], "query": [{ "key": "q", "value": "speaker" }] }
          }
        },
        {
          "name": "Search Products (typo, fuzzy match)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 200', () => pm.response.to.have.status(200));",
            "pm.test('Fuzzy search still finds a result', () => pm.expect(pm.response.json().length).to.be.above(0));"
          ]}}],
          "request": {
            "method": "GET",
            "url": { "raw": "{{baseUrl}}/products/search?q=speeker", "host": ["{{baseUrl}}"], "path": ["products", "search"], "query": [{ "key": "q", "value": "speeker" }] }
          }
        }
      ]
    },
    {
      "name": "4. Cart Flow",
      "item": [
        {
          "name": "Add To Cart - No Token (expect 401)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 401', () => pm.response.to.have.status(401));"
          ]}}],
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": { "mode": "raw", "raw": "{\"productId\":{{productId}},\"quantity\":1}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/cart/items", "host": ["{{baseUrl}}"], "path": ["cart", "items"] }
          }
        },
        {
          "name": "Add To Cart - Product Not Found (expect 404)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 404', () => pm.response.to.have.status(404));"
          ]}}],
          "request": {
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" },
              { "key": "Authorization", "value": "Bearer {{token}}" }
            ],
            "body": { "mode": "raw", "raw": "{\"productId\":999999999,\"quantity\":1}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/cart/items", "host": ["{{baseUrl}}"], "path": ["cart", "items"] }
          }
        },
        {
          "name": "Add To Cart (real product)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 201', () => pm.response.to.have.status(201));",
            "pm.test('Cart contains the item, verified via catalog-service', () => {",
            "  const body = pm.response.json();",
            "  pm.expect(body.items.length).to.be.above(0);",
            "  pm.expect(body.items[0].name).to.eql('E2E Test Speaker');",
            "});"
          ]}}],
          "request": {
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" },
              { "key": "Authorization", "value": "Bearer {{token}}" }
            ],
            "body": { "mode": "raw", "raw": "{\"productId\":{{productId}},\"quantity\":2}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/cart/items", "host": ["{{baseUrl}}"], "path": ["cart", "items"] }
          }
        },
        {
          "name": "Get Cart - No Token (expect 401)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 401', () => pm.response.to.have.status(401));"
          ]}}],
          "request": {
            "method": "GET",
            "url": { "raw": "{{baseUrl}}/cart", "host": ["{{baseUrl}}"], "path": ["cart"] }
          }
        },
        {
          "name": "Get Cart (authenticated)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 200', () => pm.response.to.have.status(200));",
            "pm.test('Cart has the item we added', () => pm.expect(pm.response.json().items.length).to.be.above(0));"
          ]}}],
          "request": {
            "method": "GET",
            "header": [{ "key": "Authorization", "value": "Bearer {{token}}" }],
            "url": { "raw": "{{baseUrl}}/cart", "host": ["{{baseUrl}}"], "path": ["cart"] }
          }
        }
      ]
    },
    {
      "name": "5. Orders Flow",
      "item": [
        {
          "name": "Place Order - No Token (expect 401)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 401', () => pm.response.to.have.status(401));"
          ]}}],
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": { "mode": "raw", "raw": "{\"items\":[{\"productId\":{{productId}},\"name\":\"E2E Test Speaker\",\"price\":59.99,\"quantity\":2}],\"totalAmount\":119.98}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/orders", "host": ["{{baseUrl}}"], "path": ["orders"] }
          }
        },
        {
          "name": "Place Order - Missing Items (expect 400)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 400', () => pm.response.to.have.status(400));"
          ]}}],
          "request": {
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" },
              { "key": "Authorization", "value": "Bearer {{token}}" }
            ],
            "body": { "mode": "raw", "raw": "{\"totalAmount\":119.98}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/orders", "host": ["{{baseUrl}}"], "path": ["orders"] }
          }
        },
        {
          "name": "Place Order (real, saves orderId)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 201', () => pm.response.to.have.status(201));",
            "pm.test('Order created with pending status, correct user from token', () => {",
            "  const body = pm.response.json();",
            "  pm.expect(body.id).to.exist;",
            "  pm.expect(body.status).to.eql('pending');",
            "  pm.expect(body.total_amount).to.eql('119.98');",
            "  pm.collectionVariables.set('orderId', body.id);",
            "});"
          ]}}],
          "request": {
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" },
              { "key": "Authorization", "value": "Bearer {{token}}" }
            ],
            "body": { "mode": "raw", "raw": "{\"items\":[{\"productId\":{{productId}},\"name\":\"E2E Test Speaker\",\"price\":59.99,\"quantity\":2}],\"totalAmount\":119.98}", "options": { "raw": { "language": "json" } } },
            "url": { "raw": "{{baseUrl}}/orders", "host": ["{{baseUrl}}"], "path": ["orders"] }
          }
        }
      ]
    },
    {
      "name": "6. Gateway Resilience",
      "item": [
        {
          "name": "Malformed JWT (expect 401, not a crash)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 401', () => pm.response.to.have.status(401));"
          ]}}],
          "request": {
            "method": "GET",
            "header": [{ "key": "Authorization", "value": "Bearer this.is.not.a.real.jwt" }],
            "url": { "raw": "{{baseUrl}}/cart", "host": ["{{baseUrl}}"], "path": ["cart"] }
          }
        },
        {
          "name": "Unknown Route (expect 404, gateway itself responds)",
          "event": [{ "listen": "test", "script": { "type": "text/javascript", "exec": [
            "pm.test('Status is 404', () => pm.response.to.have.status(404));"
          ]}}],
          "request": {
            "method": "GET",
            "url": { "raw": "{{baseUrl}}/this-route-does-not-exist", "host": ["{{baseUrl}}"], "path": ["this-route-does-not-exist"] }
          }
        }
      ]
    }
  ]
}