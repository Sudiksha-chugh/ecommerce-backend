# 🛒 E-Commerce Backend — Microservices Architecture

A distributed e-commerce backend built with **Node.js** and designed to demonstrate real-world microservices architecture patterns.

The system uses independently deployable services, database-per-service isolation, synchronous HTTP communication, asynchronous event-driven messaging, and a unified API Gateway.

---

## ✨ Key Features

* 🔐 JWT-based authentication
* 🛍️ Product catalog management
* 🔎 Fuzzy product search using Elasticsearch
* 🛒 Redis-powered shopping carts
* 📦 Order creation and persistence
* 💳 Asynchronous payment processing
* 📨 Event-driven communication with RabbitMQ
* 🌐 Centralized API Gateway
* 🐳 Fully containerized with Docker Compose
* 🧪 Independent test suites for each microservice

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

### Event Flow

```text
Client
   │
   ▼
API Gateway
   │
   ▼
Orders Service
   │
   ├── Stores order in PostgreSQL
   │
   └── Publishes `order_placed`
               │
               ▼
           RabbitMQ
               │
               ▼
       Payments Service
               │
               └── Publishes `payment_processed`
```

---

## 🧩 Services Overview

| Service              |   Port | Database / Storage                        | Core Responsibility                                                   |
| -------------------- | -----: | ----------------------------------------- | --------------------------------------------------------------------- |
| **API Gateway**      | `8080` | —                                         | Single entry point that routes requests to downstream services        |
| **Auth Service**     | `4000` | PostgreSQL (`auth_db`)                    | User registration, login, JWT issuance, and authentication middleware |
| **Catalog Service**  | `4001` | PostgreSQL (`catalog_db`) + Elasticsearch | Product creation, product lookup, and fuzzy search                    |
| **Cart Service**     | `4002` | Redis                                     | Cart management and product validation                                |
| **Orders Service**   | `4003` | PostgreSQL (`orders_db`)                  | Order creation and `order_placed` event publishing                    |
| **Payments Service** | `4004` | —                                         | Consumes order events and processes payments                          |

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

The Cart Service is temporally coupled to the Catalog Service. If the Catalog Service is unavailable, the cart operation may fail.

---

### 2. Asynchronous Event-Driven Messaging

**Use case:**
After an order is created, the Orders Service publishes an `order_placed` event to RabbitMQ and immediately returns a response to the client.

The Payments Service consumes the event independently.

```text
Orders Service
      │
      │ Publishes `order_placed`
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
* Better resilience to temporary service downtime

**Trade-off**

The system follows an **eventual consistency** model.

---

## 🛠️ Tech Stack

| Category                   | Technologies           |
| -------------------------- | ---------------------- |
| **Runtime**                | Node.js                |
| **Web Framework**          | Express.js             |
| **Relational Database**    | PostgreSQL             |
| **Caching & Cart Storage** | Redis                  |
| **Search Engine**          | Elasticsearch          |
| **Message Broker**         | RabbitMQ               |
| **Containerization**       | Docker, Docker Compose |
| **Testing**                | Jest, Supertest        |
| **Authentication**         | JSON Web Tokens (JWT)  |

---

## 📁 Project Structure

```text
ecommerce-microservices/
│
├── gateway/
│   ├── src/
│   ├── Dockerfile
│   └── package.json
│
├── auth-service/
│   ├── src/
│   │   ├── app.js
│   │   ├── index.js
│   │   └── db.js
│   ├── tests/
│   │   ├── sanity.test.js
│   │   └── db-connection.test.js
│   ├── Dockerfile
│   └── package.json
│
├── catalog-service/
│   ├── src/
│   ├── tests/
│   ├── Dockerfile
│   └── package.json
│
├── cart-service/
│   ├── src/
│   ├── tests/
│   ├── Dockerfile
│   └── package.json
│
├── orders-service/
│   ├── src/
│   ├── tests/
│   ├── Dockerfile
│   └── package.json
│
├── payments-service/
│   ├── src/
│   ├── tests/
│   ├── Dockerfile
│   └── package.json
│
├── docker-compose.yml
├── .gitignore
└── README.md
```

Each microservice follows a consistent structure:

```text
service-name/
├── src/
│   ├── app.js             # Express application
│   ├── index.js           # Server startup and event consumers
│   └── db.js              # Database connection and pooling
│
├── tests/
│   ├── sanity.test.js
│   └── db-connection.test.js
│
├── Dockerfile
├── .dockerignore
├── package.json
└── .env                   # Local environment variables
```

---

## 🚀 Getting Started

### Prerequisites

Make sure the following tools are installed:

* Docker
* Docker Compose
* Git

---

### 1. Clone the Repository

```bash
git clone https://github.com/<your-username>/<repository-name>.git
cd <repository-name>
```

---

### 2. Start All Services

Build and start the complete microservices environment:

```bash
docker compose up -d --build
```

This starts:

* API Gateway
* Auth Service
* Catalog Service
* Cart Service
* Orders Service
* Payments Service
* Three PostgreSQL databases
* Redis
* Elasticsearch
* RabbitMQ

---

### 3. Verify Running Containers

```bash
docker ps
```

To view service logs:

```bash
docker compose logs -f
```

To view logs for a specific service:

```bash
docker compose logs -f orders-service
```

---

### 4. Stop the Environment

```bash
docker compose down
```

To remove containers and volumes:

```bash
docker compose down -v
```

> ⚠️ Removing volumes deletes locally stored database and cache data.

---

## 🌐 API Quick Start

All client requests should be sent through the API Gateway:

```text
http://localhost:8080
```

---

### Register a User

```bash
curl -X POST http://localhost:8080/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "you@example.com",
    "password": "yourPassword"
  }'
