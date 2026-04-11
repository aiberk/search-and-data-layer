import { Client as ElasticClient } from "@elastic/elasticsearch";
import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Plain document shape for indexing — no Mongoose model dependency.
 *  Callers must resolve authorName before passing in (no DB round-trip inside). */
export interface IndexableResource {
  _id: string | Types.ObjectId;
  name: string;
  description: string;
  tags: string[];
  authorName: string;
  institution: string;
  contentType: string;
  mediaType: string;
  state: string;
  yearOfCreation: number;
  checkStatus: string;
  courseName?: string;
  createdAt: Date;
}

/** Typed shape of a document in the ES index — mirrors INDEX_MAPPING.
 *  buildDocument returns this, so a missing field is a compile error. */
interface ResourceDocument {
  name: string;
  description: string;
  tags: string[];
  authorName: string;
  institution: string;
  contentType: string;
  mediaType: string;
  state: string;
  yearOfCreation: number;
  checkStatus: string;
  courseName: string | undefined;
  createdAt: Date;
}

interface SearchFilters {
  contentType?: string;
  mediaType?: string;
  institution?: string;
  yearOfCreation?: number;
  state?: string;
}

interface FacetBucket {
  value: string | number;
  count: number;
}

interface Facets {
  contentTypes: FacetBucket[];
  mediaTypes: FacetBucket[];
  institutions: FacetBucket[];
  years: FacetBucket[];
}

const EMPTY_FACETS: Facets = {
  contentTypes: [],
  mediaTypes: [],
  institutions: [],
  years: [],
};

interface SearchResult {
  hits: Array<
    ResourceDocument & {
      _id: string;
      score: number;
      highlights: Record<string, string[]>;
    }
  >;
  total: number;
  facets: Facets;
  page: number;
  totalPages: number;
  fallback?: boolean;
}

/** Minimal logger interface — inject alongside the ES client for testability. */
export interface Logger {
  info(msg: string, ...args: any[]): void;
  warn(msg: string, ...args: any[]): void;
  error(msg: string, ...args: any[]): void;
}

