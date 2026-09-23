# 🛒 E-Commerce Backend — Distributed Microservices Platform

A production-oriented **Node.js microservices backend** designed to demonstrate practical backend engineering and distributed-systems patterns used in modern e-commerce platforms.

The system consists of independently deployable services with **database-per-service isolation**, synchronous REST communication, asynchronous event-driven workflows, centralized API routing, resilient message processing, inventory reservation, payment processing, and reconciliation.

The complete stack can be run locally using **Docker Compose** and deployed using **Kubernetes**.

---

## ✨ Engineering Highlights

* 🔐 **Defense-in-depth JWT authentication** — every protected service independently validates JWTs
* 🧩 **Database-per-service architecture** using PostgreSQL and Redis
* 🌐 **API Gateway** for centralized routing and rate limiting
* 🔎 **Elasticsearch fuzzy product search**
* 🛒 **Redis-backed shopping carts**
* 📦 **Inventory management and stock reservation**
* 💳 **Asynchronous payment processing**
* 📨 **RabbitMQ event-driven communication**
* 🔁 **Transactional Outbox Pattern** for reliable event publication
* ♻️ **Idempotent order processing**
* ☠️ **Dead-Letter Queues** for failed or unprocessable messages
* 🔄 **RabbitMQ connection recovery with retry and backoff**
* ❌ **Order cancellation and payment reconciliation**
* 🧾 **Centralized structured logging with Elasticsearch**
* 🚦 **API Gateway rate limiting**
* 🐳 **Docker Compose containerization**
* ☸️ **Kubernetes deployment**
* 🧪 **Unit, integration, and end-to-end testing**
* ⚙️ **GitHub Actions CI**

---

# 🏗️ Architecture

```text
                                  ┌──────────────────┐
                                  │      Client      │
                                  └────────┬─────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │   API Gateway    │
                                  │    Express.js    │
                                  │       :8080      │
                                  └────────┬─────────┘
                                           │
             ┌───────────────┬─────────────┼──────────────┬───────────────┐
             │               │             │              │               │
             ▼               ▼             ▼              ▼               ▼
        ┌─────────┐    ┌──────────┐   ┌─────────┐   ┌─────────┐    ┌──────────┐
        │  Auth   │    │ Catalog  │   │  Cart   │   │ Orders  │    │ Payments │
        │  :4000  │    │  :4001   │   │  :4002  │   │  :4003  │    │  :4004   │
        └────┬────┘    └────┬─────┘   └────┬────┘   └────┬────┘    └────┬─────┘
             │               │              │              │              │
             ▼               ▼              ▼              ▼              │
        PostgreSQL      PostgreSQL       Redis        PostgreSQL          │
        auth_db        catalog_db                     orders_db           │
                            │                             │                │
                            ▼                             │                │
                      Elasticsearch                      │                │
                                                          │                │
                                                          ▼                ▼
                                                    ┌────────────────────────┐
                                                    │       RabbitMQ          │
                                                    │                        │
                                                    │ order_placed           │
                                                    │ payment_processed      │
                                                    │ refund_requested       │
                                                    │ refund_processed       │
                                                    │ Dead-letter queues      │
                                                    └────────────────────────┘
```

## Service Responsibilities

| Service              |   Port | Storage                    | Responsibility                                             |
| -------------------- | -----: | -------------------------- | ---------------------------------------------------------- |
| **API Gateway**      | `8080` | —                          | Single entry point, request routing and rate limiting      |
| **Auth Service**     | `4000` | PostgreSQL                 | Registration, login, JWT issuance and authentication       |
| **Catalog Service**  | `4001` | PostgreSQL + Elasticsearch | Products, inventory and fuzzy search                       |
| **Cart Service**     | `4002` | Redis                      | User cart management and product validation                |
| **Orders Service**   | `4003` | PostgreSQL                 | Orders, cancellation, idempotency and transactional outbox |
| **Payments Service** | `4004` | PostgreSQL                 | Payment processing, reconciliation and event consumption   |

