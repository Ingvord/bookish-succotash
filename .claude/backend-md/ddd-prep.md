## How to use this guide

You are preparing for the system design round and the post-live-coding technical
conversation. Senior fintech engineering interviews name DDD and CQRS
explicitly, and the vocabulary is tested directly: bounded context, aggregate,
domain event. This guide covers the tactical DDD patterns an interviewer probes
in that room. The full Evans blue-book strategic layer (context mapping,
anti-corruption layers, open-host service) is outside scope here; the probed
layer is the vocabulary you use to describe how a payment system is structured
and why.

The running example throughout is a payment ledger, because that is where
senior fintech design prompts converge. Account is the central aggregate,
`MoneyTransferred` is the central domain event, and the Payments, Identity,
and Fraud contexts supply the cross-context integration story.

---

## The mental model: the model is the boundary

Before the patterns, one reframe: DDD is not a set of classes to create. It
is a discipline of making the code model match the business rules of a specific
domain and drawing a hard boundary around that match.

A domain model is only useful inside its boundary. The moment you share a
domain object across that boundary, you start serving two masters, and both get
a degraded model. The bounded context is the explicit name for where the
boundary is.

---

## Bounded context

A bounded context is an explicit boundary within which a domain model is valid.
Inside the boundary, terms have precise meanings: "Account" means exactly one
thing, "Transaction" means exactly one thing. Outside the boundary, another
team can reuse those words with different meanings, and that is fine, because
the contexts are separate.

The integration rule: communication between contexts happens through domain
events or published API contracts, never through shared database tables. Sharing
a table couples two contexts to the same schema, which means one team's
migration can break another team's query without warning. The decoupling point
must be at the message boundary, not the storage boundary.

For a fintech system, the natural context split is:

- **Payments context:** the Account aggregate, the debit/credit invariant, the
  transaction ledger.
- **Identity context:** customer profile, KYC status, authentication. The
  concept of "Account" here might just be a customer reference ID with no
  financial semantics.
- **Fraud context:** risk scoring, velocity checks, rule evaluation. It
  consumes domain events from Payments (`MoneyTransferred`) and publishes risk
  decisions, but it never reads the Payments database directly.

This split is not about microservices, though it often maps to them. A bounded
context is a modeling decision; the deployment boundary is a separate concern.
Two contexts can live in the same deployed service initially and split later
without redesigning the model.

The catch: context boundaries require team discipline to maintain. The
shortcut of sharing a database table or a domain class across contexts is always
available, and always tempting when a feature spans two contexts. The boundary
degrades gradually, not all at once, which is why naming the rule explicitly
("we never read the Payments schema from the Fraud service") is part of
maintaining it.

---

## Aggregate and aggregate root

An aggregate is a cluster of objects that are always consistent together. The
aggregate root is the single entry point through which all mutations to the
cluster must pass. No code outside the aggregate may modify an object inside
it directly.

The value of this rule is that invariants can be enforced. If a debit on an
Account must always fail when the balance is insufficient, and that invariant
is enforced inside the root's `debit()` method, then no caller can leave the
balance negative.

A minimal Account aggregate root in Java:

```java
public class Account {
    private final AccountId id;
    private Money balance;
    private final List<DomainEvent> domainEvents = new ArrayList<>();

    public Account(AccountId id, Money initialBalance) {
        this.id = id;
        this.balance = initialBalance;
    }

    public void debit(Money amount, TransactionId txId) {
        if (balance.isLessThan(amount)) {
            throw new InsufficientFundsException(id, amount, balance);
        }
        this.balance = balance.subtract(amount);
        domainEvents.add(new AccountDebited(id, txId, amount));
    }

    public void credit(Money amount, TransactionId txId) {
        this.balance = balance.add(amount);
        domainEvents.add(new AccountCredited(id, txId, amount));
    }

    public List<DomainEvent> drainEvents() {
        List<DomainEvent> events = new ArrayList<>(domainEvents);
        domainEvents.clear();
        return events;
    }

    public Money balance()  { return balance; }
    public AccountId id()   { return id; }
}
```

The invariant (balance cannot go negative) lives in `debit()`. The balance
field is private; no service class or controller modifies it directly. The
domain events are collected on the aggregate and published by the application
layer after the transaction commits.

The catch with aggregates is size. Too large an aggregate and you get lock
contention: every mutation on any entity in the cluster requires a lock on the
root, serializing all writes. For a payment ledger, putting every Transaction
inside the Account aggregate looks natural, but it means loading potentially
thousands of transaction records every time you debit the account.

Too small an aggregate and you cannot enforce a cross-entity invariant in one
transaction. If each Transaction is its own aggregate with eventual consistency
back to Account, you cannot atomically verify the balance before debiting. You
are pushed toward optimistic locking or a saga.

The right boundary for this ledger: Account is the aggregate (balance is the
invariant it enforces), and each Transaction is a separate aggregate that
refers to its source and destination accounts by ID only. The debit/credit pair
runs as two operations on two Account aggregates, coordinated by an application
service in a single database transaction, with an outbox entry written in the
same commit.

