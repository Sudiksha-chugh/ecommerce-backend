# Saga recovery inspection and planning — Stage E.1a

This CLI reads persisted Orders, Payments and Inventory evidence and emits JSON review artifacts to stdout. It does not execute or persist a recovery plan. `REVIEW_REQUIRED` means an existing command is eligible for further review, not that replay is authorized or safe to perform immediately.

It has no RabbitMQ dependency, queue inspection, publishing, acknowledgement, service lifecycle control, credential management or Kubernetes integration. Incident-specific order-56 scripts remain unchanged. Stage E.1b must introduce a durable approval/execution journal before replay is implemented.

## Usage

Install the existing Orders service dependencies first; the CLI resolves its PostgreSQL client through `orders-service/package.json`, independently of the working directory. Run from the repository root, or use an absolute CLI path.

```sh
export SAGA_RECOVERY_CONFIG=/absolute/protected-directory/saga-recovery.json
node scripts/saga-recovery/cli.js inspect --environment local --order-id 56
node scripts/saga-recovery/cli.js plan --environment local --order-id 56 --action replay-existing
node scripts/saga-recovery/cli.js verify --environment local --order-id 56
node scripts/saga-recovery/cli.js --help
```

These examples do not authorize recovery for order 56. A completed `CANCELLED` Saga produces a blocked replay plan. There is no `execute`, `resume`, or plan-output-file option. Shell redirection, if deliberately used by an operator, produces a sensitive review artifact rather than an approved recovery operation.

Exit codes:

- `0`: inspection completed, verification is consistent with stated limitations, or a review plan was produced.
- `1`: invalid arguments/configuration, unsafe identity/role, connection error, or query failure.
- `2`: blocked plan or conflicting verification evidence.

Inspection returns evidence and checks even when business records conflict; its exit code reports successful inspection, not recovery health. Use `verify` for a conflict-sensitive exit code.

## Explicit environment profiles

The CLI never loads development `.env` files or implicitly chooses a database. `SAGA_RECOVERY_CONFIG` must name an absolute path to an existing JSON file owned by the invoking user, with no group/other permissions. Its immediate parent must be owned by that user and not group/other writable. Symlink files and immediate parent directories are rejected. Store real credentials outside the repository, using a protected directory and secure secret input; do not put passwords in command arguments or logs.

Example **shape**, with intentionally invalid placeholders to replace through secure local configuration:

```json
{
  "version": 1,
  "profiles": {
    "local": {
      "kind": "local",
      "databases": {
        "orders": {
          "host": "127.0.0.1",
          "port": 5435,
          "database": "orders_db",
          "user": "orders_recovery_reader",
          "password": "<securely-supplied-password>",
          "expectedDatabaseOid": "<independently-verified-oid>",
          "expectedServerPort": 5432
        },
        "payments": {
          "host": "127.0.0.1",
          "port": 5436,
          "database": "payments_db",
          "user": "payments_recovery_reader",
          "password": "<securely-supplied-password>",
          "expectedDatabaseOid": "<independently-verified-oid>",
          "expectedServerPort": 5432
        },
        "inventory": {
          "host": "127.0.0.1",
          "port": 5437,
          "database": "inventory_db",
          "user": "inventory_recovery_reader",
          "password": "<securely-supplied-password>",
          "expectedDatabaseOid": "<independently-verified-oid>",
          "expectedServerPort": 5432
        }
      }
    }
  }
}
```

The example ports/names are explicit operator choices, never built-in development defaults. Do not copy them without verifying your target. Profiles require all three services, distinct database names, explicit roles, passwords, ports and OIDs. Unknown fields, hostname aliases, missing targets, privileged roles and ambiguous targets are rejected.

E.1a supports loopback IP connections only. Remote/production profiles, TLS configuration and federated operator authorization need separate review; do not expose this local CLI as a production recovery interface. Loopback connections currently use the PostgreSQL password protocol without TLS and assume a trusted local host.

Have an authorized administrator independently establish the expected database identity, including `current_database()`, the intended reader role, database OID in `pg_database`, and `inet_server_port()`. The server port is PostgreSQL's internal port, which can differ from the host's published port. The CLI checks those pins before any application-table query. It does not provision roles or discover/adopt an unknown target. OIDs are cluster-local and can change on database recreation; they are a guard against accidental targeting, not cryptographic server authentication.

## Required read-only privileges

Provision a separate inspection identity in each database outside this stage. It needs `CONNECT`, `USAGE` on `public`, and `SELECT` on the following tables:

- Orders: `orders`, `order_sagas`, `saga_transitions`, `inbox_events`, `outbox_events`.
- Payments: `payments`, `refunds`, `inbox_events`, `outbox_events`.
- Inventory: `reservations`, `inventory`, `inventory_order_operations`, `inbox_events`, `outbox_events`.

