## How to use this guide

This guide is a primer, not a survey of every vector database on the market. It exists
for the moment an interview turns to "how would you build semantic search over our
product catalog" or a system-design round drops "how would you ground an LLM in our
docs" (the retrieval half of RAG) and you need to explain, correctly and concretely,
what a vector database actually does differently from the relational store you already
know.

It covers one purpose-built engine (Qdrant, walked through with a runnable example) and
one "you already have Postgres" alternative (pgvector), because those two answers cover
almost every real decision you will face: stand up a dedicated engine, or add an
extension to the database you already run. Versions are pinned and verified as of
July 2026: Qdrant v1.17.x and pgvector v0.8.0.

---

## The mental model: search by meaning, not by match

A conventional database answers questions with an exact predicate: "give me the rows
where `species = 'dog'`" or "give me the rows where `price < 50`." The index (a B-tree,
a hash) exists to make that predicate fast, but the predicate itself is exact. Either a
row satisfies `species = 'dog'` or it does not.

A vector database answers a different kind of question: "give me the listings most
*similar in meaning* to 'a calm lap companion for a small flat.'" There is no column
that equals that string. Nothing in the data literally matches the query. The only way
to answer it is to convert both the query and every candidate row into a numeric
representation of their meaning, a vector, and then ask which vectors are closest
together in that space.

```text
                       "a calm lap companion
                        for a small flat"  (query)
                              *
                             / \
                            /   \
                    o------o     o------o
                 Persian cat   Senior beagle
                  (close)       (close)
                                            o
                                      Border Collie
                                       (far: high energy,
                                        not "calm")
```

This is the whole reframe: embeddings turn unstructured meaning into geometry, and
"search" becomes "find the nearest points." Everything else in this guide, why the
index looks different, why results are ranked instead of matched, why the search is
approximate, follows from that one idea.

---

## How this differs from a conventional database

The difference is not "vector databases are databases with an extra data type." The
query model, the index structure, and the correctness guarantees are all different.

| | Conventional (B-tree / SQL) | Vector (ANN) |
|---|---|---|
| Query type | Exact match, range, join | Nearest-neighbour by distance |
| What the index encodes | Sorted keys or hash buckets | A graph or partitioning of the vector space |
| Result semantics | Rows that satisfy the predicate | Top-k rows ranked by distance, always returns k results even if the closest one is a poor match |
| Correctness | Exact: every matching row is returned | Approximate: recall is a tunable number below 100% |
| `WHERE` clause | Native, first-class | Bolted on: has to interact with the ANN index (see below) |
| Write cost | O(log n) index insert | HNSW insert is more expensive; graph edges must be rewired |

Three catches sit underneath that table:

**The search is approximate on purpose.** Exact nearest-neighbour search means
computing the distance from the query to every single vector, which is O(n) per query
and does not scale past a few tens of thousands of vectors. Approximate Nearest
Neighbour (ANN) indexes trade a small, tunable amount of accuracy (recall, the fraction
of true nearest neighbours actually returned) for orders-of-magnitude faster queries.
"Approximate" is not a bug to route around, it is the mechanism that makes vector
search viable at scale, but it means two identical queries against an ANN index can
occasionally return slightly different top-k sets, and it means recall is a dial you
tune, not a promise you get for free.

**There is no `LIKE`, and filtering interacts with the index.** A vector index has no
concept of "starts with" or "contains" (that is a text-search problem, solved by an
inverted index like Elasticsearch, not a vector index). More subtly, combining a
structured filter (`species = 'dog'`) with a vector search is not just "run the filter
then run the search." **Pre-filtering** (filter first, then search only the surviving
vectors) can break the ANN graph's navigation and hurt recall if the filter is
selective. **Post-filtering** (run the ANN search, then discard results that fail the
filter) can return fewer than k results if the filter is selective, because the
discarded ones are already gone. Production vector databases (Qdrant included) build
filtering into the graph traversal itself to avoid both failure modes, which is a
non-trivial part of what you are paying a purpose-built engine for.