```

---

### Search Products

```bash
curl "http://localhost:8080/products/search?q=hub"
```

---

### Add an Item to the Cart

```bash
curl -X POST http://localhost:8080/cart/testuser/items \
  -H "Content-Type: application/json" \
  -d '{
    "productId": 2,
    "quantity": 3
  }'
```

---

### Place an Order

```bash
curl -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 1,
    "items": [
      {
        "productId": 2,
        "name": "USB-C Hub",
        "price": 34.99,
        "quantity": 3
      }
    ],
    "totalAmount": 104.97
  }'
```

---

## 🐰 RabbitMQ Management Dashboard

RabbitMQ provides a management dashboard for monitoring:

* Exchanges
* Queues
* Messages
* Consumers
* Event flow

Open:

```text
http://localhost:15672
```

**Default credentials**

```text
Username: guest
Password: guest
```

---

## 🧪 Testing

Each microservice contains an isolated Jest test suite.

Run tests individually:

```bash
cd auth-service
npm test
```

```bash
cd catalog-service
npm test
```

```bash
cd cart-service
npm test
```

```bash
cd orders-service
npm test
```

```bash
cd payments-service
npm test
```

---

## ⚙️ Environment Configuration

Each service uses a local `.env` file during development.

Example:

```env
PORT=4000
DATABASE_URL=postgresql://user:password@localhost:5432/auth_db
JWT_SECRET=your-secret-key
```

When running with Docker Compose, local values are overridden using the `environment:` configuration in `docker-compose.yml`.

Services communicate through Docker's internal network using service hostnames:

```env
AUTH_SERVICE_URL=http://auth-service:4000
CATALOG_SERVICE_URL=http://catalog-service:4001
RABBITMQ_URL=amqp://rabbitmq:5672
REDIS_URL=redis://redis:6379
```

---

## ⚠️ Known Limitations

### Authentication Enforcement

JWT validation is implemented in the Auth Service, but authentication middleware is not yet applied to every downstream endpoint.

### Order Status Reconciliation

The Payments Service emits `payment_processed` events, but the Orders Service does not yet consume these events to update order status.

### Centralized Observability

The project currently does not include:

* Centralized logging
* Distributed tracing
* Metrics collection
* Service dashboards

Potential additions:

* Elasticsearch, Logstash, and Kibana
* Grafana Loki
* Prometheus
* Jaeger
* Zipkin

### Rate Limiting

Rate limiting is not currently implemented at the API Gateway.

### Container Orchestration

The project currently uses Docker Compose. Kubernetes manifests are planned for production-style orchestration.

### Development Dependency Warnings

Some transitive development dependencies used by Jest may report vulnerability warnings. These dependencies are not included in the production runtime.

---

## 🗺️ Roadmap

* [ ] Apply JWT authentication to all protected routes
* [ ] Add role-based access control
* [ ] Implement payment status reconciliation
* [ ] Add inventory management
* [ ] Add order cancellation
* [ ] Add retry and dead-letter queues
* [ ] Implement the Transactional Outbox Pattern
* [ ] Add idempotency keys for order creation
* [ ] Add API Gateway rate limiting
* [ ] Add centralized logging
* [ ] Add distributed tracing
* [ ] Add Prometheus and Grafana monitoring
* [ ] Add Kubernetes deployment manifests
* [ ] Add GitHub Actions CI/CD
* [ ] Add integration and end-to-end tests

---

## 🎯 Microservices Concepts Demonstrated

This project demonstrates:

* Database per service
* API Gateway pattern
* Service-to-service HTTP communication
* Event-driven architecture
* Publish/subscribe messaging
* Eventual consistency
* Independent service deployment
* Independent service scaling
* Containerized development
* Service isolation
* Search indexing with Elasticsearch
* Redis-based data storage
* Asynchronous payment processing

---

## 📌 Future Production Improvements

For production readiness, the following improvements should be considered:

* API authentication and authorization at the Gateway
* Request validation
* Rate limiting and traffic shaping
* Circuit breakers
* Retries with exponential backoff
* Idempotency handling
* Distributed tracing
* Centralized logging
* Health and readiness checks
* Secret management
* Kubernetes orchestration
* Horizontal autoscaling
* CI/CD pipelines
* Database migrations
* Transactional Outbox Pattern
* Dead-letter queues

---

## 👩‍💻 Author

**Sudiksha Chugh**

If you found this project useful, consider giving the repository a ⭐.