The identity metadata query needs ordinary PostgreSQL catalog visibility. No sequence privileges, business-table writes, schema/database creation, ownership, superuser, role creation, replication or RLS bypass are required. Inherited ownership or write grants are also unsafe. Local profiles reject roles with detected public relation/sequence mutation privileges or schema/database creation privileges. This is not a comprehensive audit of privileges on other schemas or functions; provision dedicated reader roles rather than reusing unrelated operational accounts.

The `isolated-test` kind is the only exception for existing restricted application write grants. It pins the three database names to `*_phase21_test`, service roles to `*_app`, host to `127.0.0.1`, and ports to Orders `55435`, Payments `55436`, Inventory `55437`. Transactions remain read-only and reports label the connection `ISOLATED_APPLICATION_ROLE_READ_ONLY_SESSION`. This exception does not allow administrative or owner roles.

## Inspection and evidence

Each source uses its own `REPEATABLE READ READ ONLY` transaction and rolls it back after inspection. Sources are acquired sequentially, connections are closed on failure, and no locks are taken for recovery coordination. All output explicitly labels the cross-database snapshot `NON_ATOMIC`. Running workers can advance between source snapshots; inconsistent evidence requires a new inspection and review.

Inspection includes:

- Order owner ID, amount, items, status and creation timestamp.
- Saga state, flags, version, command generation and timestamps.
- Transition history and event IDs.
- Persisted command/result payloads and publication timestamps.
- Owner inbox entries, payment/refund records and timestamps.
- Reservation state, quantity, deadline, Inventory operation tombstone, and diagnostic stock observations.
- Source database/role identity and observation timestamp.

Queries are bounded to 1000 records per collection. Truncated evidence blocks planning. Source timestamps are PostgreSQL transaction timestamps; business timestamps retain their stored representation.

Output omits connection credentials, provider transaction IDs and free-form Saga errors. Public payloads use an allowlist and reduce items to product IDs/quantities. Arbitrary payload fields are redacted; commands with unsupported fields cannot produce a replay plan. Operational owner IDs, amounts and correlation identifiers remain visible because they are necessary for review. Treat stdout and saved artifacts as sensitive; approved identifier fields are assumed to contain identifiers, not secrets.

## Supported planning scenarios

Only `--action replay-existing` is supported:

- `REFUND_PENDING` with exactly one current, complete, correlated existing `refund_requested` command and a matching successful original payment.
- The same refund command already accepted by Payments, if its exact persisted successful result and refund record exist and Orders has not consumed that result. A future replay would ask Payments to republish its result, not create another refund.
- `RELEASE_PENDING` with a current existing `inventory_release_requested` command not yet recorded in Inventory's inbox, after cancellation, payment failure, or successful refund as applicable.

An unpublished command is labeled as already eligible for its owner's normal outbox retry. Planning does not reset the published flag or request replay.

Every review plan preserves the selected persisted command, including original event ID, operation ID and payload. It includes expected Saga state/version/generation, verification checks, and SHA-256 fingerprints for the command, evidence and plan. The command fingerprint includes the authoritative `payload::text` returned by PostgreSQL. That exact text is retained as `command.payloadText`; a future publisher must use it rather than reconstruct JSON from the decoded object. Metadata fingerprints sort object keys while preserving array order. PostgreSQL JSONB has already discarded original wire whitespace/key order; original AMQP wire bytes remain unavailable. Numeric tokens are checked for exact decimal round-trip before JavaScript decoding. Unsupported precision is rejected, never rounded; such payloads block planning and are redacted from inspection output. Financial identifiers and amounts must be supported primitives; arrays, objects, booleans and nulls are rejected. Financial amounts are compared as exact decimal cents.

Observation timestamps are excluded from fingerprints so repeated unchanged reads are deterministic. Absolute stock observations are also excluded because unrelated orders can change stock; reservation state and quantity remain included. Publication state, Saga version, transitions, owner inbox/outbox evidence, configured host and connection port are included and can invalidate an earlier artifact. No credentials enter the fingerprints. A durable deployment identity is still required before E.1b execution; endpoint/OID pins alone do not authenticate a deployment.

## Blocked and unsupported scenarios

Planning blocks missing/conflicting records, invalid financial ownership/amount/status, stale command generation, incomplete command fields/timestamps, conflicting operation identity, ambiguous event IDs, other unresolved commands, incomplete history, truncated evidence and inconsistent Saga flags.

It also blocks:

- Terminal, confirmed-purchase, initial and `REFUND_FAILED` Sagas.
- Creation of payment, refund, reservation or synthetic Saga-result events.
- Retrying a processed failed refund with its original event ID; that would replay failure, not perform a new attempt.
- Processed Inventory release commands, because Inventory currently republishes all results for an order and lacks exact command/result causation.
- Partial refunds, multiple payment operations, provider settlement reconciliation and DLQ operations.

Missing legacy correlation fields are not invented. There is no automatic upgrade of an incomplete historical command.

## Verification limits