**You still need a source of truth.** A vector database stores an embedding plus
whatever metadata (payload) you attached to it. It is not where you keep your
authoritative product catalog, user records, or order history. The normal architecture
is: relational or document store holds the record, a background job embeds the
relevant text and writes the vector (plus enough payload to filter and render results)
into the vector store. This means the vector store can go stale relative to the source
of truth, and re-sync is a pipeline you own.

```text
Conventional lookup (B-tree):           ANN lookup (HNSW, simplified):

  root                                   layer 2:  A ----------- E
   |                                                |             |
  [k5]                                   layer 1:  A --- C --- E --- G
  /   \                                             |     |     |     |
[k2,k4] [k7,k9]                          layer 0:  A-B-C-D-E-F-G-H  (every point)
   |        |
 exact     exact                         query descends from sparse top layer,
 match     match                         greedily hops toward the query point,
                                          gets denser near the bottom
```

---

## Embeddings: the bridge

An embedding is a fixed-length vector of floating-point numbers produced by a trained
model, positioned so that inputs with similar meaning end up close together in that
space. `all-MiniLM-L6-v2` (the model used later in this guide) produces 384-dimensional
vectors; larger models commonly produce 768 or 1536 dimensions. More dimensions can
capture more nuance but cost more memory and more distance-computation time per query.

```python
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")
vector = model.encode("a calm lap companion for a small flat")
print(len(vector))   # 384
print(vector[:5])    # [0.0123, -0.0456, 0.0789, ...]
```

"Closeness" needs a distance metric. **Cosine similarity** measures the angle between
two vectors and ignores magnitude, the standard default for text embeddings, where
direction encodes meaning more reliably than length. **Dot product** is cosine
similarity without the normalization step, cheaper to compute, and correct only if
your vectors are already unit-length (many embedding models, including MiniLM,
normalize their output, which makes dot product and cosine equivalent and lets you
use the cheaper one). **Euclidean distance** measures straight-line distance and
matters more for embeddings where magnitude itself is meaningful (some image or
audio embeddings), which is rarer in text search.

The catch that bites in production: **the same model has to embed both the documents
and the queries**, because the vector space a model produces is specific to that
model's training. Swapping to a different embedding model (even a "better" one) does
not mean re-pointing the same index at new vectors, it means every stored vector is
now meaningless relative to new queries, and you have to re-embed and re-index the
entire dataset. Budget for that migration cost before you pick a model, not after.

---

## ANN and the HNSW index

Brute-force k-nearest-neighbour search computes the distance from the query to every
stored vector, an O(n · d) scan (n vectors, d dimensions) per query. At a few thousand
vectors that is fine. At tens of millions, it is not: a single query would touch every
vector, every time.

**HNSW** (Hierarchical Navigable Small World) is the ANN index both Qdrant and pgvector
use by default. It builds a multi-layer graph where each point is a node and edges
connect it to nearby points. The top layer is sparse and connects distant points (fast,
long hops); each layer down is denser (short, precise hops), until the bottom layer
contains every point. A query starts at the sparse top layer, greedily walks toward the
query point, then drops down a layer and repeats, refining as it goes, until it lands
on a small candidate set at the bottom layer to rank.

Three knobs control the recall/latency/memory tradeoff, and every vector-DB interview
question about tuning maps back to one of them:

- **`m`** (Qdrant) / graph degree: how many edges each node keeps. Higher `m` means
  better recall and a larger, slower-to-build graph.
- **`ef_construct`**: how wide the search is during index build. Higher values produce
  a better-quality graph at the cost of much slower ingestion.
- **`ef_search`** (Qdrant's `hnsw_ef`, pgvector's `hnsw.ef_search`): how wide the search
  is at query time. Higher values improve recall at the cost of query latency. This is
  the one knob you can safely tune per-query without rebuilding anything.

