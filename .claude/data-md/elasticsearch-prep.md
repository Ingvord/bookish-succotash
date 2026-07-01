## How to use this guide

Elasticsearch interviews at the senior and staff level are not about recalling API
endpoints. They probe your understanding of the search engine's mechanics: why a
`term` query on a `text` field silently returns nothing, what happens to your index
when all the shards land on one node, and why adding replicas does not buy you more
write throughput. The signal the interviewer wants is someone who has been burned by
the gap between the relational-database mental model and the inverted-index reality.

This guide covers Elasticsearch 9.4.x (current stable, June 2026). All API shapes,
defaults, and scoring details are verified against the 9.x documentation. Core
behaviours (inverted index, BM25 scoring, shard routing) have been stable across
major versions.

---

## The mental model: an inverted index, not a database

Elasticsearch stores data as documents (JSON blobs), but the storage structure that
makes it fast is the inverted index: a mapping from each unique term to the list of
documents that contain it, including positional information. When you search for
`"distributed systems"`, ES looks up the postings lists for those terms and intersects
them, without scanning documents sequentially.

Every index is backed by one or more **shards**, each of which is a self-contained
Lucene index with its own inverted index. A search fans out to all relevant shards,
each returns its top-N hits, and the coordinating node merges and re-ranks them.

The catch here is the near-real-time visibility model. Documents are not visible to
search immediately after indexing. Elasticsearch writes to an in-memory buffer first.
A **refresh** (default: every 1 second) copies that buffer to a new in-memory Lucene
segment, making it searchable. Before a refresh, the document simply does not appear
in search results, even though it was indexed successfully. This trips up developers
who index and then immediately search in the same test and see nothing. The document
is there; the segment just has not been refreshed yet.

The other catch is that Elasticsearch is not a transactional store. There are no
multi-document ACID transactions, no foreign keys, no rollbacks. Documents are
updated by version: Elasticsearch uses optimistic concurrency control via `_seq_no`
and `_primary_term`. If two writers update the same document simultaneously, one wins
and the other gets a conflict error it must retry. Relational data must be
denormalized on the write side because joins at query time are not supported (the
`has_child`/`has_parent` queries exist but are expensive and rarely used in practice).

---

## Mappings: the schema you think you do not have

Every Elasticsearch index has a **mapping**: the schema that defines how each field
is indexed and stored. You can choose to define it explicitly before indexing data,
or let Elasticsearch infer it from the first documents via **dynamic mapping**.

Dynamic mapping is convenient for prototyping but dangerous in production. When
Elasticsearch sees a new field it has not been told about, it makes a guess: strings
become `text` (with a `keyword` sub-field), numbers stay numbers, dates that match
a date format become dates. Two failure modes are common. First, the guess is wrong:
an ID field like `"order_id": "20240501-0001"` is guessed as `text` (analyzed) when
you needed it as `keyword` (exact). Second, a client sends an unexpected field and
you silently grow your mapping in a way that can hit the dynamic field limit and
break indexing for all documents in the index.

The two most important field types to understand are `text` and `keyword`:

A `text` field is **analyzed**: the raw string is passed through the analysis chain
(character filters, tokenizer, token filters), and the resulting tokens are indexed in
the inverted index. A search against a `text` field also runs through the same chain.
This is what makes full-text search work: `"Quick brown fox"` and `"quick brown fox"`
both match because lowercase normalization happens at index time and query time.

A `keyword` field is **not analyzed**: the raw string is indexed as-is, as a single
token. It is used for exact matches, sorting, and aggregations. `"Quick brown fox"` as
a `keyword` field will only match a `term` query of `"Quick brown fox"` precisely.

The typical pattern is to index a string as both: a `text` field for full-text search
and a `keyword` sub-field for exact matches and aggregations.

```json
PUT /products
{
  "mappings": {
    "properties": {
      "name": {
        "type": "text",
        "analyzer": "english",
        "fields": {
          "keyword": {
            "type": "keyword",
            "ignore_above": 256
          }
        }
      },
      "sku": {
        "type": "keyword"
      },
      "price": {
        "type": "float"
      },
      "description": {
        "type": "text",
        "index": false
      },
      "tags": {
        "type": "keyword"
      }
    }
  }
}
```