Each service owns its persistence layer and is independently testable and deployable.

---

# 🔐 Authentication & Authorization

Authentication follows a **defense-in-depth** model.

The API Gateway provides centralized routing, but protected services do not blindly trust the Gateway.

Each protected service independently validates the JWT before processing the request.

```text
Client
   │
   │ Authorization: Bearer <JWT>
   ▼
API Gateway
   │
   ▼
Protected Service
   │
   ├── Verify JWT
   ├── Extract user identity
   └── Process request
```

User identity is derived from the verified JWT rather than trusted request-body or URL parameters.

For example:

```text
POST /cart/items
```

does not accept a `userId`.

This prevents a client from supplying another user's identifier when accessing protected resources.

The system also supports **role-based access control**, including an `admin` role for privileged catalog operations.

---

# 🔄 Communication Patterns

The system uses both **synchronous HTTP** and **asynchronous messaging**, depending on the consistency and latency requirements of each workflow.

## 1. Synchronous HTTP

The Cart Service communicates with the Catalog Service when validating products before adding them to a cart.

```text
Cart Service
      │
      │ HTTP
      ▼
Catalog Service
      │
      ├── Product exists?
      ├── Product available?
      └── Current product data?
```

### Why HTTP?

The Cart Service requires an immediate response before modifying the cart.

If the Catalog Service is unavailable, the request fails with a controlled `503` response rather than adding an unverified product.

### Trade-off

This introduces temporary runtime coupling between the services.

---

## 2. Asynchronous Event-Driven Communication

Order and payment processing are decoupled through RabbitMQ.

```text
Orders Service
      │
      │ order_placed
      ▼
   RabbitMQ
      │
      ▼
Payments Service
      │
      │ payment_processed
      ▼
   RabbitMQ
      │
      ▼
Orders Service
```

The Orders Service does not synchronously wait for payment processing before returning the initial order response.

### Benefits

* Loose coupling
* Independent service scaling
* Better resilience to temporary failures
* Asynchronous processing
* Eventual consistency

---

# 📦 Order & Payment Flow

```text
Client
  │
  ▼
API Gateway
  │
  ▼
Orders Service
  │
  ├── BEGIN TRANSACTION
  ├── Create order
  ├── Reserve inventory
  ├── Create outbox event
  └── COMMIT
          │
          ▼
    Outbox Poller
          │
          ▼
       RabbitMQ
          │
          ▼
   Payments Service
          │
          ├── Process payment
          ├── Persist payment state
          └── Publish payment_processed
                         │
                         ▼
                  Orders Service
                         │
                         ▼
                  Update order status
```

The system uses an **eventual consistency** model between order creation and payment processing.

The initial order transaction persists the business state and corresponding outbox event atomically. Payment processing then happens asynchronously.

---

# 🔁 Transactional Outbox Pattern

The Orders Service uses the **Transactional Outbox Pattern** to avoid the classic dual-write problem.

Without an outbox:

```text
Create Order
     │
     ▼
Database ──────── success
     │
     ▼
Publish Event ─── failure
```

The order would exist while the corresponding event could be lost.

With the outbox:

```text
BEGIN TRANSACTION

    ├── INSERT order
    │
    ├── Reserve inventory
    │
    └── INSERT outbox_event

COMMIT
```

Both the order and outbox record succeed or roll back together.

A background poller periodically checks for unpublished events and publishes them to RabbitMQ.

If RabbitMQ is temporarily unavailable, the event remains persisted in PostgreSQL and can be retried later.

This provides reliable event publication without requiring PostgreSQL and RabbitMQ to participate in a distributed transaction.

---

# ♻️ Idempotency

The system handles duplicate requests and duplicate events at different levels.

## API-Level Idempotency

Order creation supports an `Idempotency-Key` to prevent retries from creating duplicate orders.

