# 🛒 E-Commerce Backend — Distributed Microservices Platform

A production-oriented **Node.js microservices backend** designed to demonstrate real-world distributed-system and backend engineering patterns used in modern e-commerce platforms.

The system consists of independently deployable services with **database-per-service isolation**, synchronous REST communication, asynchronous event-driven workflows, centralized API routing, resilient message processing, inventory management, and payment reconciliation.

The complete stack can be run locally using **Docker Compose** and deployed using **Kubernetes**.

---

## ✨ Engineering Highlights

* 🔐 **Defense-in-depth JWT authentication** — every protected service independently validates tokens
* 🧩 **Database-per-service architecture** using PostgreSQL and Redis
* 🌐 **API Gateway** for centralized routing and rate limiting
* 🔎 **Elasticsearch fuzzy product search**
* 🛒 **Redis-backed shopping carts**
* 📦 **Inventory management and stock reservation**
* 💳 **Asynchronous payment processing**
* 📨 **RabbitMQ event-driven communication**
* 🔁 **Transactional Outbox Pattern** for reliable event publishing
* ♻️ **Idempotent order/payment processing**
* ☠️ **Dead-Letter Queues** for failed/unprocessable messages
* 🔄 **RabbitMQ connection recovery with retry and backoff**
* ❌ **Order cancellation and payment reconciliation**
* 🧾 **Centralized structured logging**
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
                                                    │ refund_processed        │
                                                    │ Dead-letter queues      │
                                                    └────────────────────────┘
```

### Service Responsibilities

| Service              |   Port | Storage                    | Responsibility                                           |
| -------------------- | -----: | -------------------------- | -------------------------------------------------------- |
| **API Gateway**      | `8080` | —                          | Single entry point, routing and rate limiting            |
| **Auth Service**     | `4000` | PostgreSQL                 | Registration, login, JWT issuance and authentication     |
| **Catalog Service**  | `4001` | PostgreSQL + Elasticsearch | Products, inventory and fuzzy search                     |
| **Cart Service**     | `4002` | Redis                      | User cart management and product validation              |
| **Orders Service**   | `4003` | PostgreSQL                 | Orders, cancellation and transactional outbox            |
| **Payments Service** | `4004` | PostgreSQL                 | Payment processing, reconciliation and event consumption |

---

# 🔐 Authentication & Authorization

Authentication follows a **defense-in-depth** approach.

The API Gateway provides centralized routing, but protected services do not blindly trust the Gateway.

Each service independently validates the JWT before processing protected requests.

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
   │
   ├── Extract user identity
   │
   └── Process request
```

User identity is derived from the verified JWT rather than trusted request-body or URL parameters.

For example:

```text
POST /cart/items
```

does not accept a `userId`.

This prevents a client from modifying another user's identifier and attempting to access their cart.

The system also supports **role-based access control**, including an `admin` role for privileged operations.

---

# 🔄 Communication Patterns

The architecture uses both **synchronous HTTP** and **asynchronous messaging**, depending on the consistency and latency requirements of each operation.

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
      └── Current price?
```

### Why HTTP?

The Cart Service requires an immediate response before modifying the cart.

If the Catalog Service is unavailable, the request fails with a controlled `503` rather than hanging or adding an unverified product.

### Trade-off

The services are temporarily coupled during the request.

---

## 2. Asynchronous Event-Driven Communication

Order and payment processing are intentionally decoupled.

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

The Orders Service does not need to wait synchronously for payment processing before responding to the client.

### Benefits

* Loose coupling
* Independent scaling
* Better resilience to temporary service failures
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
  │
  ├── Create order
  │
  ├── Create outbox event
  │
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
          │
          ├── Persist payment state
          │
          └── Publish payment_processed
                         │
                         ▼
                  Orders Service
                         │
                         ▼
                  Update order status
```

The system therefore follows an **eventual consistency** model between order creation and payment processing.

---

# 🔁 Transactional Outbox Pattern

The Orders Service uses the **Transactional Outbox Pattern** to prevent the classic dual-write problem.

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

The order would exist, but the event could be lost.

With the outbox:

```text
BEGIN TRANSACTION

    ├── INSERT order
    │
    └── INSERT outbox_event

COMMIT
```

Both records succeed or both roll back.

A background poller periodically checks for unpublished events and publishes them to RabbitMQ.

If RabbitMQ is temporarily unavailable, the event remains in PostgreSQL and can be retried later.

This provides reliable event publication without requiring the database transaction and RabbitMQ operation to participate in a distributed transaction.

---

# ♻️ Idempotency

The system handles retries at different levels.

### API-level idempotency

Idempotency keys prevent retrying the same client request from creating duplicate business operations.