Several things in this mapping are worth calling out. `name` gets the `english`
analyzer (removes stop words, applies stemming) for full-text search, plus
`name.keyword` as an exact-match and aggregation-friendly sub-field. `sku` is a
`keyword` because order IDs and SKUs must match exactly. `description` has
`"index": false`: the text is stored but not indexed, so you can retrieve it in
results but cannot search on it. This saves significant heap pressure on large free-text
fields you only need to display.

The critical catch with mappings: **you cannot change a field's type after it has been
indexed**. The inverted index for a field is built at index time based on the field's
type. If you map `price` as `text` by mistake and later realize it should be `float`,
you cannot update the mapping in place. You must create a new index with the correct
mapping, reindex all documents into it, and swap aliases so clients point to the new
index. This is the canonical production workflow for mapping changes and is worth
knowing cold.

---

## Analyzers and tokenization

An **analyzer** is a pipeline that transforms a string into a sequence of tokens. The
same analysis pipeline runs at index time (to build the inverted index) and at query
time (to tokenize the search query). If they disagree, searches will miss documents
they should have matched.

Every analyzer has three stages:

1. **Character filters** run on the raw text first. They can strip HTML (`html_strip`),
   replace characters (map `&` to `and`), or apply regular expression replacements.
   Character filters are optional.

2. **Tokenizer** splits the filtered text into tokens. The `standard` tokenizer splits
   on whitespace and punctuation, lowercases, and discards punctuation tokens. The
   `keyword` tokenizer emits the entire input as one token (used in `keyword` analyzers).
   The `whitespace` tokenizer splits only on whitespace, preserving punctuation.

3. **Token filters** transform the token stream: `lowercase` converts to lowercase,
   `stop` removes stop words (the, a, is), `stemmer` reduces words to their root form
   (`running` becomes `run`), `synonym` expands tokens with synonyms.

Elasticsearch ships several named analyzers. The `standard` analyzer uses the standard
tokenizer, lowercases, and optionally removes stop words. The `english` analyzer uses
stemming and a language-specific stop-word list. The `keyword` analyzer uses the
keyword tokenizer and no filters, so the entire value becomes one token.

You can define custom analyzers in the index settings:

```json
PUT /articles
{
  "settings": {
    "analysis": {
      "analyzer": {
        "custom_english": {
          "type": "custom",
          "char_filter": ["html_strip"],
          "tokenizer": "standard",
          "filter": ["lowercase", "stop", "stemmer_english"]
        }
      },
      "filter": {
        "stemmer_english": {
          "type": "stemmer",
          "language": "english"
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "body": {
        "type": "text",
        "analyzer": "custom_english"
      }
    }
  }
}
```

This analyzer strips HTML tags from the input, tokenizes, lowercases, removes English
stop words, and stems the remaining tokens. An article body containing
`<p>Running distributed systems at scale requires planning</p>` would be tokenized
as `["run", "distribut", "system", "scale", "requir", "plan"]`. Stop words (`at`) and
HTML tags are discarded; each word is stemmed.

You can test any analyzer using the `_analyze` API before committing it to a mapping:

```bash
GET /articles/_analyze
{
  "analyzer": "custom_english",
  "text": "<p>Running distributed systems at scale requires planning</p>"
}
```

The response lists each emitted token along with its start and end offsets in the
original string. This is the fastest way to debug why a search is not matching what
you expect: run the query text through the same analyzer and see what tokens it
produces.

The catch here is analyzer mismatch. If you index with the `english` analyzer
(which stems) but query with the `standard` analyzer (which does not), a search for
`"running"` will not stem to `"run"`, and it will not match documents that were indexed
with the stemmed token. The analyzer used at query time for a `match` query defaults
to the analyzer set on the field's mapping, so explicit mappings protect you. Where
things go wrong is when someone assigns the analyzer at index creation but later
queries with an explicit `analyzer` override in the query without realizing the mismatch.

---

## The Query DSL

Elasticsearch queries are JSON documents passed in the request body. The two most
important concepts are **query context** and **filter context**.

**Query context** asks "how well does this document match?" Elasticsearch scores
each matching document using BM25 (see the Relevance section). Scoring is
expensive and the results are not cached. Use query context for full-text search
where ranking by relevance matters.

**Filter context** asks "does this document match, yes or no?" There is no score
computed. Filter results are cached in the node's filter cache as bitsets, so
repeated filter queries are very fast. Use filter context for structured data:
exact field values, ranges, existence checks.