```text
Client
   │
   │ Request + Idempotency-Key
   ▼
Orders Service
   │
   ├── First request → create order
   │
   └── Retry → return existing result
```

The Gateway forwards the idempotency key to the Orders Service so the business service can enforce the behavior.

## Event-Level Idempotency

RabbitMQ provides **at-least-once delivery** semantics.

A consumer can therefore receive the same event more than once—for example, when processing succeeds but the consumer fails before acknowledging the message.

Consumers are designed to make business processing safe against duplicate event delivery.

---

# 📦 Inventory Management

Inventory is managed by the Catalog Service.

Products contain stock information, while inventory reservations associate stock with an order lifecycle.

```text
Product
 ├── product_id
 ├── price
 └── stock

Inventory Reservation
 ├── order_id
 ├── product_id
 ├── quantity
 ├── status
 ├── created_at
 └── expires_at
```

Inventory is **reserved as part of order processing** rather than being treated as a simple static product attribute.

Reservations use uniqueness constraints to prevent duplicate reservations for the same order and product.

Inventory can subsequently be released when the corresponding order workflow requires it, such as cancellation, refund, or reservation expiration.

This prevents overselling while keeping inventory state coordinated with the order lifecycle.

---

# 💳 Payment Processing & Reconciliation

Payments are processed asynchronously after an order is placed.

The system also includes **payment reconciliation** to handle temporary inconsistencies between payment and order state.

```text
Order
  │
  │ order_placed
  ▼
Payment Processing
  │
  ├── Success
  │
  └── Failure / delayed processing
          │
          ▼
     Reconciliation
          │
          ▼
    Correct final state
```

The reconciliation workflow is designed to prevent temporary distributed-state inconsistencies from becoming permanent business-state errors.

---

# ❌ Order Cancellation

Orders can only be cancelled when their current state permits cancellation.

The system validates order state before performing cancellation to protect against races between payment processing and cancellation.

```text
Payment Processing
        │
        ▼
Order Completion
       vs.
Order Cancellation
        │
        ▼
Order Cancelled
```

A completed order cannot be incorrectly transitioned back to a cancellable state after payment processing has finalized it.

Cancellation and refund workflows also interact with inventory and payment state where required.

---

# 📨 RabbitMQ Reliability

RabbitMQ provides asynchronous communication between Orders and Payments services.

The messaging layer includes:

* Durable event-processing workflows
* Consumer acknowledgements
* Retry handling
* Dead-Letter Queues
* Connection recovery
* Reconnection backoff
* Idempotent event processing
* Payment events
* Refund events

---

# 🔄 Self-Healing RabbitMQ Connections

Orders and Payments Services monitor RabbitMQ connection lifecycle events.

If RabbitMQ becomes unavailable:

```text
RabbitMQ
   │
   X Connection lost
   │
   ▼
Service detects failure
   │
   ▼
Wait / Backoff
   │
   ▼
Reconnect
   │
   ├── Success → Resume processing
   │
   └── Failure → Retry
```

The connection recovery behavior has been tested against real RabbitMQ outages.

For example:

```bash
docker stop rabbitmq
docker start rabbitmq
```

The affected services can recover their RabbitMQ connections without requiring a manual application restart.

---

# ☠️ Dead-Letter Queues

Messages that cannot be successfully processed are routed to a Dead-Letter Queue rather than being silently discarded.

```text
order_placed
     │
     ▼
Payments Consumer
     │
     ├── Valid → Process
     │
     └── Invalid / Unprocessable
              │
              ▼
       order_placed_dlq
```

Dead-lettered messages can be inspected through the RabbitMQ management interface for debugging and operational investigation.

---

# 🚦 API Gateway Rate Limiting

The API Gateway provides rate limiting to protect downstream services from excessive request traffic.

```text
Client
   │
   ▼
Gateway
   │
   ├── Within limit → Forward request
   │
   └── Limit exceeded → Reject request
```