---

## Domain events

A domain event is an immutable record of something that happened inside the
domain. `MoneyTransferred`, `AccountDebited`, `FraudCheckRequested` are domain
events. They are named in the past tense because they record facts, not
commands.

Domain events serve two purposes. First, they are the audit trail: the event
log is a complete history of every state change. Second, they are the
integration contract between bounded contexts: the Fraud context subscribes to
`MoneyTransferred` events from the Payments context without depending on the
Payments schema.

A minimal domain event as a Java record:

```java
public record MoneyTransferred(
    TransactionId transactionId,
    AccountId     debitedAccount,
    AccountId     creditedAccount,
    Money         amount,
    Instant       occurredAt
) implements DomainEvent {}
```

Records are a natural fit: domain events are value objects. Two `MoneyTransferred`
records with the same fields represent the same fact.

The bridge to the outbox: when an Account aggregate raises `MoneyTransferred`,
the application service persists the Account state and the event in the same
database transaction, writing the event to an outbox table. A relay process
then publishes it to Kafka. This guarantees the event is published if and only
if the state change committed. The mechanism is covered in depth in the Backend
System Design guide (the **Transactional outbox** section) and is the standard
approach for reliable cross-context integration.

The catch: domain events must be versioned. When a consuming context (Fraud)
depends on the shape of `MoneyTransferred`, changing its fields is a breaking
change. Append-only evolution (add fields, never remove) and versioned event
types (`MoneyTransferredV2`) are the patterns that keep the integration stable.

---

## Repository and application service

A repository is the persistence abstraction for an aggregate. It hides all
database access behind a collection-like interface: `findById(id)`,
`save(aggregate)`. The application layer never calls SQL or a query builder
directly; it calls the repository.

The application service is the use-case orchestrator: it loads the aggregate
from the repository, invokes domain logic on it, and saves it back. It holds
no domain logic itself. It is the seam between the transport layer (REST
controller, message consumer) and the domain model.

A transfer use case:

```java
@Service
public class TransferApplicationService {
    private final AccountRepository accounts;
    private final EventOutbox outbox;

    public TransferApplicationService(AccountRepository accounts,
                                      EventOutbox outbox) {
        this.accounts = accounts;
        this.outbox   = outbox;
    }

    @Transactional
    public void transfer(TransferCommand cmd) {
        Account source = accounts.findById(cmd.sourceId()).orElseThrow();
        Account target = accounts.findById(cmd.targetId()).orElseThrow();

        source.debit(cmd.amount(), cmd.transactionId());
        target.credit(cmd.amount(), cmd.transactionId());

        accounts.save(source);
        accounts.save(target);

        List<DomainEvent> events = new ArrayList<>();
        events.addAll(source.drainEvents());
        events.addAll(target.drainEvents());
        outbox.append(events);
    }
}
```

The domain logic (the invariant, the balance update) lives in `Account`. The
transaction boundary and the outbox write live in the application service. The
REST controller just parses the request and calls the service.

The catch: the anemic domain model. In an anemic model, the entities are data
bags with only getters and setters, and all the business logic leaks into the
application service. The service grows into a procedure that manipulates entity
fields directly. The code is still "DDD-shaped" (it has classes called Account
and Repository), but the model does not enforce its own invariants.

Interviewers listen for the anemic tell: if your Account class has
`setBalance()` and your service calls `account.setBalance(account.balance()
.subtract(amount))` directly, that is the signal. The rule: logic that
enforces a domain invariant belongs in the aggregate. Logic that coordinates
use cases (loading, saving, publishing) belongs in the application service.

---

## CQRS and event sourcing

CQRS (Command Query Responsibility Segregation) separates the write model from
the read model. Commands change state; queries return state. The two use
separate models optimized for their different shapes.

The value: writes need strong consistency, transaction boundaries, and
aggregate invariant enforcement. Reads need denormalized, low-latency views
tailored to specific API or UI shapes. One shared model serves neither well.
CQRS lets the write side be normalized and the read side be whatever the
consumer needs.

For a payment ledger, the write side processes debits and credits under ACID
guarantees, with aggregate locks ensuring the balance invariant. The read side
serves account balances, transaction history, and analytics queries from a
read-optimized projection: a denormalized table or a Redis cache refreshed by
consuming domain events. Balance queries and analytics can tolerate a short
replication lag without poisoning the write path.

A minimal CQRS split:

```java
// Write side: command handler, goes through the aggregate
@Transactional
public void handle(DebitCommand cmd) {
    Account account = accounts.findById(cmd.accountId()).orElseThrow();
    account.debit(cmd.amount(), cmd.transactionId());
    accounts.save(account);
    outbox.append(account.drainEvents());
}

// Read side: query handler, reads from a projection table updated by events
public AccountSummaryDto handle(AccountSummaryQuery query) {
    return readDb.findAccountSummary(query.accountId());
    // readDb is a separate read model, not the aggregate store
}
```