```text
Client
   │
   │ Request + Idempotency-Key
   ▼
Orders Service
   │
   ├── First request → process
   │
   └── Retry → return existing result
```

### Event-level idempotency

RabbitMQ provides **at-least-once delivery**.

A consumer may therefore receive the same event more than once, for example if processing succeeds but the consumer crashes before acknowledging the message.

Consumers must therefore make business processing safe against duplicate delivery.

---

# 💳 Payment Processing & Reconciliation

Payments are processed asynchronously after an order is placed.

The system also includes **payment status reconciliation** to handle cases where the order and payment states temporarily become inconsistent.

Example:

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

This prevents temporary distributed-state inconsistencies from becoming permanent business-state errors.

---

# 📦 Inventory Management

Inventory is maintained by the Catalog Service.

Products contain stock information and inventory reservation records.

Example inventory model:

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

Reservations are associated with an order and product using a uniqueness constraint to prevent duplicate reservations for the same order/product combination.

Inventory state is therefore treated as part of the order lifecycle rather than simply being a static product attribute.

---

# ❌ Order Cancellation

Orders can be cancelled only when their current state permits cancellation.

The system protects against race conditions between:

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

State validation prevents a completed order from being incorrectly cancelled after payment processing has already finalized it.

---

# 📨 RabbitMQ Reliability

RabbitMQ is used for asynchronous communication between services.

The system includes:

* Durable event-processing workflow
* Dead-letter queues
* Retry handling
* Connection recovery
* Backoff between reconnection attempts
* Consumer acknowledgement
* Idempotent processing
* Payment and refund events

---

## 🔄 Self-Healing RabbitMQ Connections

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

This behavior has been tested using real RabbitMQ outages rather than relying only on mocked tests.

For example:

```bash
docker stop rabbitmq
docker start rabbitmq
```

The services can recover without requiring a manual application restart.

---

# ☠️ Dead-Letter Queues

Messages that cannot be successfully parsed or processed are moved to a Dead-Letter Queue rather than silently discarded.

Example:

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

The original message and processing failure information can then be inspected through the RabbitMQ management interface.

---

# 🚦 API Gateway Rate Limiting

The API Gateway provides rate limiting to protect downstream services from excessive requests.

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

Services use structured logging to make distributed requests easier to diagnose.

Instead of relying only on plain console output, logs contain structured fields such as:

```text
timestamp
service
level
message
orderId
userId
eventType
```

Logs are shipped to Elasticsearch, allowing service-level filtering and investigation across the distributed system.

Example:

```text
service: orders-service
eventType: order_placed
orderId: 42
level: info
```

This makes debugging distributed workflows significantly easier than inspecting individual container logs.

---

# 🔎 Elasticsearch Product Search

The Catalog Service stores product data in PostgreSQL and maintains a searchable Elasticsearch index.

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

The PostgreSQL database remains the primary source of product data while Elasticsearch acts as the search index.

---

# 🛒 Redis Cart Storage

Cart data is stored in Redis because carts are ephemeral, frequently accessed data.

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

Before adding an item, Cart Service validates the product against Catalog Service.

This prevents invalid product IDs from entering the cart.

---

# 🐳 Docker Compose

The complete distributed environment can be started locally using Docker Compose.

Infrastructure includes:

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

---

# ☸️ Kubernetes

The project also includes Kubernetes manifests for deployment.

The manifests cover:

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

Stateless services can be independently scaled, while stateful infrastructure currently uses Kubernetes storage resources where configured.

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
ecommerce-microservices/
│
├── gateway/
│   ├── src/
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
git clone https://github.com/<your-username>/<repository-name>.git
cd <repository-name>
```

## 2. Start the Stack

```bash
docker compose up -d --build
```

## 3. Verify Containers

```bash
docker ps
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

> ⚠️ Removing volumes deletes local database/cache data.

---

# 🌐 API Quick Start

All client requests should normally go through:

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

The authenticated user's identity is extracted from the JWT rather than accepted from the request body.

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
* `refund_processed`
* Dead-letter queues
* Queue depth
* Consumer status
* Individual messages

---

# 🧪 Testing

Each service has its own isolated Jest test suite.

```bash
cd auth-service && npm test
cd catalog-service && npm test
cd cart-service && npm test
cd orders-service && npm test
cd payments-service && npm test
cd gateway && npm test
```

## Test Coverage

The test suites cover both normal functionality and distributed-system failure scenarios.

### Orders Service

Tests include:

* Order creation
* Authentication
* Database persistence
* Transactional outbox
* Transaction rollback behavior
* Failure during event creation

The rollback test uses the real PostgreSQL connection to verify that the order and outbox event do not leave partial state when the transaction fails.

### Payments Service

Tests include:

* Message consumption
* Payment processing
* Event publication
* Acknowledgement
* Invalid message handling
* Dead-letter behavior
* RabbitMQ reconnection

Jest fake timers are used to test retry/backoff behavior deterministically.

### Gateway

Tests include:

* Request proxying
* Downstream service failure
* Graceful `503` handling

The gateway test suite uses a temporary Express backend to test real proxy behavior.

---

# 🔗 End-to-End Testing

The project includes a Postman collection:

```text
ecommerce-backend.postman_collection.json
```

The suite exercises the system through the real API Gateway.

It covers:

* Health checks
* Registration
* Login
* JWT authentication
* Catalog operations
* Public product search
* Cart operations
* Product validation
* Order creation
* Token-derived user identity
* Idempotent requests
* Gateway error handling
* Invalid JWT handling
* Unknown routes
* Inventory/order workflows

The collection is designed to be executed from top to bottom because requests share variables created by previous requests.

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

JWT_SECRET=your-secret-key
```

The JWT secret must be consistent across services that independently verify tokens.

Docker Compose uses service DNS names:

```env
AUTH_SERVICE_URL=http://auth-service:4000
CATALOG_SERVICE_URL=http://catalog-service:4001
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
REDIS_URL=redis://redis:6379
```

Kubernetes uses Kubernetes Service names for service-to-service communication.

---

# ⚙️ Continuous Integration

GitHub Actions runs the service test suites automatically on pushes and pull requests to `main`.

The CI environment provisions isolated infrastructure for each job, including:

* PostgreSQL
* Redis
* Elasticsearch
* RabbitMQ

The service test suites execute independently so failures can be isolated to the affected service.

---

# ☸️ Kubernetes Deployment

The application can be deployed to Docker Desktop's Kubernetes cluster.

Enable Kubernetes in Docker Desktop and verify:

```bash
kubectl get nodes
```

Build and push service images:

```bash
docker build -t <service-name>:local ./<service-name>

docker tag <service-name>:local \
  <your-dockerhub-username>/<service-name>:local

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

There is currently no distributed tracing system such as OpenTelemetry or Jaeger.

### Metrics

Prometheus/Grafana monitoring has not yet been integrated.

### RabbitMQ Persistence

The current Kubernetes RabbitMQ deployment does not yet use a dedicated PersistentVolumeClaim for durable broker state.

### Gateway Rate Limiting

The current rate limiter uses in-memory storage.

A shared Redis-backed implementation would be preferable when running multiple Gateway replicas.

### Database Migrations

Database schemas are currently initialized manually rather than through a migration framework.

A production deployment would use tools such as Flyway, Liquibase, Prisma migrations, Knex migrations, or a similar migration system.

### Kubernetes Secrets

Secrets are currently represented through Kubernetes configuration and should be replaced with a dedicated secrets-management solution for production.

### Container Registry

The current Kubernetes setup uses Docker Hub images.

A production environment would typically use a private registry with appropriate image-pull credentials.

---

# 🗺️ Roadmap

* [x] JWT authentication
* [x] Defense-in-depth authentication
* [x] Role-based access control
* [x] Database-per-service architecture
* [x] API Gateway
* [x] Gateway rate limiting
* [x] Redis-backed carts
* [x] Elasticsearch fuzzy search
* [x] Inventory management
* [x] Transactional Outbox Pattern
* [x] RabbitMQ event-driven communication
* [x] Retry and Dead-Letter Queues
* [x] RabbitMQ connection recovery
* [x] Idempotency handling
* [x] Order cancellation
* [x] Payment reconciliation
* [x] Centralized structured logging
* [x] Docker Compose environment
* [x] Kubernetes deployment
* [x] End-to-end Postman testing
* [x] GitHub Actions CI
* [ ] Distributed tracing
* [ ] Prometheus metrics
* [ ] Grafana dashboards
* [ ] Persistent RabbitMQ storage in Kubernetes
* [ ] Kubernetes Ingress
* [ ] Horizontal Pod Autoscaling
* [ ] Production secrets management
* [ ] Private container registry

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
* **Payment reconciliation**
* **Order state management**
* **Redis caching/ephemeral storage**
* **Elasticsearch indexing and fuzzy search**
* **Centralized structured logging**
* **API rate limiting**
* **Containerization**
* **Kubernetes orchestration**
* **Independent service testing**
* **End-to-end testing**
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
* RabbitMQ PersistentVolumes
* Database migration tooling
* Dedicated secrets management
* Private container registry
* Automated deployment pipelines
* Centralized alerting
* Circuit breakers for synchronous service dependencies

---

# 👩‍💻 Author

**Sudiksha Chugh**

Built to explore practical **backend engineering, microservices, distributed systems, reliability, and cloud-native architecture**.

---