const defaultLogger: Logger = {
  info: (msg, ...a) => console.log(msg, ...a),
  warn: (msg, ...a) => console.warn(msg, ...a),
  error: (msg, ...a) => console.error(msg, ...a),
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Escape regex special characters to prevent ReDoS on user input. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if an error is a connectivity issue (fallback-worthy) vs a query bug.
 *
 * Heuristic: ConnectionError or HTTP >= 500 triggers fallback.
 * This means ES 503 (unavailable) falls back, but ES 400 (bad query) surfaces.
 * Note: ES 500 can also mean script errors or shard failures, which are
 * server-side bugs, not connectivity issues. We accept this trade-off because
 * a degraded search is better than no search when the ES cluster is unhealthy.
 * A stricter check would only fall back on ConnectionError and 503.
 */
function isConnectivityError(err: any): boolean {
  return err?.name === "ConnectionError" || (err?.meta?.statusCode ?? 0) >= 500;
}

/**
 * Single source of truth for filter fields — used by both ES and Mongo paths.
 * Assumes filter field names map 1:1 to document field names in both stores.
 * If ES and Mongo field names ever diverge, this needs to return separate objects.
 */
function applyFilters(
  filters: SearchFilters,
  target: Record<string, any>,
): void {
  if (filters.contentType) target.contentType = filters.contentType;
  if (filters.mediaType) target.mediaType = filters.mediaType;
  if (filters.institution) target.institution = filters.institution;
  if (filters.yearOfCreation) target.yearOfCreation = filters.yearOfCreation;
  if (filters.state) target.state = filters.state;
}

/** Typed document builder — mirrors INDEX_MAPPING so a missing field is a compile error. */
function buildDocument(doc: IndexableResource): ResourceDocument {
  return {
    name: doc.name,
    description: doc.description,
    tags: doc.tags || [],
    authorName: doc.authorName,
    institution: doc.institution,
    contentType: doc.contentType,
    mediaType: doc.mediaType,
    state: doc.state,
    yearOfCreation: doc.yearOfCreation,
    checkStatus: doc.checkStatus,
    courseName: doc.courseName,
    createdAt: doc.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Service — dependency-injectable for testability
// ---------------------------------------------------------------------------

export class ResourceSearchService {
  constructor(
    private readonly es: ElasticClient,
    private readonly indexName: string,
    private readonly log: Logger = defaultLogger,
  ) {}

  // -------------------------------------------------------------------------
  // Index mapping — boost removed from mapping (deprecated since ES 5),
  // applied only in the query via name^3, tags^2
  // -------------------------------------------------------------------------

  private static readonly INDEX_MAPPING = {
    mappings: {
      properties: {
        name: { type: "text", analyzer: "standard" },
        description: { type: "text", analyzer: "standard" },
        tags: { type: "text" },
        authorName: { type: "text" },
        institution: { type: "keyword" },
        contentType: { type: "keyword" },
        mediaType: { type: "keyword" },
        state: { type: "keyword" },
        yearOfCreation: { type: "integer" },
        checkStatus: { type: "keyword" },
        courseName: { type: "text" },
        createdAt: { type: "date" },
      },
    },
  };

  // -------------------------------------------------------------------------
  // Index lifecycle
  //
  // NOTE: This does NOT handle mapping drift. If the index already exists
  // with a stale mapping (e.g. you added a field to INDEX_MAPPING), this
  // method returns without updating it. The new field won't be searchable
  // until you manually reindex or use an alias rotation strategy.
  // For production, consider comparing the live mapping against INDEX_MAPPING
  // and either calling putMapping() for additive changes or creating a new
  // index + alias swap for breaking changes.
  // -------------------------------------------------------------------------

  async ensureIndex(): Promise<void> {
    const exists = await this.es.indices.exists({ index: this.indexName });
    if (!exists) {
      await this.es.indices.create({
        index: this.indexName,
        body: ResourceSearchService.INDEX_MAPPING,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Sync layer — accepts a plain IndexableResource, no Mongoose dependency.
  // Resolve authorName BEFORE calling this.
  // -------------------------------------------------------------------------

  async indexResource(doc: IndexableResource): Promise<void> {
    await this.es.index({
      index: this.indexName,
      id: doc._id.toString(),
      body: buildDocument(doc),
    });
  }

  async removeResource(resourceId: Types.ObjectId | string): Promise<void> {
    try {
      await this.es.delete({
        index: this.indexName,
        id: resourceId.toString(),
      });
    } catch (err: any) {
      if (err.meta?.statusCode !== 404) throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Search — multi-field fuzzy query with faceted aggregations
  // -------------------------------------------------------------------------

  async search(
    query: string,
    filters: SearchFilters = {},
    page = 1,
    limit = 20,
  ): Promise<SearchResult> {
    // Intentionally duplicates the handler's clamping so search() is safe to call
    // directly from tests or other handlers without going through the Express layer.
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const from = (safePage - 1) * safeLimit;

    const must: Record<string, any>[] = [];
    const filterClauses: Record<string, any>[] = [];

    if (query?.trim()) {
      must.push({
        multi_match: {
          query: query.trim(),
          fields: [
            "name^3",
            "tags^2",
            "description",
            "authorName",
            "courseName",
          ],
          fuzziness: "AUTO",
          prefix_length: 1,
          max_expansions: 50,
        },
      });
    } else {
      must.push({ match_all: {} });
    }

    // Build ES term filters from the shared filter helper
    const termSource: Record<string, any> = {};
    applyFilters(filters, termSource);
    for (const [field, value] of Object.entries(termSource)) {
      filterClauses.push({ term: { [field]: value } });
    }
    filterClauses.push({ term: { checkStatus: "approve" } });

    const body = {
      from,
      size: safeLimit,
      query: { bool: { must, filter: filterClauses } },
      highlight: {
        pre_tags: ["<em>"],
        post_tags: ["</em>"],
        fields: {
          name: { number_of_fragments: 0 },
          description: { fragment_size: 150, number_of_fragments: 2 },
          tags: { number_of_fragments: 0 },
          authorName: { number_of_fragments: 0 },
        },
      },
      aggs: {
        contentTypes: { terms: { field: "contentType", size: 20 } },
        mediaTypes: { terms: { field: "mediaType", size: 20 } },
        institutions: { terms: { field: "institution", size: 50 } },
        years: { terms: { field: "yearOfCreation", size: 30 } },
      },
    };

    const result = await this.es.search({ index: this.indexName, body });
    const hits = result.hits.hits as any[];
    const aggs = result.aggregations as any;
    const total = (result.hits.total as any).value;

    const mapBuckets = (buckets: any[]): FacetBucket[] =>
      (buckets || []).map((b) => ({ value: b.key, count: b.doc_count }));

    return {
      hits: hits.map((hit) => ({
        _id: hit._id,
        score: hit._score,
        ...hit._source,
        highlights: hit.highlight || {},
      })),
      total,
      facets: {
        contentTypes: mapBuckets(aggs.contentTypes.buckets),
        mediaTypes: mapBuckets(aggs.mediaTypes.buckets),
        institutions: mapBuckets(aggs.institutions.buckets),
        years: mapBuckets(aggs.years.buckets),
      },
      page: safePage,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  // -------------------------------------------------------------------------
  // Bulk reindex — cursor-based batching via async iterable.
  // Accepts any AsyncIterable<IndexableResource> so callers can pass a
  // Mongoose cursor, an array, or a test fixture without a DB connection.
  // -------------------------------------------------------------------------

  async reindexAll(
    source: AsyncIterable<IndexableResource>,
    batchSize = 500,
  ): Promise<void> {
    await this.ensureIndex();

    let attempted = 0;
    // Typed as any[] because the ES bulk API interleaves action objects and
    // document bodies in the same array — no single type covers both.
    let batch: any[] = [];

    for await (const resource of source) {
      batch.push(
        { index: { _index: this.indexName, _id: resource._id.toString() } },
        buildDocument(resource),
      );

      if (batch.length >= batchSize * 2) {
        attempted += await this.flushBatch(batch);
        batch = [];
      }
    }

    attempted += await this.flushBatch(batch);

    this.log.info(`Reindex complete: ${attempted} documents attempted`);
  }

  /** Flush a batch of bulk operations. Returns the number of documents attempted. */
  private async flushBatch(batch: any[]): Promise<number> {
    if (!batch.length) return 0;

    const { errors, items } = await this.es.bulk({ body: batch });
    if (errors) {
      const failed = (items ?? [])
        .filter((item: any) => item.index?.error)
        .map((item: any) => ({
          id: item.index?._id,
          error: item.index?.error,
        }));
      this.log.error(`Bulk reindex: ${failed.length} failures`, failed);
    }

    return batch.length / 2;
  }
}

// ---------------------------------------------------------------------------
// Express handler factory — falls back to MongoDB only on connectivity errors
// ---------------------------------------------------------------------------

/** Parse a query param as a non-empty string, or undefined. Avoids `as string` lying about undefined. */
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length ? v : undefined;

/**
 * Creates an Express handler that searches via Elasticsearch and falls back
 * to MongoDB on connectivity errors only. Query construction bugs (400s)
 * surface via next(err) instead of silently degrading.
 *
 * @param service       The search service instance
 * @param fallbackFind  Queries MongoDB — injected so the handler doesn't
 *                      import the Resource model directly
 * @param log           Logger for fallback warnings
 */
export function createSearchHandler(
  service: ResourceSearchService,
  fallbackFind: (
    filter: Record<string, any>,
    skip: number,
    limit: number,
  ) => Promise<{ resources: any[]; total: number }>,
  log: Logger = defaultLogger,
) {
  return async function searchResourcesHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const query = str(req.query.q) || "";
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(
      Math.max(1, parseInt(req.query.limit as string, 10) || 20),
      100,
    );
    const filters: SearchFilters = {
      contentType: str(req.query.contentType),
      mediaType: str(req.query.mediaType),
      institution: str(req.query.institution),
      yearOfCreation: req.query.year
        ? parseInt(req.query.year as string, 10)
        : undefined,
      state: str(req.query.state),
    };

    // page and limit are clamped once here — both the ES path (which clamps
    // internally too, harmlessly) and the fallback path use the same values.

    try {
      const results = await service.search(query, filters, page, limit);
      res.json(results);
    } catch (err: any) {
      if (!isConnectivityError(err)) {
        return next(err);
      }

      log.warn(
        "Elasticsearch unavailable, falling back to MongoDB:",
        err.message,
      );

      try {
        const escaped = escapeRegex(query);
        const regex = new RegExp(escaped, "i");

        // Use the shared filter helper so fields stay in sync with search()
        const mongoFilter: Record<string, any> = { name: { $regex: regex } };
        applyFilters(filters, mongoFilter);

        const { resources, total } = await fallbackFind(
          mongoFilter,
          (page - 1) * limit,
          limit,
        );

        // NOTE: Fallback hits lack `score` and `highlights` that the ES path
        // always populates. The `satisfies` check verifies the outer shape
        // but can't enforce per-hit fields since fallbackFind returns any[].
        res.json({
          hits: resources,
          total,
          facets: EMPTY_FACETS,
          page,
          totalPages: Math.ceil(total / limit),
          fallback: true,
        } satisfies SearchResult);
      } catch (fallbackErr) {
        next(fallbackErr);
      }
    }
  };
}