The catch: HNSW graphs are memory-resident and expensive to build (they cannot be
built incrementally as cheaply as a B-tree insert, since inserting a point may rewire
neighbouring edges). **IVFFlat**, pgvector's other index type, partitions vectors into
clusters via k-means at build time and only searches the nearest clusters at query
time. It builds faster and stores more compactly than HNSW, but its clustering is fixed
at build time (a `CREATE INDEX` on data that later grows or shifts distributionally
degrades its quality until you rebuild it), and it generally trails HNSW on the
recall/latency curve. As of pgvector 0.8.0, HNSW is the recommended default for most
applications (RAG pipelines, semantic search, recommendation) because it needs less
tuning and handles ongoing writes better; IVFFlat remains the right call when build
time and index size matter more than query recall, typically at large scale with
infrequent, batched updates.

---

## The Pet Shop app: deploy Qdrant with Docker

The rest of this guide is one runnable example: a small pet shop's listing search,
where a shopper can type "a calm lap companion for a small flat" and get ranked
results, optionally filtered by species. It uses Qdrant v1.17.1 and a local embedding
model, so it needs no API key and runs entirely offline after the first `docker
compose up`.

### Project layout

```text
petshop/
  docker-compose.yml
  requirements.txt
  app/
    pets.json
    ingest.py
    search.py
```

### docker-compose.yml

Qdrant ships as a single container. Pin the tag rather than tracking `latest`:
v1.17 removed Qdrant's RocksDB storage backend in favour of a new engine called
Gridstore, and the project's supported upgrade path is one minor version at a time
(1.14 to 1.15 to 1.16 to 1.17), so an unpinned image can jump you across that
boundary on a routine `docker compose pull`. Port `6333` serves the REST/dashboard
API, `6334` serves gRPC. The named volume is what makes data survive a container
restart, the single most common Qdrant demo mistake is forgetting it and losing the
collection on the next `docker compose down`.

```yaml
services:
  qdrant:
    image: qdrant/qdrant:v1.17.1
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant_storage:/qdrant/storage

  app:
    build: ./app
    depends_on:
      - qdrant
    volumes:
      - ./app:/app
    working_dir: /app
    command: sleep infinity

volumes:
  qdrant_storage:
```

```text
# app/Dockerfile
FROM python:3.12-slim
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
```

```text
# requirements.txt
qdrant-client==1.12.*
sentence-transformers==3.*
```

### The dataset

A dozen listings is enough to see ranking behave sensibly without hand-picking a
trivial two-item example.

```json
[
  {"id": 1, "name": "Milo", "species": "cat", "temperament": "calm, affectionate",
   "description": "A quiet Persian cat who loves lap time and short naps in sunny spots. Great for a small apartment."},
  {"id": 2, "name": "Rex", "species": "dog", "temperament": "high-energy, loyal",
   "description": "A young Border Collie that needs daily runs and mental stimulation. Best for an active owner with a yard."},
  {"id": 3, "name": "Biscuit", "species": "dog", "temperament": "gentle, low-energy",
   "description": "A senior beagle, content with short walks and a lot of couch time. Good fit for a quiet household."},
  {"id": 4, "name": "Nova", "species": "cat", "temperament": "playful, independent",
   "description": "A curious tabby who chases toys but is happy to be left alone during the workday."},
  {"id": 5, "name": "Pepper", "species": "bird", "temperament": "vocal, social",
   "description": "A talkative parakeet that bonds closely with one person and needs daily interaction."}
]
```

### Ingest