The `bool` query is the workhorse that combines both contexts:

```json
GET /products/_search
{
  "query": {
    "bool": {
      "must": [
        {
          "match": {
            "name": "wireless headphones"
          }
        }
      ],
      "filter": [
        {
          "term": {
            "tags": "electronics"
          }
        },
        {
          "range": {
            "price": {
              "gte": 50,
              "lte": 300
            }
          }
        }
      ],
      "must_not": [
        {
          "term": {
            "tags": "refurbished"
          }
        }
      ],
      "should": [
        {
          "term": {
            "tags": "noise-cancelling"
          }
        }
      ]
    }
  }
}
```

Walking through each clause: `must` contains the full-text `match` query on `name`.
This runs in query context, so it scores documents by how well they match
"wireless headphones" and only documents that match are included in results.
`filter` contains two conditions in filter context: the document must have the
`electronics` tag and its price must be between 50 and 300. These are applied as
a bitset filter before scoring, with no BM25 cost, and the results are cached.
`must_not` excludes refurbished items, also in filter context (no scoring).
`should` is an optional boost: documents tagged `noise-cancelling` get a higher
score, but their absence does not exclude the document (unless `minimum_should_match`
is set).

The classic gotcha is using `term` on a `text` field. A `term` query performs an
exact lookup in the inverted index: it takes your query value as-is, with no
analysis, and looks for it. A `text` field stores analyzed tokens. If you indexed
`"Wireless Headphones"` with the `standard` analyzer, the tokens stored are
`["wireless", "headphones"]`. A `term` query for `"Wireless Headphones"` (with
capital W and H) looks for that exact string as a single token and finds nothing.
The fix is to use `term` on a `keyword` field (which stores the raw value), or to
use `match` on the `text` field (which analyzes the query string first).

The `match` query runs the query string through the field's analyzer and then searches
the inverted index for those tokens. It is the correct choice for full-text search
on `text` fields.

---

## Aggregations

Aggregations let you compute summaries over a result set, similar to SQL `GROUP BY`
and aggregate functions. They run alongside the query in a single request. There are
two main families.

**Metric aggregations** compute a single value over a set of documents: `sum`, `avg`,
`min`, `max`, `value_count`, and `cardinality` (approximate distinct count). They
operate on numeric or date fields.

**Bucket aggregations** partition documents into groups (buckets) based on a criterion.
Each bucket can then have nested sub-aggregations. `terms` creates one bucket per
unique value of a field. `date_histogram` creates time buckets. `range` creates
buckets from numeric or date ranges.

Here is a `terms` aggregation with a nested `avg` metric:

```json
GET /products/_search
{
  "size": 0,
  "query": {
    "term": {
      "tags": "electronics"
    }
  },
  "aggs": {
    "by_tag": {
      "terms": {
        "field": "tags",
        "size": 10
      },
      "aggs": {
        "avg_price": {
          "avg": {
            "field": "price"
          }
        }
      }
    }
  }
}
```

`"size": 0` at the top level means: do not return matching documents, only the
aggregation results. The `by_tag` terms aggregation groups all electronics documents
by their `tags` field values, returning the top 10 tags by document count. Inside
each bucket, `avg_price` computes the average price for that tag. The response
will have one bucket per tag with a `doc_count` and an `avg_price.value`.

The important catch with `terms` aggregations is that the result is approximate. On
a multi-shard index, each shard independently computes its local top-N values by
document count and returns them to the coordinator. The coordinator merges these
partial lists. If a tag ranks 11th on one shard but 8th on another, it can fall
below the cutoff on the first shard and be omitted from the merge, even though
it would have been in the global top 10. The `shard_size` parameter (default:
`size * 1.5 + 10`) controls how many candidates each shard returns. Increasing
`shard_size` improves accuracy at the cost of more data transferred from shards to
the coordinator. For most production use cases the default is fine, but when you
need exact top-N counts, you need either a single shard (impractical) or a different
approach like a terms aggregation with `execution_hint: "map"` and a `min_doc_count`
filter.

The `cardinality` aggregation counts distinct values using HyperLogLog (HLL), a
probabilistic algorithm. By default the error rate is around 5% but can be reduced
by increasing `precision_threshold` (up to 40,000). This is important to understand
when an interviewer asks for exact distinct counts at scale: exact cardinality
requires loading all values into memory, which is expensive. For approximate counts,
`cardinality` agg is the right answer; for exact counts on small cardinality fields,
use `value_count` on a collapsed result.