The catch: CQRS buys independent scaling and read-model optimization at the
cost of eventual consistency between the write and read models, plus the
operational weight of the projection pipeline (the process that consumes events
and updates the read model). Most systems do not need it. If your read and
write volumes are similar and your read shapes are simple, a single model is
less complex and correct by construction.

Event sourcing is frequently paired with CQRS but is a separable idea. In
event sourcing, the event log is the source of truth rather than the current
state: the current balance is derived by replaying `AccountDebited` and
`AccountCredited` events from the log. The write model stores events; the
current state is a projection of them.

CQRS does not require event sourcing. You can keep a conventional write model
(persist current state) with a separate read model built from domain events or
CDC. You can also have event sourcing without CQRS: a single model where
current state is always replayed from the event log, with no separate read
model. Conflating the two is a common tell in a design conversation.

---

## When not to reach for DDD

DDD pays off when the domain is genuinely complex: rich business rules, multiple
collaborating entities with invariants that span them, a large team that needs
a shared vocabulary. Payment systems, lending platforms, and logistics all fit.

DDD is expensive for thin or CRUD domains. If the core operation is "store
this record, retrieve it later," the overhead of aggregates, repositories,
domain events, and application services adds ceremony without value. A simple
product catalog or a user-settings API does not need bounded contexts and
aggregate roots.

The senior signal in a DDD conversation is naming when not to use it. An
interviewer who hears "I would apply DDD here because we have a complex domain
with invariants that span multiple entities, and because we have separate teams
that should own separate models" is hearing someone who understands the trade.
An interviewer who hears "I would use DDD because it is best practice" is
hearing someone who has read about it but has not had to pay the cost of it.

---

## Common interview questions

**What is the difference between a bounded context and a microservice?** *Testing vocabulary precision.* A bounded context is a modeling decision: a boundary around a domain model where a set of terms has precise meaning. A microservice is a deployment decision: a separately deployed, independently runnable unit. They often coincide, but a single microservice can contain multiple bounded contexts (a monolith decomposed by domain but not yet split by deployment), or a single bounded context can span multiple services. Conflating them reads as misunderstanding one or both. The catch: splitting by microservice before understanding context boundaries creates services with leaking models and cross-service database joins.

**How do you choose the aggregate boundary?** *Testing design judgment.* The aggregate boundary is the consistency boundary: everything that must be consistent in a single transaction. Start small; only expand when you cannot enforce a critical invariant without grouping more entities together. For the payment Account, the balance invariant requires the Account to be the aggregate root. Transactions are separate aggregates because you do not need to load all transactions to debit the account. The catch: the common mistake is making aggregates too large, which causes lock contention under concurrent load on high-traffic accounts.

**What is the anemic domain model and why is it a problem?** *Testing understanding of the core DDD failure mode.* An anemic model has entities with no behavior: only getters and setters. All logic lives in service classes. The problem is that invariants cannot be enforced at the model level; any code anywhere can set any field to any value. The model does not communicate the rules, and the service layer becomes a procedural blob. The fix is not renaming: moving `account.setBalance(account.balance().subtract(amount))` into `account.debit(amount)` and adding the guard inside that method is the change.

**Can you use CQRS without event sourcing?** *Testing whether you conflate the two.* Yes. CQRS means the write and read models are separate. The write side can persist current state using any mechanism (jOOQ, JPA, raw SQL) and publish domain events. The read side consumes those events and updates a projection. The event log is not the source of truth in this setup; the current-state table is. Event sourcing makes the event log the source of truth, and current state is always derived by replaying it. Both patterns are independently useful; most production CQRS implementations do not use event sourcing.

**Where does the transactional outbox fit in a DDD architecture?** *Testing cross-pattern integration.* Domain events raised by an aggregate need to reach other bounded contexts reliably. Publishing to a broker in the same thread as the database write loses events if the broker is unavailable at that moment. The outbox pattern writes the event to a database table in the same transaction as the aggregate state change, then a relay process publishes to Kafka. This guarantees exactly-once publication relative to the state change. The pattern lives at the application service layer: the service writes the aggregate and the outbox entries atomically, then the relay is a separate process.

---

## In the room

The system design round and the post-coding technical conversation are where
these words get spoken. Interviewers at companies with a strong DDD culture
hear "bounded context," "aggregate root," and "domain event" dozens of times
per week. What they calibrate is whether you can use the vocabulary precisely
and name the trade-offs, or whether you are using it as decoration.

The distinguishing answer in every case is the catch. Naming the aggregate
boundary tension (too large vs too small), naming the anemic-model failure
pattern, naming when not to reach for CQRS: these signal someone who has
designed with these patterns under production constraints.

Connect the patterns to mechanisms already in the repo. The outbox pattern in
the Backend System Design guide is where domain events leave the Payments
context. The isolation levels in the Relational Databases guide are what
protect the Account aggregate's debit/credit invariant against concurrent
reads. The Kafka guide's consumer-group model is what the Fraud context uses
to subscribe to `MoneyTransferred` events. DDD vocabulary is a layer on top of
mechanisms you already know.