The collection is created once with a fixed vector size (matching the embedding
model's output dimension) and a distance metric. `upsert` writes a point per listing:
the vector for similarity search, and a `payload` dict for the metadata you filter and
render on, in this case the whole listing so results are self-contained.

```python
# app/ingest.py
import json
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")
client = QdrantClient(host="qdrant", port=6333)

COLLECTION = "pets"

if client.collection_exists(COLLECTION):
    client.delete_collection(COLLECTION)
client.create_collection(
    collection_name=COLLECTION,
    vectors_config=VectorParams(size=384, distance=Distance.COSINE),
)

pets = json.load(open("pets.json"))
points = [
    PointStruct(
        id=pet["id"],
        vector=model.encode(pet["description"]).tolist(),
        payload=pet,
    )
    for pet in pets
]

client.upsert(collection_name=COLLECTION, points=points)
print(f"Ingested {len(points)} pets")
```

### Query

This is where the "combined structured and semantic search" point becomes concrete.
The `Filter` runs as a metadata predicate (exactly like a `WHERE` clause), while
`query` runs as a vector similarity search, and Qdrant applies both together during
graph traversal rather than as two separate passes.

```python
# app/search.py
import sys
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")
client = QdrantClient(host="qdrant", port=6333)

query_text = sys.argv[1] if len(sys.argv) > 1 else "a calm companion for a small flat"
species_filter = sys.argv[2] if len(sys.argv) > 2 else None

query_filter = None
if species_filter:
    query_filter = Filter(
        must=[FieldCondition(key="species", match=MatchValue(value=species_filter))]
    )

results = client.query_points(
    collection_name="pets",
    query=model.encode(query_text).tolist(),
    query_filter=query_filter,
    limit=3,
).points

for r in results:
    print(f"{r.score:.3f}  {r.payload['name']} ({r.payload['species']}): "
          f"{r.payload['description'][:60]}...")
```

### Run it

```bash
docker compose up -d
docker compose exec app python ingest.py
docker compose exec app python search.py "a calm lap companion for a small flat"
docker compose exec app python search.py "an active dog for daily runs" dog
```

```text
0.444  Biscuit (dog): A senior beagle, content with short walks and a lot...
0.368  Milo (cat): A quiet Persian cat who loves lap time and short naps...
0.359  Nova (cat): A curious tabby who chases toys but is happy to be left...

0.605  Rex (dog): A young Border Collie that needs daily runs and mental...
0.401  Biscuit (dog): A senior beagle, content with short walks and a lot...
```

(Output captured from an actual run against Qdrant v1.17.1 and
`all-MiniLM-L6-v2`; exact scores can shift slightly across model or Qdrant
versions, but the ranking logic below holds.) Note the second query only
returned dogs (the filter narrowed the candidate set before ranking, there
are only two dogs in the dataset) and ranked Rex above Biscuit because
"active" and "daily runs" sit closer to Rex's description in embedding
space, not because of any keyword overlap: neither query contains the word
"Rex" or "Collie." That is the semantic-search payoff in one example. The
Qdrant web dashboard at `http://localhost:6333/dashboard` lets you browse
the collection and re-run queries visually, useful for demoing this live.

---

## The pgvector alternative: staying in Postgres

Not every project justifies a new datastore. If the data already lives in Postgres and
the scale is moderate (roughly under a few million vectors, though this depends
heavily on dimension count and query load), adding the `vector` extension is often the
right call: one fewer system to operate, and vector search participates in the same
transactions as the rest of your data, so a listing and its embedding are written and
rolled back together.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE pets (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    species     text NOT NULL,
    description text NOT NULL,
    embedding   vector(384)
);

CREATE INDEX ON pets USING hnsw (embedding vector_cosine_ops);

-- nearest neighbours, filtered by species, in one query
SELECT name, species, description,
       embedding <=> '[0.012, -0.045, ...]' AS distance
FROM pets
WHERE species = 'dog'
ORDER BY embedding <=> '[0.012, -0.045, ...]'
LIMIT 3;
```

`<=>` is pgvector's cosine-distance operator (`<->` is Euclidean, `<#>` is negative
inner product); the same operator used in the index and the `ORDER BY` is what lets
Postgres's planner use the HNSW index instead of a sequential scan.

The tradeoff runs the other way at scale and under load: Qdrant is purpose-built for
vector workloads, so its filtering-aware graph traversal, horizontal sharding, and
payload indexing are first-class and tuned for exactly this access pattern. pgvector
shares Postgres's resource budget, so a large HNSW index build competes with your
transactional workload for memory and I/O, and its filtered-search behaviour depends
on the query planner choosing to use the index at all, which for highly selective
`WHERE` clauses it does not always do. The honest framing in an interview: reach for
pgvector when the data is already relational and the scale is moderate; reach for a
dedicated engine when vector search is the primary access pattern, the dataset is
large, or you need filtering and vector search to genuinely co-optimize.

---

## Common interview questions