---

## Shard routing and sizing

When you index a document, Elasticsearch must decide which primary shard to route it
to. The default routing formula is:

```text
shard = hash(_routing) % number_of_primary_shards
```

By default `_routing` is the document's `_id`. Because the formula uses modulo of
the primary shard count, the number of primary shards is **fixed at index creation**
and cannot be changed without reindexing. This is one of the most consequential
decisions in Elasticsearch operations. The `_split` and `_shrink` APIs can change
shard count on new indices, but they require specific constraints and are not a
substitute for planning upfront.

You can override routing by providing a custom `_routing` value at index time. This
is useful for co-locating related documents on the same shard to enable more efficient
queries. For example, routing all documents for a tenant by tenant ID ensures that
a tenant-scoped query touches only one shard instead of broadcasting to all shards.

```bash
PUT /orders/_doc/1001?routing=tenant-42
{
  "tenant_id": "tenant-42",
  "order_total": 149.99,
  "status": "shipped"
}
```

With this custom routing, a search scoped to `tenant-42` can include the same routing
value and Elasticsearch will only query the shard that holds that tenant's documents.

```bash
GET /orders/_search?routing=tenant-42
{
  "query": {
    "term": {
      "tenant_id": "tenant-42"
    }
  }
}
```

The catch with custom routing is hot shards. If you route by a field that has uneven
cardinality (a few tenants with millions of documents and many tenants with a handful),
some shards grow much larger than others. Elasticsearch cannot rebalance by splitting
a shard across nodes in real time; it can only move whole shards. An overloaded
shard becomes a performance bottleneck for every query that touches it.

For shard sizing, Elastic's general guidance is 10 to 50 GB per shard, with a goal
of no more than a few hundred shards per node. The "too many small shards" anti-pattern
is a common operational problem: an index created with 20 primary shards for a data
set that only ever grows to 5 GB means 20 shards each holding 250 MB. The per-shard
overhead (open file descriptors, heap for segment metadata) adds up. On a 10-node
cluster with 200 such indices, you can hit heap saturation before indexing any
significant volume.

Replicas are copies of primary shards that provide fault tolerance and additional
search throughput (searches can be served by replicas, not just primaries). Adding
replicas does not increase write throughput because every indexed document must be
written to the primary first and then replicated. Write throughput scales by adding
primary shards, which means more nodes or shards per node, not replicas.

---

## Relevance and scoring

Elasticsearch scores documents in query context using **BM25** (Best Match 25), which
replaced the original TF/IDF model as the default in version 5. Understanding BM25
at a mechanical level tells you how to tune relevance and debug poor rankings.

Classic TF/IDF scores a document higher the more times a term appears (TF: term
frequency) and the fewer documents contain that term (IDF: inverse document
frequency). The problem is that TF grows without a ceiling: a 10,000-word document
that mentions a term 100 times scores much higher than a 200-word document that
mentions it 10 times, even though the shorter document is almost entirely about
that term.

BM25 adds two corrections. **TF saturation**: the contribution of additional term
occurrences levels off via a logarithmic curve controlled by the `k1` parameter
(default 1.2). After a certain point, more occurrences add almost nothing to the
score. **Length normalization**: shorter documents are scored higher for the same
term frequency, controlled by the `b` parameter (default 0.75). A 200-word
document and a 10,000-word document that each mention a term 10 times will have
very different scores under BM25; the shorter document wins because its term
density is higher.

You can boost fields and queries to shift relevance weight:

```json
GET /products/_search
{
  "query": {
    "multi_match": {
      "query": "wireless headphones",
      "fields": ["name^3", "description", "tags^2"],
      "type": "best_fields"
    }
  }
}
```

Here `name^3` means the score contribution from matching in `name` is multiplied
by 3 before being combined. A match in the product name matters three times as much
as a match in the description.

When a document does not rank where you expect, the `explain` API tells you exactly
why. Adding `"explain": true` to a search request returns a full scoring breakdown
for each hit:

```json
GET /products/_search
{
  "explain": true,
  "query": {
    "match": {
      "name": "wireless headphones"
    }
  }
}
```

The `_explanation` object in each hit shows the final score and decomposes it into
IDF for each term, TF saturation for that document, and field-length normalization.
You can see exactly which term contributed what fraction of the score and why.