The current implementation uses an in-memory limiter.

For a multi-replica production deployment, a shared Redis-backed rate-limit store would provide consistent limits across Gateway instances.

---

# 🧾 Centralized Structured Logging

The services use structured logging to make distributed workflows easier to diagnose.

Logs contain structured fields such as:

```text
timestamp
service
level
message
requestId
orderId
userId
eventType
```

Logs are shipped to Elasticsearch, allowing logs to be searched and filtered across services.

Example:

```text
service: orders-service
eventType: order_placed
orderId: 42
requestId: 7f8...
level: info
```

Structured logging makes it easier to trace business workflows and investigate failures across multiple containers.

---

# 🔎 Elasticsearch Product Search

The Catalog Service stores product data in PostgreSQL and maintains an Elasticsearch search index.

This provides:

* Fuzzy search
* Partial matching
* Fast product discovery
* Search independent of relational database queries

Example:

```text
GET /products/search?q=iphon
```

can return products matching terms such as:

```text
iPhone
iPhone Case
iPhone Charger
```

PostgreSQL remains the primary source of product data while Elasticsearch acts as the search index.

---

# 🛒 Redis Cart Storage

Cart data is stored in Redis because carts are ephemeral and frequently accessed.

```text
User
 │
 ▼
Cart Service
 │
 ▼
Redis
 │
 └── user cart
```

Before adding an item, the Cart Service validates the product against the Catalog Service.

This prevents invalid or nonexistent products from being added to carts.

---

# 🐳 Docker Compose

The complete distributed environment can be started locally using Docker Compose.

The environment includes:

* API Gateway
* Auth Service
* Catalog Service
* Cart Service
* Orders Service
* Payments Service
* PostgreSQL databases
* Redis
* Elasticsearch
* RabbitMQ

Service dependencies use health checks where appropriate so application services start against ready infrastructure.

---

# ☸️ Kubernetes

The project includes Kubernetes manifests for local deployment.

```text
k8s/

├── redis.yaml
├── auth-db.yaml
├── auth-service.yaml
├── catalog-db.yaml
├── elasticsearch.yaml
├── catalog-service.yaml
├── cart-service.yaml
├── rabbitmq.yaml
├── orders-db.yaml
├── orders-service.yaml
├── payments-service.yaml
└── gateway.yaml
```

The application has been tested using **Docker Desktop's local Kubernetes cluster**.

The manifests include resource requests/limits, readiness and liveness probes, non-root application containers, dropped Linux capabilities, `RuntimeDefault` seccomp profiles, and Kubernetes Secret references.

The current Kubernetes environment is intentionally sized for local development and reliability testing:

* A single Kubernetes node is used.
* Stateless application services currently run with one replica each.
* PostgreSQL, RabbitMQ, Elasticsearch, and Redis are currently single-instance deployments.
* PostgreSQL, RabbitMQ, and Elasticsearch use PersistentVolumeClaims.
* Redis is intentionally ephemeral; loss of the Redis pod or its storage can lose active cart data.
* Production high availability would require a multi-node cluster plus deliberate HA designs for the stateful dependencies.

---

# 🛠️ Tech Stack

| Category         | Technology               |
| ---------------- | ------------------------ |
| Runtime          | Node.js                  |
| Framework        | Express.js               |
| Databases        | PostgreSQL               |
| Cache / Cart     | Redis                    |
| Search           | Elasticsearch            |
| Message Broker   | RabbitMQ                 |
| Authentication   | JWT                      |
| Containerization | Docker, Docker Compose   |
| Orchestration    | Kubernetes               |
| Testing          | Jest, Supertest, Postman |
| CI               | GitHub Actions           |
| Logging          | Winston + Elasticsearch  |

---

# 📁 Project Structure