**Why is vector search approximate instead of exact?** Exact k-nearest-neighbour
search requires computing the distance from the query to every stored vector, an
O(n) scan per query. That does not scale past tens of thousands of vectors at
interactive latency. ANN indexes like HNSW trade a small, tunable amount of recall
for a massive speedup by searching a graph or a partitioned subset instead of
everything. Recall is not a fixed number, it is controlled by `ef_search` (query
time) and `ef_construct`/`m` (build time), and the right value is a latency budget
decision, not a correctness bug to eliminate.

**How is this different from full-text search (Elasticsearch, BM25)?** BM25 and
inverted indexes match on tokens: they find documents containing specific words, and
rank by term frequency and rarity. Vector search matches on meaning: it finds
documents whose embedding is close to the query's embedding, even with zero shared
vocabulary ("a calm lap companion" and "quiet Persian cat" share no words). They fail
in opposite ways: keyword search misses semantically relevant results with different
wording, vector search can surface results that are topically related but miss an
exact term the user actually needs (a specific product SKU, an error code). Production
search systems increasingly run **hybrid search**: BM25 and vector search in parallel,
merged with a reranking step (often reciprocal rank fusion), to get both exact-term
precision and semantic recall.

**How do you combine a structured filter with a vector search?** Naively you have two
bad options: pre-filter (filter first, search only survivors) which can break the ANN
graph's connectivity and tank recall when the filter is selective, or post-filter
(search first, then discard non-matching results) which can return fewer than k
results if the filter is selective, since discarded results are gone and not replaced.
Purpose-built engines like Qdrant push the filter into the graph traversal itself so it
only follows edges to points that satisfy the filter, avoiding both failure modes. This
is a genuine engineering difference from bolting a `WHERE` clause onto a separate
vector index.

**How many dimensions should an embedding have, and does it matter?** It is
determined by the embedding model, not chosen independently: `all-MiniLM-L6-v2`
produces 384, many OpenAI/Anthropic-class embedding APIs produce 1536 or higher.
More dimensions can capture finer semantic distinctions but cost more memory per
vector and more time per distance computation, so a larger model is not automatically
better for a given application, it is a tradeoff between semantic fidelity and index
size/latency you should benchmark for your data, not assume.

**When do you reach for pgvector instead of a dedicated vector database?** When the
vectors are naturally attached to data that already lives in Postgres, the scale is
moderate, and you value transactional consistency (write the row and its embedding
together, roll both back together) and operational simplicity (one fewer system) over
the filtering-aware traversal, sharding, and payload-indexing that a purpose-built
engine offers. Re-evaluate once vector search becomes the dominant access pattern or
the dataset grows past what a single Postgres instance comfortably indexes.

**How do you keep the vector store in sync with the source of truth?** The vector
store is a derived index, not the record of truth. The common pattern is
event-driven: a write to the primary store (Postgres, a document DB) emits an event
(via an outbox pattern or CDC) that triggers re-embedding and an upsert into the
vector store. Because embedding is comparatively expensive (a model inference call
per document), most systems batch and debounce this rather than embedding
synchronously on every write, which means the vector index is eventually consistent
with the source of truth, and that lag is a design parameter you should be able to
state a number for.

**What breaks when you change the embedding model?** Every existing vector becomes
incomparable to new queries, because the vector space a model produces is specific to
that model's training run. This is not a config change, it is a full re-embed and
re-index of the entire dataset, and during the cutover you either accept a period of
mixed-model inconsistency or run both the old and new collections in parallel and
cut over atomically. Budget for this migration cost when picking a model, since
"swap to a better embedding model later" is a much bigger project than it sounds.

---

## Framing it in the room

Lead with the reframe: conventional databases match on exact predicates, vector
databases rank by distance in a learned embedding space, and that difference in kind
(not just implementation) is why the index, the query semantics, and the correctness
guarantees are all different. Name ANN and HNSW specifically rather than saying
"it's fast," and be ready to name the recall/latency knob (`ef_search`) that trades
between them. Always mention that the vector store is a derived index with a source
of truth behind it, that single sentence signals you have actually operated one of
these systems rather than read about them.
