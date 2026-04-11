import mongoose, { Types } from "mongoose";
import { Request, Response, NextFunction } from "express";
import Course, { ICourse } from "../models/Course";
import Resource, { IResource } from "../models/Resource";
import AuthorAlt, { IAuthorAlt } from "../models/AuthorAlternative";
import CourseTime, { ICourseTime } from "../models/CourseTime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @requires authMiddleware — populates req.user before this handler runs. */
interface AuthenticatedRequest extends Request {
  user: { _id: Types.ObjectId; userName: string };
  params: { courseId: string; resourceId?: string };
  body: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Returns the value if it's a non-empty string, otherwise undefined. */
function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`Missing or invalid field: ${fieldName}`);
  }
  return value.trim();
}

// NOTE: ValidationError is defined here for locality. If a second handler file
// needs it, move it to a shared errors.ts module rather than duplicating.
class ValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// ---------------------------------------------------------------------------
// Course copy — migrate all resources in a single bulkWrite
// ---------------------------------------------------------------------------

/**
 * Copies a course and all its resources to a new course.
 * Before: N sequential `new Resource().save()` calls (one per resource).
 * After:  1 bulkWrite call with N insertOne operations.
 */
export async function copyCourse(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const oldCourse = await Course.findById(req.params.courseId);
    if (!oldCourse) {
      res.status(404).json({ error: "Course not found" });
      return;
    }

    const coursePin = await getCoursePin();

    const newCourse = await new Course({
      courseName: requireString(req.body.courseName, "courseName"),
      ownerId: req.user._id,
      instructor: req.user.userName,
      coursePin,
      semester: requireString(req.body.semester, "semester"),
      state: oldCourse.state,
      institution: oldCourse.institution,
      institutionURL: oldCourse.institutionURL,
    }).save();

    // Migrate resources — single bulkWrite instead of N saves
    if (req.body.resourcesToCopy === "self") {
      const oldResources = await Resource.find({
        courseId: req.params.courseId,
        ownerId: req.user._id,
      }).lean();

      if (oldResources.length > 0) {
        const ops: mongoose.AnyBulkWriteOperation<IResource>[] =
          oldResources.map((r) => ({
            insertOne: {
              document: {
                _id: new Types.ObjectId(),
                ownerId: req.user._id,
                courseId: newCourse._id,
                status: r.status,
                name: r.name,
                description: r.description,
                tags: r.tags,
                uri: r.uri,
                state: r.state,
                contentType: r.contentType,
                mediaType: r.mediaType,
                institution: r.institution,
                yearOfCreation: r.yearOfCreation,
                // Preserve the original check status — don't auto-approve on copy.
                checkStatus: r.checkStatus,
              },
            },
          }));

        // Single round-trip — unordered for parallel execution
        await Resource.bulkWrite(ops, { ordered: false });
      }
    }

    res.status(201).json({ courseId: newCourse._id, coursePin });
  } catch (e: any) {
    if (e instanceof ValidationError) {
      res.status(e.statusCode).json({ error: e.message });
      return;
    }
    next(e);
  }
}

// ---------------------------------------------------------------------------
// Resource upload — batch co-author creation
// ---------------------------------------------------------------------------

/**
 * Uploads a resource and creates all co-authors in a single bulkWrite.
 * Before: N sequential `new AuthorAlt().save()` calls.
 * After:  1 bulkWrite call.
 */