```text
ecommerce-backend/

├── gateway/
│   ├── src/
│   │   ├── app.js
│   │   └── ...
│   ├── tests/
│   ├── Dockerfile
│   └── package.json
│
├── auth-service/
│   ├── src/
│   │   ├── app.js
│   │   ├── index.js
│   │   ├── db.js
│   │   └── middleware/auth.js
│   ├── tests/
│   ├── Dockerfile
│   └── package.json
│
├── catalog-service/
│   ├── src/
│   │   ├── app.js
│   │   ├── db.js
│   │   ├── es.js
│   │   └── middleware/auth.js
│   ├── tests/
│   ├── Dockerfile
│   └── package.json
│
├── cart-service/
│   ├── src/
│   │   ├── app.js
│   │   ├── redisClient.js
│   │   ├── catalogClient.js
│   │   └── middleware/auth.js
│   ├── tests/
│   ├── Dockerfile
│   └── package.json
│
├── orders-service/
│   ├── src/
│   │   ├── app.js
│   │   ├── db.js
│   │   ├── rabbitmq.js
│   │   ├── outboxPoller.js
│   │   └── middleware/auth.js
│   ├── tests/
│   ├── Dockerfile
│   └── package.json
│
├── payments-service/
│   ├── src/
│   │   ├── app.js
│   │   ├── consumer.js
│   │   └── payment-logic.js
│   ├── tests/
│   ├── Dockerfile
│   └── package.json
│
├── k8s/
│   ├── redis.yaml
│   ├── auth-db.yaml
│   ├── auth-service.yaml
│   ├── catalog-db.yaml
│   ├── elasticsearch.yaml
│   ├── catalog-service.yaml
│   ├── cart-service.yaml
│   ├── rabbitmq.yaml
│   ├── orders-db.yaml
│   ├── orders-service.yaml
│   ├── payments-service.yaml
│   └── gateway.yaml
│
├── ecommerce-backend.postman_collection.json
├── docker-compose.yml
├── .gitignore
└── README.md
```

---

# 🚀 Getting Started

## Prerequisites

* Docker
* Docker Compose
* Git

## 1. Clone the Repository

```bash
git clone https://github.com/Sudiksha-chugh/ecommerce-backend.git
cd ecommerce-backend
```

## 2. Start the Stack

```bash
docker compose up -d --build
```

## 3. Verify Containers

```bash
docker compose ps
```

View all logs:

```bash
docker compose logs -f
```

View a specific service:

```bash
docker compose logs -f orders-service
```

## 4. Stop the Environment

```bash
docker compose down
```

To remove database and cache volumes:

```bash
docker compose down -v
```

> ⚠️ Removing volumes deletes local database and cache data.

---

# 🌐 API Quick Start

Client requests should normally go through the API Gateway:

```text
http://localhost:8080
```

## Register

```bash
curl -X POST http://localhost:8080/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourPassword"}'
```

## Login

```bash
curl -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourPassword"}'
```

Save the returned JWT.

## Search Products

```bash
curl "http://localhost:8080/products/search?q=hub"
```

## Create a Product

Creating products requires an authenticated user with the appropriate role.

```bash
curl -X POST http://localhost:8080/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name":"USB-C Hub",
    "description":"7-in-1 adapter",
    "price":34.99,
    "stock":20
  }'
```

## Add Product to Cart

```bash
curl -X POST http://localhost:8080/cart/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "productId":2,
    "quantity":3
  }'
```

## Create Order

```bash
curl -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Idempotency-Key: unique-request-id" \
  -d '{
    "items":[
      {
        "productId":2,
        "name":"USB-C Hub",
        "price":34.99,
        "quantity":3
      }
    ],
    "totalAmount":104.97
  }'
```

The authenticated user's identity is extracted from the verified JWT rather than accepted from the request body.

---

# 🐰 RabbitMQ Management

RabbitMQ's management dashboard is available at:

```text
http://localhost:15672
```

Default local credentials:

```text
guest / guest
```

The dashboard can be used to inspect:

* `order_placed`
* `payment_processed`
* `refund_requested`
* `refund_processed`
* Dead-Letter Queues
* Queue depth
* Consumer status
* Individual messages

---

# 🧪 Testing

Each service maintains its own isolated Jest test suite.

The project currently has **109/109 automated tests passing** across all six services.

| Service          |   Tests |
| ---------------- | ------: |
| Auth Service     |      12 |
| Catalog Service  |      31 |
| Cart Service     |       9 |
| Orders Service   |      30 |
| Payments Service |      22 |
| Gateway          |       5 |
| **Total**        | **109** |

## Running Tests

### Auth Service

```bash
docker compose exec -e NODE_ENV=test -e DB_NAME_TEST=auth_db_test \
  auth-service npm test -- --runInBand
```

### Catalog Service

```bash
docker compose exec -e NODE_ENV=test -e DB_NAME_TEST=catalog_db_test \
  catalog-service npm test -- --runInBand
```

### Cart Service

```bash
docker compose exec cart-service npm test -- --runInBand
```

### Orders Service

```bash
docker compose exec -e NODE_ENV=test -e DB_NAME_TEST=orders_db_test \
  orders-service npm test -- --runInBand
```

### Payments Service

```bash
docker compose exec -e NODE_ENV=test -e DB_NAME_TEST=payments_db_test \
  payments-service npm test -- --runInBand
```

### Gateway

```bash
docker compose exec gateway npm test -- --runInBand
```

## Test Coverage

The automated suites cover both normal functionality and distributed-system failure scenarios.

### Authentication

* Registration
* Login
* Duplicate registration
* Invalid credentials
* JWT validation
* Authorization
* Role-based access control

### Catalog

* Product creation
* Product retrieval
* Product validation
* Search
* Fuzzy search
* Inventory reservation
* Inventory release
* Stock validation
* Inventory edge cases

### Cart

* Authentication
* Product validation
* Cart creation
* Cart retrieval
* Cart item operations
* Catalog service failures

### Orders

* Order creation
* Authentication
* Database persistence
* Idempotency
* Transactional outbox
* Transaction rollback
* Inventory reservation
* Cancellation
* Failure scenarios
* Event publication

### Payments

* Message consumption
* Payment processing
* Payment persistence
* Event publication
* Duplicate event handling
* Acknowledgement
* Invalid message handling
* Dead-letter behavior
* Refund processing
* Reconciliation
* RabbitMQ reconnection and retry behavior

### Gateway

* Request proxying
* Authentication forwarding
* Idempotency-key forwarding
* Downstream service failures
* Graceful `503` handling
* Invalid routes and JWT handling

---

# 🔗 End-to-End Testing

The project includes an executable Postman collection:

```text
ecommerce-backend.postman_collection.json
```

The collection runs against the real API Gateway at:

```text
http://localhost:8080
```

Start the backend before running the collection:

```bash
docker compose up -d
```

The collection covers:

* Service health checks
* User registration
* Login
* JWT authentication
* Catalog operations
* Product validation
* Exact product search
* Fuzzy product search
* Cart operations
* Order creation
* Token-derived user identity
* Gateway error handling
* Invalid JWT handling
* Unknown routes

Requests should be executed from top to bottom because the collection uses variables generated by previous requests, including:

* `token`
* `productId`
* `orderId`
* `testEmail`

The Postman collection provides live API-level verification through the Gateway, while the Jest suites provide deeper service-level coverage of reliability and failure scenarios.

---

# ⚙️ Environment Configuration

Each service can use its own `.env` file during local development.

Example:

```env
PORT=4000

DB_HOST=localhost
DB_PORT=5433
DB_USER=auth_user
DB_PASSWORD=auth_pass
DB_NAME=auth_db
DB_NAME_TEST=auth_db_test

JWT_CURRENT_SECRET=your-current-secret-at-least-32-characters
JWT_PREVIOUS_SECRET=your-previous-secret-at-least-32-characters
```