The catch with relevance tuning is over-boosting. It is tempting to add high boost
values to multiple fields to make everything rank first. BM25 already incorporates
field length normalization, so adding a `^10` boost to a short title field and a
`^5` to a tags field often produces surprising results when documents have unexpected
field lengths. Start with small boosts (2 or 3) and validate with the `explain` API
before pushing to production.

The `function_score` query lets you combine the BM25 score with arbitrary score
modifiers: a `field_value_factor` that multiplies the BM25 score by the value of a
numeric field (e.g., a popularity score or recency weight), a `gauss` decay function
that reduces scores for documents further from a target date or geo-point, or a
`random_score` for deterministic randomization. These are used when pure text
relevance is not enough and you need to inject business logic into ranking.

---

## Common interview questions

**Why does a `term` query on a `text` field return nothing?** The `text` field
stores analyzed tokens in the inverted index. A `term` query performs an exact,
unanalyzed lookup: it takes the query string as-is and looks for it in the inverted
index. If the original value was `"Wireless Headphones"` and the `standard` analyzer
lowercased and split it into `["wireless", "headphones"]`, then a `term` query for
`"Wireless Headphones"` finds no matching token because that exact string was never
stored. Use `match` for full-text `text` fields (it analyzes the query), or use
`term` on the `.keyword` sub-field for exact matches on the original string.

**What is the difference between refresh, flush, and fsync in Elasticsearch?**
A **refresh** copies documents from the in-memory indexing buffer into a new Lucene
segment in memory, making them searchable. It happens every second by default and
is the boundary for near-real-time visibility. A **flush** writes the in-memory
Lucene segments to disk and advances the translog checkpoint: it makes data durable
on disk without relying on the OS page cache. Elasticsearch triggers a flush
periodically (when the translog reaches a threshold) or explicitly via the
`_flush` API. A **sync** (fsync at the OS level) is what the flush calls under the
hood to ensure kernel buffers are written to physical storage. They are three
different levels of the durability pipeline: visibility in search, durability on
disk, and physical write-through.

**When does a bad shard count hurt you?** Too few primary shards caps your write
throughput and means each shard is large, so segment merges are slow and recovery
after a node failure takes a long time. Too many primary shards means high per-shard
overhead (file descriptors, heap for segment metadata), slow scatter-gather search
latency because the coordinator waits for the slowest shard, and poor BM25 accuracy
because IDF is computed per-shard using local document frequencies rather than global
ones (small shards have skewed IDF). The rule of thumb is tens of GB per shard and
no more than a few hundred shards per node. For time-series data, use ILM
(Index Lifecycle Management) to roll over to new indices and delete old shards as data
ages out.

**When are aggregation results approximate rather than exact?** `terms` aggregations
are approximate on multi-shard indices because each shard returns its local top-N
results and the coordinator merges them: values that appear frequently globally but
not in the top-N locally on some shards are underrepresented. Increase `shard_size`
to trade accuracy for coordinator memory and bandwidth. `cardinality` aggregations
use HyperLogLog and are always approximate (default error rate around 5%); increase
`precision_threshold` for tighter bounds at higher heap cost. Metric aggregations
(`sum`, `avg`, `min`, `max`) are exact because every shard computes the metric over
all its documents and the coordinator combines the partial results arithmetically.

**When would you choose `text` vs `keyword` for a string field?** Use `text` when
the field is natural language that users will full-text search (article body, product
description, review text). Use `keyword` when you need exact matches, aggregations,
or sorting (user IDs, status enums, email addresses, SKUs, tag labels). For string
fields that need both, use the multi-field pattern: map the field as `text` with
an analyzer and add a `keyword` sub-field. The `keyword` sub-field can also have
`ignore_above: 256` to skip indexing strings longer than 256 bytes (protecting
against accidentally indexing large values as keywords).

**How do you change a field's mapping in production?** You cannot change a field type
in an existing index. The production workflow is: create a new index with the
corrected mapping (often named with a version suffix, e.g. `products-v2`), reindex
all documents from the old index to the new one using the `_reindex` API, verify
document count and spot-check a sample, then atomically swap the alias that your
application uses from the old index to the new one with `POST /_aliases`. Aliases
decouple the application from the physical index name, so the swap is transparent
to clients. If you skipped aliases when you built the original index, you have to
update the application to point to the new index name during a maintenance window.