Checks distinguish `CONFIRMED`, `UNCERTAIN` and `CONFLICT`. Consistency is not proof of an atomic cross-service outcome.

Cancelled paid orders require matching successful payment/refund evidence, Saga refund flags and no active reservations. Refund compensation requires the correlated owner result, its processed Orders inbox record and the transition from REFUND_PENDING to RELEASE_PENDING. Inventory compensation requires a consumed persisted owner release result with `allInactive=true` that caused the terminal RELEASE_PENDING to CANCELLED transition. Stock failure requires the actual Inventory failure result, its processed Orders inbox record, and the STOCK_FAILED history chain; flags and absent reservations alone are insufficient. CONFIRMED orders require complete bidirectional product/quantity agreement, including duplicate and missing-product checks. Inventory results currently lack full causation metadata, so exact release-command lineage remains a stated limitation.

Unchanged absolute stock never proves compensation. There is no immutable stock-movement ledger, and no reservation does not prove historical restoration. Payment/refund success is the local simulator's persisted outcome, not real provider settlement. Review plans provide no authorization, lease, durable audit journal, concurrency fence or execution guarantee; those belong to E.1b.

## Tests

Unit tests use synthetic evidence and mock read-only connections:

```sh
node --test scripts/saga-recovery/tests/inspection.test.js
```

Actual SQL tests require the already provisioned Phase 2.1 application configuration and running isolated instances:

```sh
SAGA_RECOVERY_POSTGRES=true node --test scripts/saga-recovery/tests/inspection.test.js
```

The CLI tests target only the pinned isolated databases. Existing application-role tests remain, and populated regression tests use verified administrative fixture helpers to create unique test records and temporary NOLOGIN SELECT-only roles. Helpers verify the admin database identity before selecting the reader with SET ROLE; actual PostgreSQL SELECT and forbidden-write permissions are exercised as that reader. This tests role enforcement, not reader password authentication. Helpers remove only records and roles they created, tracking inserted outbox row IDs. No database provisioning, development `.env`, truncation or RabbitMQ access occurs. Fixture helpers may write isolated test data; CLI commands remain read-only. A write-protection probe issues an `UPDATE ... WHERE FALSE` inside a read-only transaction and requires PostgreSQL to reject it with `25006`; it cannot change rows. Existing test data is preserved. Integration opt-in fails rather than silently skipping unavailable infrastructure.

Existing Phase 2 suites and CI coverage gates are unchanged. Adding this suite as a new CI gate can be reviewed separately; no workflow edits are included in E.1a.

## E.1a.1 global correlation hardening

Each source checks selected command/expected result IDs globally in its inbox and outbox, beyond the order-scoped evidence query. Wrong order/type/operation, conflicting command text or financial payload, duplicate result identities, missing global evidence, or unsupported payload precision blocks planning. These lookups run inside the source read-only snapshot. Inventory result IDs remain producer-generated, and full command causation is still unavailable; processed release replay remains unsupported.


## E.1a.2 reconciliation hardening

Inspection gathers actual persisted owner-result event IDs, including Inventory UUIDs, before performing targeted global lookups in every source. Each source's repeatable-read, read-only transaction stays open through these lookups; the sources still do not constitute an atomic snapshot. Shared verification rejects wrong owners, orders, event types, conflicting payloads and duplicate global outbox identities. Planning uses the same verification checks. Lookup coverage is recorded in the evidence fingerprint.

Cancellation proof requires an ordered, continuous sequence of permitted Saga transitions ending in the observed terminal state. Paid compensation requires consecutive correlated refund-to-release and release-to-cancellation transitions. Stock failure requires consecutive transitions from PENDING or CANCEL_REQUESTED into STOCK_FAILED and then CANCELLED, using the same consumed owner failure event. Legitimate unpaid cancellation requires release evidence without inventing a refund. Missing historical proof remains a conflict.

Populated isolated tests use the CLI's real PostgreSQL client and exact JSON parser with verified SELECT-only SET ROLE sessions. Regression mocks filter global results using the actual requested IDs. Cleanup attempts are independent across services, pool closure is always attempted, environment variables are restored in an outer finally, and additional cleanup failures are reported without replacing the original test failure. Execution and broker access remain disabled.


## E.1a.3 expected-result correlation

For every persisted payment/refund command, shared verification checks its contract-defined `eventId:result` against global inbox/outbox evidence, even when the result exists only outside the selected order's records. Owner, order, type, operation, financial fields, request ID and status must agree with the original command. Earlier attempts are checked even after later success. Inventory has no deterministic result ID derivation; only actual Inventory result IDs are queried.

A missing result is normal while a command is pending. A committed Payments command inbox or consumed Orders result without the persisted owner result is incomplete evidence and blocks reconciliation. Tests cover global-only mismatches through the real isolated PostgreSQL client. Inventory product inserts are registered with the fixture tracker, and cleanup asserts their removal. Partial-failure regressions check independent cleanup, connection closure, environment restoration and preservation of the original failure.