`JWT_CURRENT_SECRET` is used for newly issued JWTs. `JWT_PREVIOUS_SECRET` is optional and allows tokens signed with the previous secret to remain valid during a secret-rotation window.

When rotating the JWT secret, move the existing current secret to `JWT_PREVIOUS_SECRET` and generate a new value for `JWT_CURRENT_SECRET`. The current and previous secrets must be different and each must be at least 32 characters long.

Services that independently verify JWTs must receive the same current/previous secret pair during the rotation window.

### JWT Secret Rotation

1. Generate a new random value for `JWT_CURRENT_SECRET`.
2. Move the existing `JWT_CURRENT_SECRET` value to `JWT_PREVIOUS_SECRET`.
3. Set the new value as `JWT_CURRENT_SECRET`.
4. Update the secret configuration for every service that independently verifies JWTs:
   * `auth-service`
   * `catalog-service`
   * `cart-service`
   * `orders-service`
5. Restart or roll out those services so they load the new secret pair.
6. Verify that:
   * newly issued JWTs use the new current secret;
   * JWTs signed with the previous secret remain valid during the rotation window;
   * JWTs signed with an unrelated secret are rejected.
7. After the rotation window has ended and old tokens are no longer expected to be valid, remove `JWT_PREVIOUS_SECRET` and restart/roll out the affected services.

Never commit JWT secrets, `.env` files, Kubernetes secret manifests containing real values, or other credential material to Git.

Docker Compose uses service DNS names for internal communication:

```env
AUTH_SERVICE_URL=http://auth-service:4000

CATALOG_SERVICE_URL=http://catalog-service:4001

RABBITMQ_URL=amqp://<RABBITMQ_USER>:<RABBITMQ_PASSWORD>@rabbitmq:5672

REDIS_URL=redis://redis:6379
```

Kubernetes uses Kubernetes Service names for service-to-service communication.

---

# ⚙️ Continuous Integration

GitHub Actions runs the service test suites automatically on pushes and pull requests to `main`.

The CI environment provisions the infrastructure required by the test suites, including:

* PostgreSQL
* Redis
* Elasticsearch
* RabbitMQ

Each service test suite executes independently, allowing failures to be isolated to the affected service.

Dependencies are installed using `npm ci` to provide reproducible CI and container builds based on committed lockfiles.

---

# ☸️ Kubernetes Deployment

The application can be deployed to Docker Desktop's Kubernetes cluster.

Enable Kubernetes in Docker Desktop and verify:

```bash
kubectl get nodes
```

Build a service image:

```bash
docker build -t <service-name>:local ./<service-name>
```

Tag the image:

```bash
docker tag <service-name>:local \
  <your-dockerhub-username>/<service-name>:local
```

Push the image:

```bash
docker push \
  <your-dockerhub-username>/<service-name>:local
```

Update the corresponding Kubernetes manifests with the image names.

Apply the infrastructure and services:

```bash
kubectl apply -f k8s/redis.yaml

kubectl apply -f k8s/auth-db.yaml
kubectl apply -f k8s/auth-service.yaml

kubectl apply -f k8s/catalog-db.yaml
kubectl apply -f k8s/elasticsearch.yaml
kubectl apply -f k8s/catalog-service.yaml

kubectl apply -f k8s/cart-service.yaml

kubectl apply -f k8s/rabbitmq.yaml

kubectl apply -f k8s/orders-db.yaml
kubectl apply -f k8s/orders-service.yaml

kubectl apply -f k8s/payments-service.yaml

kubectl apply -f k8s/gateway.yaml
```

Verify:

```bash
kubectl get pods
kubectl get services
```

---

# ⚠️ Current Limitations

The project intentionally keeps several areas simplified compared with a production deployment.

### Distributed Tracing

The application currently propagates request identifiers but does not yet implement a complete distributed tracing system such as OpenTelemetry with Jaeger or another tracing backend.

### Metrics

