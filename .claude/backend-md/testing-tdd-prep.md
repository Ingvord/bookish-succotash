## How to use this guide

You are preparing for a live-coding round where the interviewer grades "clean,
maintainable, tested solutions." XP-influenced engineering teams treat TDD
discipline as an observable signal in the room. Writing all the production
code first and then adding tests afterward reads as not-TDD-native to an
interviewer who is watching for the sequence.

This guide gives you the procedure you can execute under observation, the
standard Java testing tool stack (JUnit 5, AssertJ, Mockito, Spock,
Testcontainers), and the design principles that make the code testable in the
first place.

Read the red-green-refactor section as a procedure, not a concept to explain.
The SOLID section explains why the procedure is possible: dependency inversion
is what gives you the seams to inject test doubles.

---

## Red-green-refactor, under observation

The loop has three steps. Red: write a failing test that defines one unit of
behavior, before writing any production code. Green: write the minimum
implementation to make the test pass. Refactor: improve the structure without
changing the behavior (tests still green after).

A worked example using the Account debit case from the domain model:

**Step 1 (red): write the failing test.**

```java
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class AccountTest {

    @Test
    void debit_reducesBalance() {
        Account account = new Account(AccountId.generate(), Money.of(200, "GBP"));

        account.debit(Money.of(50, "GBP"), TransactionId.generate());

        assertThat(account.balance()).isEqualTo(Money.of(150, "GBP"));
    }
}
```

This does not compile yet because `Account` does not exist. That is intentional:
the test is the spec. Write it first, then implement.

**Step 2 (green): minimum implementation to pass.**

```java
public class Account {
    private Money balance;

    public Account(AccountId id, Money initialBalance) {
        this.balance = initialBalance;
    }

    public void debit(Money amount, TransactionId txId) {
        this.balance = balance.subtract(amount);
    }

    public Money balance() { return balance; }
}
```

The test now passes. There is no invariant enforcement yet: that is correct.
The next test covers it.

**Step 3 (add the edge case, then refactor): add the insufficient-funds test.**

```java
@Test
void debit_throwsWhenInsufficientFunds() {
    Account account = new Account(AccountId.generate(), Money.of(30, "GBP"));

    assertThatThrownBy(() ->
        account.debit(Money.of(50, "GBP"), TransactionId.generate()))
        .isInstanceOf(InsufficientFundsException.class);
}
```

The test is red. Add the guard in `debit()`:

```java
public void debit(Money amount, TransactionId txId) {
    if (balance.isLessThan(amount)) {
        throw new InsufficientFundsException(id, amount, balance);
    }
    this.balance = balance.subtract(amount);
}
```

Both tests are green. Now refactor: rename for clarity, extract a helper if
the guard logic is repeated elsewhere, check that the method is still doing
one thing. Then move to the next behavior.

The catch: the refactor step is where most people skip under pressure. Green
with a mess is not done. In the live room, taking 60 to 90 seconds to
improve structure before moving to the next case signals TDD discipline.
Skipping the refactor step is what separates TDD-awareness from TDD-practice.

---

## The test pyramid and where each tool sits

The test pyramid describes the relative investment in test layers: many small,
fast unit tests at the base; fewer integration tests in the middle; minimal
end-to-end tests at the top. The pyramid shape reflects cost and speed: unit
tests run in milliseconds, end-to-end tests run in minutes.

The standard Java testing tool stack maps onto the pyramid:

- **JUnit 5 with AssertJ** at the unit layer: test lifecycle, parameterized
  tests, fluent assertions that read as English and produce clear failure
  messages.
- **Mockito** for collaborator isolation: stub external dependencies so unit
  tests run fast and deterministically without real I/O.
- **Spock** for BDD-style specs, particularly at the service layer and for
  data-driven cases.
- **Testcontainers** at the integration layer: real Postgres or Redis in a
  Docker container, started and torn down by the test suite.

A service-layer unit test using Mockito and AssertJ:

```java
@ExtendWith(MockitoExtension.class)
class TransferApplicationServiceTest {

    @Mock AccountRepository accounts;
    @Mock EventOutbox outbox;
    @InjectMocks TransferApplicationService service;

    @Test
    void transfer_debitsSourceAndCreditsTarget() {
        Account source = new Account(AccountId.of("src"), Money.of(200, "GBP"));
        Account target = new Account(AccountId.of("tgt"), Money.of(100, "GBP"));
        given(accounts.findById(source.id())).willReturn(Optional.of(source));
        given(accounts.findById(target.id())).willReturn(Optional.of(target));

        service.transfer(new TransferCommand(
            source.id(), target.id(),
            Money.of(50, "GBP"), TransactionId.generate()));

        assertThat(source.balance()).isEqualTo(Money.of(150, "GBP"));
        assertThat(target.balance()).isEqualTo(Money.of(150, "GBP"));
        verify(accounts, times(2)).save(any(Account.class));
    }
}
```

