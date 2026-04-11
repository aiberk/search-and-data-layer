# Elasticsearch Resource Discovery  -  Multi-Field Fuzzy Search with Relevance Scoring

> **Origin:** Selected code from shipped production software

## Problem

The platform's existing search uses MongoDB regex on the resource name field only. Faculty and students can't find resources by description, tags, author, institution, or content type  -  and typos return zero results. With hundreds of educational resources across dozens of courses, discovery is broken.

## Solution

An Elasticsearch integration that indexes resources across all searchable fields with field-level boosting, fuzzy matching, and highlighted snippets:

- **Multi-field indexing**  -  resources are indexed across `name`, `description`, `tags`, `authorName`, `institution`, `contentType`, and `mediaType` with per-field boost weights so title matches rank higher than description matches
- **Fuzzy matching**  -  `fuzziness: "AUTO"` handles typos (e.g., "enviroment" still finds "environment") with edit-distance scaling based on term length
- **Faceted filtering**  -  search results include aggregation buckets for `contentType`, `mediaType`, `institution`, and `yearOfCreation`, enabling drill-down filtering without additional queries
- **Highlighted snippets**  -  matching fragments are returned with `<em>` tags so the frontend can show why a result matched
- **Sync on write**  -  resource create/update/delete operations push changes to Elasticsearch in real time via a lightweight sync layer; no batch reindex needed
- **Graceful degradation**  -  if Elasticsearch is down, the search falls back to the existing MongoDB regex query

## Key Design Decisions

- **Field boosting over equal weight**  -  `name^3, tags^2, description^1` ensures a title match for "climate policy" ranks above a resource that merely mentions it in the description
- **`AUTO` fuzziness**  -  Elasticsearch's auto mode uses edit distance 0 for 1-2 char terms, 1 for 3-5 chars, and 2 for 6+ chars; this prevents absurd matches on short terms while being forgiving on longer ones
- **Aggregations in the search query**  -  facet counts come back in the same request as results, so the frontend can render filter sidebar counts without a second round-trip
- **Sync over reindex**  -  with hundreds (not millions) of resources, real-time sync is simpler and more consistent than periodic batch reindexing

## Concepts Demonstrated

- Elasticsearch multi-field search with boosting and fuzziness
- Aggregation-based faceted filtering
- Search result highlighting
- Real-time index sync on MongoDB write operations
- Graceful fallback to MongoDB regex search