export async function uploadResource(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tagsRaw = requireString(req.body.tags, "tags");
    const tags = tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    // Validate authors BEFORE touching the DB — avoids orphaned resources
    const authorNames = req.body.authorName;
    const authorEmails = req.body.authorEmail;
    const names: string[] = authorNames
      ? Array.isArray(authorNames)
        ? authorNames
        : [authorNames]
      : [];
    const emails: string[] = authorEmails
      ? Array.isArray(authorEmails)
        ? authorEmails
        : [authorEmails]
      : [];

    if (names.length !== emails.length) {
      res
        .status(400)
        .json({ error: "Author names and emails must have the same length" });
      return;
    }

    const newResource = await new Resource({
      ownerId: requireString(req.body.ownerId, "ownerId"),
      status: requireString(req.body.status, "status"),
      name: requireString(req.body.resourceName, "resourceName"),
      description: req.body.description || "",
      tags,
      uri: requireString(req.body.uri, "uri"),
      // state, contentType, mediaType, institution, yearOfCreation are optional —
      // validated by the Mongoose schema, not required at the handler level.
      state: req.body.state,
      contentType: req.body.contentType,
      mediaType: req.body.mediaType,
      institution: req.body.institution,
      yearOfCreation: req.body.yearOfCreation,
      checkStatus: "approve",
    }).save();

    // Batch co-author creation — single bulkWrite instead of N saves
    if (names.length > 0) {
      const ops: mongoose.AnyBulkWriteOperation<IAuthorAlt>[] = names.map(
        (name, i) => ({
          insertOne: {
            document: {
              resourceId: newResource._id,
              userName: name,
              userEmail: emails[i],
            },
          },
        }),
      );

      await AuthorAlt.bulkWrite(ops, { ordered: false });
    }

    res.status(201).json({ resourceId: newResource._id });
  } catch (e: any) {
    if (e instanceof ValidationError) {
      res.status(e.statusCode).json({ error: e.message });
      return;
    }
    next(e);
  }
}

// ---------------------------------------------------------------------------
// Course time slots — mixed delete + insert in one bulkWrite
// ---------------------------------------------------------------------------

/**
 * Updates course time slots using a single bulkWrite with mixed operations.
 * Before: `deleteMany()` + N sequential `new CourseTime().save()` calls.
 * After:  1 bulkWrite with 1 deleteMany + N insertOne operations.
 *
 * NOTE: The delete-then-insert is ordered (delete runs first), but if the
 * operation partially fails mid-way (e.g. network drop after delete), the
 * existing slots are lost without inserts landing. Wrap in a session/transaction
 * on a replica set for atomicity if this is unacceptable.
 */
export async function updateCourseTimeSlots(
  courseId: Types.ObjectId,
  days: string | string[],
  startTimes: string | string[],
  endTimes: string | string[],
): Promise<void> {
  // Throw on missing inputs — silent return hides the problem from the caller
  if (!startTimes || !days || !endTimes) {
    throw new Error(
      "updateCourseTimeSlots: days, startTimes, and endTimes are required",
    );
  }

  const dayArr: string[] = Array.isArray(days) ? days : [days];
  const startArr: string[] = Array.isArray(startTimes)
    ? startTimes
    : [startTimes];
  const endArr: string[] = Array.isArray(endTimes) ? endTimes : [endTimes];

  if (dayArr.length !== startArr.length || startArr.length !== endArr.length) {
    throw new Error("days, startTimes, and endTimes must have the same length");
  }

  // Mixed operation types in a single bulkWrite:
  // 1. Delete all existing time slots for this course
  // 2. Insert all new time slots
  const ops: mongoose.AnyBulkWriteOperation<ICourseTime>[] = [
    { deleteMany: { filter: { courseId } } },
    ...startArr.map((_, i) => ({
      insertOne: {
        document: {
          courseId,
          day: dayArr[i],
          startTime: startArr[i],
          endTime: endArr[i],
        },
      },
    })),
  ];

  // ordered: true — delete must happen before inserts
  await CourseTime.bulkWrite(ops, { ordered: true });
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Generates a unique 7-digit course pin with a bounded retry limit.
 * Throws if a unique pin can't be found within maxAttempts — prevents
 * infinite loops if the pin space is dense or the DB is slow.
 *
 * NOTE: There is a theoretical race condition — two concurrent requests can
 * generate the same pin, both find it absent, then both insert. A unique index
 * on coursePin in the MongoDB schema turns this into a retryable duplicate key
 * error rather than a silent duplicate. That's a schema concern, not a code fix.
 */
async function getCoursePin(maxAttempts = 10): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const pin = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
    const exists = await Course.findOne({ coursePin: pin }, "coursePin").lean();
    if (!exists) return pin;
  }
  throw new Error("Failed to generate a unique course pin after max attempts");
}
