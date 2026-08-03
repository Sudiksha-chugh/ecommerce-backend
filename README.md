# 🛒 E-Commerce Backend — Microservices Architecture

A distributed e-commerce backend built with **Node.js** and designed to demonstrate real-world microservices architecture patterns.

The system uses independently deployable services, database-per-service isolation, synchronous HTTP communication, asynchronous event-driven messaging, and a unified API Gateway. It runs on both **Docker Compose** and **Kubernetes**.

---

## ✨ Key Features

* 🔐 JWT-based authentication, independently enforced by every service (not just the Gateway)
* 🛍️ Product catalog management
* 🔎 Fuzzy product search using Elasticsearch
* 🛒 Redis-powered shopping carts
* 📦 Order creation and persistence
* 💳 Asynchronous payment processing
* 📨 Event-driven communication with RabbitMQ
* 🔁 Transactional outbox pattern for reliable event publishing
* ☠️ Dead-letter queue for unprocessable messages
* 🔌 Self-healing RabbitMQ connections with retry-with-backoff
* 🌐 Centralized API Gateway
* 🐳 Fully containerized with Docker Compose
* ☸️ Deployable to Kubernetes (tested on Docker Desktop's local cluster)
* 🧪 Independent test suites for each microservice, plus a full end-to-end Postman suite

---

## 🏗️ Architecture Overview

```text
                              ┌─────────────┐
                              │   Gateway   │
                              │  Express.js │
                              │    :8080    │
                              └──────┬──────┘
                                     │
        ┌──────────────┬─────────────┼─────────────┬──────────────┐
        │              │             │             │              │
   ┌────▼────┐   ┌─────▼─────┐  ┌────▼────┐  ┌────▼─────┐  ┌────▼──────┐
   │  Auth   │   │  Catalog  │  │   Cart   │  │  Orders  │  │ Payments  │
   │  :4000  │   │   :4001   │  │  :4002   │  │  :4003   │  │  :4004    │
   └────┬────┘   └─────┬─────┘  └────┬────┘  └────┬─────┘  └────┬──────┘
        │              │             │             │              │
   ┌────▼────┐   ┌─────▼─────┐  ┌────▼────┐  ┌────▼─────┐       │
   │PostgreSQL│  │ PostgreSQL │  │  Redis   │  │PostgreSQL│       │
   │ auth_db  │  │ catalog_db │  │          │  │orders_db │       │
   └─────────┘   └─────┬─────┘  └──────────┘  └────┬─────┘       │
                       │                             │             │
                ┌──────▼──────┐               ┌──────▼──────┐      │
                │Elasticsearch│               │  RabbitMQ    │──────┘
                │ Product Index│               │order_placed  │
                └─────────────┘               └─────────────┘
```

Every service that accepts writes (`auth`, `catalog` on `POST /products`, `cart`, `orders`) independently verifies the JWT itself — the Gateway routes requests but is not the only line of defense, since each service is also directly reachable on its own port during local development.

### Event Flow (with the Transactional Outbox Pattern)

```text
Client
   │
   ▼
API Gateway
   │
   ▼
Orders Service
   │
   ├── Writes order + outbox event in ONE Postgres transaction
   │   (both succeed together, or both roll back — no silent gap)
   │
   └── Background poller (every 3s) reads unpublished outbox events
               │
               ▼
           RabbitMQ
               │
               ▼
       Payments Service
               │
               ├── Success → publishes `payment_processed`
               │
               └── Malformed message → routed to `order_placed_dlq`
                   instead of being silently discarded
```

If RabbitMQ is unreachable — at startup or mid-flight — both Orders Service and Payments Service detect the dropped connection and automatically reconnect with backoff, without manual intervention or a restart. This has been verified under real induced outages (`docker stop rabbitmq` / `docker start rabbitmq`), not just mocked tests.

---

## 🧩 Services Overview

| Service              |   Port | Database / Storage                        | Core Responsibility                                                   | Auth Required |
| -------------------- | -----: | ----------------------------------------- | --------------------------------------------------------------------- | ------------- |
| **API Gateway**      | `8080` | —                                         | Single entry point that routes requests to downstream services        | —             |
| **Auth Service**     | `4000` | PostgreSQL (`auth_db`)                    | User registration, login, JWT issuance, and authentication middleware | On `/me`      |
| **Catalog Service**  | `4001` | PostgreSQL (`catalog_db`) + Elasticsearch | Product creation, product lookup, and fuzzy search                    | On writes only — reads are public |
| **Cart Service**     | `4002` | Redis                                     | Cart management and product validation                                | Yes — user identity comes from the JWT, not the URL |
| **Orders Service**   | `4003` | PostgreSQL (`orders_db`)                  | Order creation, transactional outbox, `order_placed` event publishing | Yes — user identity comes from the JWT, not the request body |
| **Payments Service** | `4004` | —                                         | Consumes order events, processes payments, dead-letter handling       | —             |

---

## 🔄 Communication Patterns

This project demonstrates two important microservices communication models.

### 1. Synchronous HTTP Communication

**Use case:**
The Cart Service makes a REST API request to the Catalog Service before adding a product to a user's cart.

The Catalog Service validates:

* Whether the product exists
* Whether the product is available
* The current product price

```text
Cart Service
      │
      │ HTTP Request
      ▼
Catalog Service
      │
      ▼
Product Validation
```

**Advantages**

* Immediate response
* Strong consistency
* Simple request-response flow

**Trade-off**

The Cart Service is temporally coupled to the Catalog Service. If the Catalog Service is unavailable, the cart operation fails fast with a `503`, rather than hanging or silently succeeding with unverified data.

---

### 2. Asynchronous Event-Driven Messaging

**Use case:**
After an order is created, the Orders Service publishes an `order_placed` event to RabbitMQ and immediately returns a response to the client.

The Payments Service consumes the event independently.

```text
Orders Service
      │
      │ Publishes `order_placed` (via outbox poller)
      ▼
   RabbitMQ
      │
      │ Consumes event
      ▼
Payments Service
      │
      ▼
Publishes `payment_processed`
```

**Advantages**

* Loose coupling
* Improved service availability
* Independent service scaling
* Better resilience to temporary service downtime — an order is never lost even if RabbitMQ is down at the moment it's placed

**Trade-off**

The system follows an **eventual consistency** model.

---

## 🛡️ Reliability Patterns

### Transactional Outbox (Orders Service)

The order row and its corresponding "publish this event" row are written in a **single Postgres transaction**. If either insert fails, both roll back — there is no state where an order exists in the database but its event was never recorded. A background poller (`outboxPoller.js`) checks for unpublished events every 3 seconds and publishes them, retrying indefinitely until RabbitMQ is reachable.

### Dead-Letter Queue (Payments Service)

If a message on `order_placed` cannot be parsed or processed, it is not silently discarded. Instead, it's published to `order_placed_dlq` along with the original raw content, the error message, and a timestamp — inspectable later via the RabbitMQ management UI at `localhost:15672`.

### Connection Self-Healing

Both Orders Service and Payments Service listen for `close` and `error` events on their RabbitMQ connection and automatically attempt to reconnect with a fixed backoff delay — both on initial startup (if RabbitMQ isn't ready yet) and mid-life (if the connection drops after running successfully). This replaces relying on Docker's `restart: unless-stopped` policy to paper over connection issues with a crash.

---

## 🛠️ Tech Stack

| Category                   | Technologies                       |
| -------------------------- | ----------------------------------- |
| **Runtime**                | Node.js                             |
| **Web Framework**          | Express.js                          |
| **Relational Database**    | PostgreSQL                          |
| **Caching & Cart Storage** | Redis                               |
| **Search Engine**          | Elasticsearch                       |
| **Message Broker**         | RabbitMQ                            |
| **Containerization**       | Docker, Docker Compose              |
| **Orchestration**           | Kubernetes (Docker Desktop cluster) |
| **Testing**                | Jest, Supertest, Postman            |
| **Authentication**         | JSON Web Tokens (JWT)               |

---

## 📁 Project Structure

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

## 🚀 Getting Started (Docker Compose)

### Prerequisites

* Docker
* Docker Compose
* Git

### 1. Clone the Repository

```bash
git clone https://github.com/<your-username>/<repository-name>.git
cd <repository-name>
```

### 2. Start All Services

```bash
docker compose up -d --build
```

This starts the Gateway, all five services, three PostgreSQL databases, Redis, Elasticsearch, and RabbitMQ.

### 3. Verify Running Containers

```bash
docker ps
docker compose logs -f
docker compose logs -f orders-service
```

### 4. Stop the Environment

```bash
docker compose down
```

To also remove volumes (⚠️ deletes local database/cache data):

```bash
docker compose down -v
```

---

## ☸️ Getting Started (Kubernetes)

Tested against Docker Desktop's built-in Kubernetes cluster.

### 1. Enable Kubernetes

Docker Desktop → Settings → Kubernetes → Enable Kubernetes → Apply & Restart.

```bash
kubectl get nodes
```

### 2. Build and push service images

Kubernetes pulls images from a registry rather than using locally-built images directly. Each service's image is pushed to Docker Hub:

```bash
docker build -t <service-name>:local ./<service-name>
docker tag <service-name>:local <your-dockerhub-username>/<service-name>:local
docker push <your-dockerhub-username>/<service-name>:local
```

Update the `image:` field in the corresponding `k8s/*.yaml` file to match your own Docker Hub username.

### 3. Apply the manifests

Apply infrastructure first, then services, then the Gateway:

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

### 4. Create database schemas

Kubernetes PersistentVolumeClaims start empty — tables must be created once per fresh cluster:

```bash
kubectl exec -it deployment/auth-db -- psql -U auth_user -d auth_db -c "CREATE TABLE users (id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, created_at TIMESTAMP DEFAULT NOW());"

kubectl exec -it deployment/catalog-db -- psql -U catalog_user -d catalog_db -c "CREATE TABLE products (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, description TEXT, price NUMERIC(10,2) NOT NULL, stock INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());"

kubectl exec -it deployment/orders-db -- psql -U postgres -d orders_db -c "CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, items JSONB NOT NULL, total_amount NUMERIC(10,2) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW());"

kubectl exec -it deployment/orders-db -- psql -U postgres -d orders_db -c "CREATE TABLE outbox_events (id SERIAL PRIMARY KEY, event_type VARCHAR(50) NOT NULL, payload JSONB NOT NULL, published BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW(), published_at TIMESTAMP);"
```

### 5. Verify and access

```bash
kubectl get pods
kubectl get service gateway
```

The Gateway is exposed as a `LoadBalancer` Service — on Docker Desktop this is reachable directly at `http://localhost:8080`, no port-forwarding required. Individual services (for debugging) can be reached via:

```bash
kubectl port-forward service/<service-name> <port>:<port>
```

---

## 🌐 API Quick Start

All client requests should be sent through the API Gateway:

```text
http://localhost:8080
```

### Register a User

```bash
curl -X POST http://localhost:8080/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "yourPassword"}'
```

### Log In

```bash
curl -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "yourPassword"}'
```

Save the returned `token` — it's required for every write operation below.

### Search Products (public, no auth required)

```bash
curl "http://localhost:8080/products/search?q=hub"
```

### Create a Product (requires auth)

```bash
curl -X POST http://localhost:8080/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"name": "USB-C Hub", "description": "7-in-1 adapter", "price": 34.99, "stock": 20}'
```

### Add an Item to the Cart (requires auth — identity comes from the token)

```bash
curl -X POST http://localhost:8080/cart/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"productId": 2, "quantity": 3}'
```

> Note: the route is `/cart/items`, not `/cart/:userId/items` — the user is identified by their JWT, not a URL parameter, to prevent one user from acting on another's behalf.

### Place an Order (requires auth — identity comes from the token)

```bash
curl -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "items": [{"productId": 2, "name": "USB-C Hub", "price": 34.99, "quantity": 3}],
    "totalAmount": 104.97
  }'
```

> Note: `userId` is not part of the request body — it's derived from the verified JWT, so it can't be spoofed by editing the request.

---

## 🐰 RabbitMQ Management Dashboard

```text
http://localhost:15672
```

**Default credentials:** `guest` / `guest`

Use this to inspect `order_placed`, `payment_processed`, and `order_placed_dlq` directly — queue depths, individual message contents, and consumer status.

---

## 🧪 Testing

### Per-service unit/integration tests

Each microservice has an isolated Jest suite using its own test database (`<service>_db_test`), separate from dev data:

```bash
cd auth-service && npm test        # 11 tests
cd catalog-service && npm test     # 10 tests
cd cart-service && npm test        # 9 tests
cd orders-service && npm test      # 9 tests
cd payments-service && npm test    # 8 tests
cd gateway && npm test             # 2 tests
```

Notable coverage beyond basic CRUD:
* **orders-service**: a rollback test that spies on the real Postgres connection (not a full mock) to prove the outbox transaction genuinely leaves no trace of either row if the second insert fails
* **payments-service**: uses Jest fake timers to deterministically test the 3-second RabbitMQ reconnect logic without actually waiting in real time
* **gateway**: spins up a real, temporary Express server as a fake backend to test proxying and the graceful `503` fallback

### End-to-end suite

`ecommerce-backend.postman_collection.json` tests the complete system through the live gateway — real HTTP calls, no mocks. Import into Postman, ensure the stack is running (`docker compose up -d`), and run the full collection (folders are chained via saved variables — run top to bottom, not individually).

Covers: health checks, full auth flow (idempotent — generates a unique email per run), catalog auth enforcement + public reads + fuzzy search, cart auth enforcement + real catalog verification, order creation with token-derived identity, and gateway resilience (malformed JWTs, unknown routes).

**Last full run: 38/38 assertions passing.**

### Continuous Integration

Every push and pull request to `main` triggers `.github/workflows/ci.yml`, which runs all 6 services' test suites in parallel on fresh, isolated infrastructure (Postgres, Redis, Elasticsearch, RabbitMQ spun up per-job via GitHub Actions `services`). No manual test running required for changes merged to `main`.

---

## ⚙️ Environment Configuration

Each service uses a local `.env` file during development, and `docker-compose.yml` / Kubernetes Secrets for containerized environments.

Example (`auth-service/.env`):

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

**Important:** `JWT_SECRET` must be identical across auth-service, catalog-service, cart-service, and orders-service — auth-service signs tokens, and every other service independently verifies them using the same secret.

In Docker Compose, services communicate via container names:

```env
AUTH_SERVICE_URL=http://auth-service:4000
CATALOG_SERVICE_URL=http://catalog-service:4001
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
REDIS_URL=redis://redis:6379
```

In Kubernetes, the same pattern applies via Service names (identical hostnames, since Kubernetes Services and Docker Compose service names both resolve via DNS).

---


## ⚠️ Known Limitations


### Idempotency

RabbitMQ provides at-least-once delivery, meaning an event could theoretically be processed twice (e.g., if a consumer crashes after processing but before acknowledging). Payments Service does not yet deduplicate by order ID.

### Centralized Observability

No centralized logging, distributed tracing, or metrics collection yet. Potential additions: Grafana Loki, Prometheus, Jaeger.

### Rate Limiting

Not implemented at the API Gateway.

### RabbitMQ Persistence in Kubernetes

The Kubernetes RabbitMQ Deployment has no PersistentVolumeClaim — queue state does not survive a pod restart in the Kubernetes deployment (Docker Compose's RabbitMQ container has the same limitation, matching prior behavior).

### Development Dependency Warnings

Some transitive Jest dependencies may report vulnerability warnings; these are not part of the production runtime.

---

## 🗺️ Roadmap

* [x] Apply JWT authentication to all protected routes
* [x] Implement the Transactional Outbox Pattern
* [x] Add retry and dead-letter queues
* [x] Add RabbitMQ connection self-healing with backoff
* [x] Add Kubernetes deployment manifests
* [x] Add end-to-end integration tests (Postman)
* [ ] Add role-based access control
* [ ] Implement payment status reconciliation
* [x] Add idempotency keys for order/payment processing
* [ ] Add inventory management
* [ ] Add order cancellation
* [ ] Add API Gateway rate limiting
* [ ] Add centralized logging
* [ ] Add distributed tracing
* [ ] Add Prometheus and Grafana monitoring
* [ ] Add PersistentVolumeClaim for RabbitMQ in Kubernetes
* [ ] Add Ingress instead of a bare LoadBalancer for the Gateway
* [ ] Add Horizontal Pod Autoscaling for stateless services
* [x] Add GitHub Actions CI/CD
* [ ] Use imagePullSecrets for a private container registry instead of a public Docker Hub repo

---

## 🎯 Microservices Concepts Demonstrated

* Database per service
* API Gateway pattern
* Service-to-service HTTP communication with graceful degradation (`503`, not a hang, on a dead dependency)
* Event-driven architecture with the Transactional Outbox Pattern
* Publish/subscribe messaging with dead-letter handling
* Eventual consistency
* Defense-in-depth authentication (independently verified by every service, not just the Gateway)
* Independent service deployment and scaling
* Containerized development (Docker Compose) and orchestrated deployment (Kubernetes)
* Service isolation, including per-service test databases
* Search indexing with Elasticsearch
* Redis-based ephemeral data storage
* Self-healing distributed connections, verified under real induced outages

---

## 📌 Future Production Improvements

* Role-based access control
* Idempotency handling for event consumers
* Distributed tracing and centralized logging
* Secret management (e.g., a real secrets manager instead of Kubernetes Secrets' base default encoding)
* Horizontal autoscaling
* CI/CD pipelines
* Database migrations (currently manual `CREATE TABLE` per environment)
* PersistentVolumeClaim for RabbitMQ
* A private container registry instead of a public Docker Hub repo

---

## 👩‍💻 Author

**Sudiksha Chugh**

If you found this project useful, consider giving the repository a ⭐.
