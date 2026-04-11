# Bulk Write Optimization  -  Replacing N Sequential Saves with a Single `bulkWrite`

> **Origin:** Selected code from shipped production software

## Problem

Several operations in the codebase save documents one-by-one inside loops:

- **Course copy**  -  duplicating a course migrates each resource with individual `new Resource().save()` calls. A course with 30 resources makes 30 sequential round-trips to MongoDB.
- **Author creation**  -  uploading a resource with multiple co-authors saves each `AuthorAlternative` document individually.
- **Course time slots**  -  creating or updating a course saves each time slot one at a time.

Each `save()` is a full round-trip: serialize → send → wait for write concern → deserialize response. At 30 documents, that's 30x the latency of a single operation.

## Solution

Replace sequential `save()` loops with MongoDB's `bulkWrite`  -  a single command that batches multiple insert/update/delete operations into one round-trip:

- **Course copy**  -  builds an array of `insertOne` operations for all resources, then executes one `bulkWrite` call
- **Author creation**  -  collects all co-author documents into a batch and inserts them in one shot
- **Course time slots**  -  deletes old slots and inserts new ones in a single `bulkWrite` with mixed operation types (`deleteMany` + `insertOne`)

### Before (N round-trips)

```javascript
for (let i = 0; i < oldResources.length; i++) {
  let newResource = new Resource({
    ...oldResources[i],
    courseId: newCourse._id,
  });
  await newResource.save(); // round-trip #i
}
```

### After (1 round-trip)

```javascript
const ops = oldResources.map((r) => ({
  insertOne: {
    document: { ...r, courseId: newCourse._id, createdAt: new Date() },
  },
}));
await Resource.bulkWrite(ops); // single round-trip
```

## Key Design Decisions

- **`bulkWrite` over `insertMany`**  -  `bulkWrite` supports mixed operation types (insert + update + delete in one call), which is needed for the course time slot case; `insertMany` only handles inserts
- **`ordered: false`**  -  operations don't depend on each other, so unordered execution lets MongoDB parallelize writes internally and continue past individual failures
- **Preserving `_id` generation**  -  `new mongoose.Types.ObjectId()` is called client-side so the IDs are available immediately for the author-to-resource relationship without a second query
- **Error handling**  -  `bulkWrite` returns a `BulkWriteResult` with per-operation error details; the handler logs failures without rolling back successful writes (appropriate for non-transactional data like resource copies)

## Concepts Demonstrated

- MongoDB `bulkWrite` with mixed operation types
- Unordered batch execution for parallelized writes
- Client-side ObjectId generation for relationship linking
- Reducing N+1 round-trip patterns to single-call operations