Prometheus/Grafana monitoring has not yet been integrated.

### Gateway Rate Limiting

The current rate limiter uses in-memory state.

A shared Redis-backed implementation would be preferable when running multiple Gateway replicas.

### Database Migrations

Database schemas are currently initialized through application/database setup rather than a dedicated migration framework.

A production deployment would use a migration system such as:

* Flyway
* Liquibase
* Prisma Migrate
* Knex migrations

### Kubernetes Secrets

Secrets are currently represented through Kubernetes configuration.

A production deployment should use dedicated secrets management such as:

* Kubernetes Secrets with appropriate access controls
* External Secrets
* HashiCorp Vault
* Cloud-provider secret managers

### Container Registry

The Kubernetes workflow currently uses Docker Hub images.

A production deployment would typically use a private registry with appropriate image-pull credentials and image scanning.

---

# 🗺️ Roadmap

## Completed

* [x] JWT authentication
* [x] Defense-in-depth authentication
* [x] Role-based access control
* [x] Database-per-service architecture
* [x] API Gateway
* [x] Gateway rate limiting
* [x] Redis-backed carts
* [x] Elasticsearch fuzzy search
* [x] Inventory management
* [x] Inventory reservation and release
* [x] Transactional Outbox Pattern
* [x] RabbitMQ event-driven communication
* [x] Retry and Dead-Letter Queues
* [x] RabbitMQ connection recovery
* [x] Idempotency handling
* [x] Request ID propagation
* [x] Order cancellation
* [x] Payment reconciliation
* [x] Centralized structured logging
* [x] Docker Compose environment
* [x] Kubernetes deployment
* [x] Postman end-to-end testing
* [x] GitHub Actions CI
* [x] All six service test suites passing

## Planned

* [ ] OpenTelemetry distributed tracing
* [ ] Prometheus metrics
* [ ] Grafana dashboards
* [ ] Kubernetes Ingress
* [ ] Horizontal Pod Autoscaling
* [ ] Production secrets management
* [ ] Private container registry
* [ ] Automated deployment pipeline

---

# 🎯 Microservices & Distributed-System Concepts Demonstrated

This project demonstrates practical implementation of:

* **Microservices architecture**
* **Database-per-service pattern**
* **API Gateway pattern**
* **Synchronous service-to-service HTTP**
* **Asynchronous event-driven architecture**
* **Publish/subscribe messaging**
* **Transactional Outbox Pattern**
* **Eventual consistency**
* **Idempotency**
* **At-least-once message delivery**
* **Dead-Letter Queues**
* **Retry with backoff**
* **Connection self-healing**
* **Defense-in-depth authentication**
* **Role-Based Access Control**
* **Distributed transaction considerations**
* **Inventory reservation**
* **Order state management**
* **Payment reconciliation**
* **Redis ephemeral storage**
* **Elasticsearch indexing and fuzzy search**
* **Centralized structured logging**
* **Request correlation**
* **API rate limiting**
* **Containerization**
* **Kubernetes orchestration**
* **Independent service testing**
* **End-to-end API testing**
* **CI automation**

---

# 🔮 Future Production Improvements

For a larger production deployment, the architecture could be extended with:

* OpenTelemetry distributed tracing
* Prometheus metrics
* Grafana dashboards
* Kubernetes Horizontal Pod Autoscaling
* Kubernetes Ingress
* Managed PostgreSQL
* Managed Redis
* Highly available RabbitMQ
* Highly available RabbitMQ with replicated/dedicated production infrastructure
* Database migration tooling
* Dedicated secrets management
* Private container registry
* Automated deployment pipelines
* Centralized alerting
* Circuit breakers for synchronous service dependencies
* API contract testing
* Distributed configuration management
* Automated database backups and disaster recovery

---

# 👩‍💻 Author

**Sudiksha Chugh**

Built to explore practical **backend engineering, microservices, distributed systems, reliability engineering, and cloud-native architecture**.