`@InjectMocks` injects the mocked `AccountRepository` and `EventOutbox` into
the service via constructor injection. The test never touches a database.

### Spock

Spock is a Groovy-based test framework with first-class `given/when/then`
blocks and data-driven testing via `where:` tables. It compiles to JVM
bytecode and runs inside the standard JUnit runner.

```groovy
class AccountSpec extends Specification {

    def "debit reduces the balance by the specified amount"() {
        given:
        def account = new Account(AccountId.generate(), Money.of(200, "GBP"))

        when:
        account.debit(Money.of(50, "GBP"), TransactionId.generate())

        then:
        account.balance() == Money.of(150, "GBP")
    }

    def "debit throws InsufficientFundsException when balance is too low"() {
        given:
        def account = new Account(AccountId.generate(), Money.of(initial, "GBP"))

        when:
        account.debit(Money.of(amount, "GBP"), TransactionId.generate())

        then:
        thrown(InsufficientFundsException)

        where:
        initial | amount
        30      | 50
        0       | 1
        99      | 100
    }
}
```

The `where:` block is a data table: Spock runs the test once per row,
substituting the named columns into the `given/when/then` blocks. This
replaces `@ParameterizedTest` boilerplate with a declaration. The failure
message includes the row values, so a failure at `initial=0, amount=1` is
immediately readable.

Spock has built-in mocking that integrates with the block structure:
`def repo = Mock(AccountRepository)` creates a strict mock, and
`1 * repo.save(_)` in the `then:` block asserts it was called exactly once.
No extra annotation needed.

### Testcontainers

Testcontainers starts a real database (Postgres, Redis, or any Docker image)
for the duration of a test class or suite, then tears it down. The test code
connects using the container's dynamically assigned port, exactly as it would
connect in production.

```java
@Testcontainers
@SpringBootTest
class AccountRepositoryIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres =
        new PostgreSQLContainer<>("postgres:17")
            .withDatabaseName("payments_test")
            .withUsername("test")
            .withPassword("test");

    @DynamicPropertySource
    static void configurePostgres(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url",      postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    @Autowired AccountRepository repository;

    @Test
    void save_andFind_roundtrip() {
        Account account = new Account(AccountId.generate(), Money.of(200, "GBP"));
        repository.save(account);

        Account loaded = repository.findById(account.id()).orElseThrow();

        assertThat(loaded.balance()).isEqualTo(Money.of(200, "GBP"));
    }
}
```

The catch: the container starts once per test class (static field) and adds 5
to 15 seconds of startup overhead on first run. In CI, Docker-in-Docker needs
to be enabled on the runner. The startup cost is worth it for the persistence
layer: Testcontainers catches wrong SQL, constraint violations, and
transaction-boundary leaks that an in-memory fake structurally cannot surface.

---

## The catch: over-mocking

The most common testing anti-pattern is mocking every collaborator in every
test. A test that stubs the repository, the event outbox, and the validator,
then asserts that three mocked methods were called in the right order, is
verifying the mock wiring, not the behavior.

The rule: mock at the boundary, not through the middle. Mock what you cannot
control or what you want to isolate for speed: the database in a fast unit
test, a third-party payment processor, a remote rate-limiting service. Use real
objects for domain logic collaborators that have no side effects and run in
microseconds. Use Testcontainers for the persistence layer.

The bugs that over-mocked unit tests structurally cannot catch: SQL that is
syntactically valid but semantically wrong, a database constraint you did not
model in the fake, a transaction isolation issue where two concurrent writes
race past each other. These are exactly the bugs that matter in a payment
system. The Relational Databases guide covers the isolation levels and the
TOCTOU balance-check race: a mocked repository test cannot surface a
`READ COMMITTED` vs `REPEATABLE READ` discrepancy in the actual database
transaction.

Mocking the thing you are testing is the most visible symptom: if a test
creates a `Mock(Account)` and then asserts that `account.debit()` was called,
the test verifies nothing about the Account implementation. Delete the mock,
use a real `Account`, and let the assertion on `account.balance()` do the work.

---

## SOLID as the testability lever

SOLID names five design principles. Three have direct production teeth for
testability; know these cold.

**Single Responsibility Principle (SRP):** a class has one reason to change.
A class that handles HTTP parsing, business validation, database writes, and
event publishing is hard to test: a unit test must set up all four
collaborators just to test any of them. Splitting responsibilities makes each
piece independently testable.

**Dependency Inversion Principle (DIP):** depend on abstractions (interfaces),
not on concrete classes. This is the enabling principle for all test doubling.
If `TransferApplicationService` depends directly on `JdbcAccountRepository`,
the test must have a real database. If it depends on the `AccountRepository`
interface, the test injects a fake:

```java
// Without DIP: impossible to unit test without a live database
public class TransferApplicationService {
    private final JdbcAccountRepository repo = new JdbcAccountRepository();
    // ...
}

// With DIP: inject the abstraction; tests inject a mock or fake
public class TransferApplicationService {
    private final AccountRepository accounts;
    private final EventOutbox outbox;

    public TransferApplicationService(AccountRepository accounts,
                                      EventOutbox outbox) {
        this.accounts = accounts;
        this.outbox   = outbox;
    }
    // ...
}
```

Constructor injection (shown above) is the form that works with Mockito's
`@InjectMocks`, Spock's `Mock()`, and Spring's `@Autowired`. DIP is not a
testing convenience; it is the design rule that testing makes visible. If a
class is hard to test, it usually violates DIP.

**Open/Closed Principle (OCP):** open for extension, closed for modification.
A fraud rule engine that uses a growing if-else chain over transaction types
must be modified every time a new rule type is added, and all existing tests
must re-pass a modified class. Replacing the chain with a `FraudRule` interface
(many implementations, one per rule type) lets you add a new rule by adding a
new class, with no modification to existing classes and no risk of breaking
existing tests.

The other two principles (Liskov Substitution, Interface Segregation) matter
but are less directly coupled to testability in practice. Name them if asked,
but lead with SRP and DIP: these are the ones that have visible consequences
in test design.

---

## Common interview questions

**What is the practical difference between TDD and writing tests after?** *Testing whether you understand the sequence, not just the acronym.* TDD drives design: you write the test first as a specification of the behavior you want, and the implementation emerges to satisfy it. The test-after approach verifies an existing implementation, which tends to produce tests that test the code as written rather than the behavior that is required. The practical difference is that TDD catches untestable interfaces and hard-coded dependencies at the moment they would be introduced, rather than after the class is built. The catch: following the loop mechanically does not guarantee good tests. You can do red-green-refactor and produce tests that are fragile, over-mocked, or that pin implementation details rather than observable behavior.

**When should you mock a dependency and when should you use a real one?** *Testing judgment, not a rule.* Mock what is slow, non-deterministic, or external: network calls, time, random values, third-party services. Use real objects for domain logic with no side effects. Use Testcontainers instead of fakes for the persistence layer, because the database is exactly what you want to test at the integration level. The catch: mocking the class you are testing is a sign the test verifies the mock, not the class. Also watch for mocking collaborators you own when a real instance would work fine and be faster to set up than the mock.

**Why Testcontainers instead of H2 for Postgres integration tests?** *Testing awareness of the failure modes of in-memory fakes.* H2 speaks a different SQL dialect and does not implement Postgres semantics: certain functions (`gen_random_uuid()`, `JSONB` operators), locking behavior, and index types differ. A test suite that passes on H2 can fail on Postgres in production because the fake does not faithfully represent the real system. Testcontainers runs the actual Postgres binary, so SQL behavior and locking are identical to production. The catch: Testcontainers requires Docker and adds container startup time per test class, which is a real cost in large suites.

**What does the Dependency Inversion Principle buy for testability?** *Testing whether you connect design principles to practical outcomes.* DIP means depending on interfaces rather than on concrete classes. It creates a seam at every dependency boundary where a test double (mock, stub, fake) can be injected without framework magic or reflection hacks. Without DIP, a class that constructs its own database connection is untestable in isolation. With DIP, you pass the collaborator in via the constructor, and the test passes a mock. The catch: DIP applied mechanically ("wrap everything in an interface") produces interfaces for classes that will never have a second implementation. Apply it where you genuinely need the seam: persistence, external services, time, randomness, and any collaborator you want to verify or replace in tests.

---

## In the room

TDD in a live-coding round is observable. The interviewer watches the sequence:
does the test appear before the implementation? Does the test describe
observable behavior or probe internal state? Is the refactor step taken?

The practical procedure: start by naming the first behavior out loud ("I want
to write a test for a successful debit, then for the insufficient-funds case").
Write the assertion first, fill in the setup, let the test fail, implement,
make it pass, add the edge case, refactor. Narrate the steps as you go so the
interviewer can follow your thinking.

The two highest-signal moves: (1) writing the assertion before the
implementation (the interviewer sees you think about expected behavior first),
and (2) taking the refactor step visibly (extract, rename, simplify). These are
the observable signals that separate someone who has practiced TDD from
someone who has read about it.

The DDD guide (Domain-Driven Design) covers the payment domain model that these
tests exercise. The Java Concurrency guide covers the thread-safe rate limiter
and concurrent counter tasks that are other common live-coding prompts at this
level: CAS, `LongAdder`, and `ConcurrentHashMap` with the same test-first
approach apply there.
