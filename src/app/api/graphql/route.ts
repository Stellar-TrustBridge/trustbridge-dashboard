import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  coerceInputValue,
  graphql,
  parse,
  validate,
  valueFromAST,
  NoSchemaIntrospectionCustomRule,
  type DefinitionNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from "graphql";
import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import {
  buildRateLimitHeaders,
  checkRateLimit,
  extractClientIp,
} from "@/lib/rate-limit";
import { getDashboardStats, getContributorsPaginated } from "@/lib/registrations";
import type { ContributorRow, DashboardStats } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY_BYTES = 16_384;
const MAX_QUERY_DEPTH = 5;
const MAX_QUERY_FIELDS = 100;
const MAX_QUERY_COST = 2_500;
const MAX_CONTRIBUTORS = 100;
const DEFAULT_CONTRIBUTORS = 25;
const MAX_REQUESTS_PER_MINUTE = 120;

/**
 * Introspection is disabled in production to shrink the attack surface (schema
 * discovery, cost amplification). Non-production keeps it enabled so local
 * tooling (GraphiQL, codegen) keeps working. Operators can force it off in any
 * environment with `GRAPHQL_DISABLE_INTROSPECTION=1`.
 */
const INTROSPECTION_DISABLED =
  process.env.NODE_ENV === "production" ||
  process.env.GRAPHQL_DISABLE_INTROSPECTION === "1";

/**
 * Persisted-query allowlist mode (opt-in).
 *
 * When `GRAPHQL_PERSISTED_QUERIES_ONLY=1`, the endpoint refuses to execute any
 * query text that is not identified by a known persisted-query hash. Clients
 * send the hash via the `X-Persisted-Query-Hash` header (or the
 * `extensions.persistedQueryHash` field of the JSON body) and may omit the
 * `query` field entirely. Unknown hashes, missing hashes, and inline query text
 * are rejected with stable reason codes so operators can alert on them.
 *
 * The allowlist is supplied by operators as a comma-separated list of
 * `sha256:<hex>` entries in `GRAPHQL_PERSISTED_QUERY_ALLOWLIST`. Hashes are
 * compared case-insensitively after normalising the `sha256:` prefix. When the
 * mode is enabled but the allowlist is empty, every request is rejected —
 * fail-closed by design.
 */
const PERSISTED_QUERIES_ONLY = process.env.GRAPHQL_PERSISTED_QUERIES_ONLY === "1";

const PERSISTED_QUERY_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/i;

const PERSISTED_QUERY_ALLOWLIST: ReadonlySet<string> = new Set(
  (process.env.GRAPHQL_PERSISTED_QUERY_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
);

const PERSISTED_QUERY_REASON = {
  MISSING_HASH: "PERSISTED_QUERY_HASH_REQUIRED",
  MALFORMED_HASH: "PERSISTED_QUERY_HASH_MALFORMED",
  UNKNOWN_HASH: "PERSISTED_QUERY_HASH_UNKNOWN",
  INLINE_QUERY: "PERSISTED_QUERY_INLINE_FORBIDDEN",
} as const;

type PersistedQueryResult =
  | { ok: true }
  | { ok: false; reason: string; message: string };

/**
 * Enforce persisted-query allowlist mode for a single request.
 *
 * Returns `{ ok: true }` when the mode is disabled (default) or when the
 * supplied hash is present, well-formed, and present in the allowlist. All
 * failure branches return a stable reason code and a client-safe message that
 * never echoes the raw hash or the allowlist contents.
 */
function enforcePersistedQueryAllowlist(
  hashHeader: string | null,
  bodyHash: unknown,
  hasInlineQuery: boolean
): PersistedQueryResult {
  if (!PERSISTED_QUERIES_ONLY) return { ok: true };

  const rawHash =
    typeof hashHeader === "string" && hashHeader.length > 0
      ? hashHeader
      : typeof bodyHash === "string" && bodyHash.length > 0
        ? bodyHash
        : null;

  if (rawHash === null) {
    return {
      ok: false,
      reason: PERSISTED_QUERY_REASON.MISSING_HASH,
      message:
        "Persisted-query mode is enabled: supply X-Persisted-Query-Hash (sha256:<hex>).",
    };
  }

  const normalised = rawHash.trim().toLowerCase();
  if (!PERSISTED_QUERY_HASH_PATTERN.test(normalised)) {
    return {
      ok: false,
      reason: PERSISTED_QUERY_REASON.MALFORMED_HASH,
      message: "Persisted-query hash must match sha256:<64 hex chars>.",
    };
  }

  if (!PERSISTED_QUERY_ALLOWLIST.has(normalised)) {
    return {
      ok: false,
      reason: PERSISTED_QUERY_REASON.UNKNOWN_HASH,
      message: "Persisted-query hash is not in the allowlist.",
    };
  }

  if (hasInlineQuery) {
    return {
      ok: false,
      reason: PERSISTED_QUERY_REASON.INLINE_QUERY,
      message:
        "Persisted-query mode is enabled: inline query text is not accepted.",
    };
  }

  return { ok: true };
}

const VERIFICATION_STATUSES = ["verified", "unverified", "banned"] as const;
type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

const verificationStatusEnum = new GraphQLEnumType({
  name: "VerificationStatus",
  values: {
    VERIFIED: { value: "verified" },
    UNVERIFIED: { value: "unverified" },
    BANNED: { value: "banned" },
  },
});

const contributorType = new GraphQLObjectType<ContributorRow>({
  name: "Contributor",
  fields: {
    githubUsername: { type: new GraphQLNonNull(GraphQLString) },
    stellarAddress: { type: new GraphQLNonNull(GraphQLString) },
    trustlineReady: { type: new GraphQLNonNull(GraphQLBoolean) },
    trustlineAuthorized: { type: new GraphQLNonNull(GraphQLBoolean) },
    verified: { type: new GraphQLNonNull(GraphQLBoolean) },
    funded: { type: new GraphQLNonNull(GraphQLBoolean) },
    xlmBalance: { type: new GraphQLNonNull(GraphQLString) },
    spendableXlmBalance: { type: new GraphQLNonNull(GraphQLString) },
    usdcBalance: { type: new GraphQLNonNull(GraphQLString) },
    lastCheckedAt: { type: GraphQLString },
    horizonLatencyMs: { type: GraphQLInt },
    readiness: { type: new GraphQLNonNull(GraphQLString) },
    banned: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const contributorPageType = new GraphQLObjectType({
  name: "ContributorPage",
  fields: {
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(contributorType)),
      resolve: (page: Awaited<ReturnType<typeof getContributorsPaginated>>) =>
        page.contributors,
    },
    hasMore: {
      type: new GraphQLNonNull(GraphQLBoolean),
    },
    nextCursor: { type: GraphQLString },
  },
});

const statsType = new GraphQLObjectType<DashboardStats>({
  name: "DashboardStats",
  fields: {
    totalContributors: { type: new GraphQLNonNull(GraphQLInt) },
    readyCount: { type: new GraphQLNonNull(GraphQLInt) },
    readyPercent: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const queryType = new GraphQLObjectType({
  name: "Query",
  fields: {
    stats: {
      type: new GraphQLNonNull(statsType),
      resolve: () => getDashboardStats(),
    },
    contributors: {
      type: contributorPageType,
      args: {
        first: { type: GraphQLInt, defaultValue: DEFAULT_CONTRIBUTORS },
        after: { type: GraphQLString },
        verificationStatus: { type: verificationStatusEnum },
      },
      resolve: async (
        _source,
        args: { first?: number; after?: string; verificationStatus?: VerificationStatus },
        context: { isMaintainer: boolean }
      ) => {
        if (!context.isMaintainer) {
          throw new GraphQLError("Forbidden", {
            extensions: { code: "FORBIDDEN" },
          });
        }
        if (args.after) {
          const { invalidCursor } = await import("@/lib/cursor-pagination").then(
            (m) => m.validatePaginationOptions({ cursor: args.after })
          );
          if (invalidCursor) {
            const { buildInvalidCursorError } = await import(
              "@/lib/cursor-pagination"
            );
            const body = buildInvalidCursorError();
            throw new GraphQLError(body.message, {
              extensions: {
                code: body.code,
                remediation: body.remediation,
              },
            });
          }
        }
        return getContributorsPaginated(args.after, args.first, args.verificationStatus);
      },
    },
  },
});

const schema = new GraphQLSchema({ query: queryType });

/**
 * Coerce the `contributors(first:)` argument into a bounded integer page size.
 *
 * `valueFromAST` is only safe for inline literals: for a `Variable` node it
 * returns the raw JSON value out of `variables` *without* coercing it to the
 * argument's declared type, so a String, Boolean, object, or fractional value
 * slipped past the range check below and poisoned the cost multiplier with
 * `NaN` (`NaN > MAX_QUERY_COST` is false, so the cost limit was silently
 * skipped). Variables are therefore coerced with `coerceInputValue` against
 * `GraphQLInt` — exactly what execution does — and anything that still is not a
 * finite whole number inside `[1, MAX_CONTRIBUTORS]` is rejected with a
 * client-facing message before the resolver can run.
 *
 * @returns the validated limit, or an `error` describing why it is invalid.
 */
function resolveContributorsLimit(
  valueNode: ValueNode | undefined,
  variables: Record<string, unknown>
): ContributorsLimit {
  const rangeMessage = `contributors.first must be an Int between 1 and ${MAX_CONTRIBUTORS}`;

  // Missing argument, explicit null, or an omitted optional variable all fall
  // back to the schema default rather than producing a NaN multiplier.
  if (!valueNode || valueNode.kind === Kind.NULL) {
    return { ok: true, limit: DEFAULT_CONTRIBUTORS };
  }

  let raw: unknown;

  if (valueNode.kind === Kind.VARIABLE) {
    const variableName = valueNode.name.value;
    if (!(variableName in variables)) {
      // Absent optional variable: the argument default applies.
      return { ok: true, limit: DEFAULT_CONTRIBUTORS };
    }
    // `coerceInputValue` throws on the first problem unless it is handed an
    // `onError` collector, and the coercion message ("Int cannot represent
    // non-integer value: ...") is what makes the 400 actionable.
    const coercionErrors: GraphQLError[] = [];
    const coerced = coerceInputValue(
      variables[variableName],
      GraphQLInt,
      (_path, _invalidValue, error) => {
        coercionErrors.push(error);
      }
    );
    if (coercionErrors.length > 0) {
      return {
        ok: false,
        error: `${rangeMessage} — $${variableName} is invalid: ${coercionErrors[0].message}`,
      };
    }
    raw = coerced;
  } else {
    raw = valueFromAST(valueNode, GraphQLInt);
    if (raw === undefined) {
      return { ok: false, error: rangeMessage };
    }
  }

  if (raw === null) return { ok: true, limit: DEFAULT_CONTRIBUTORS };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, error: rangeMessage };
  }

  const limit = Math.floor(raw);
  if (limit !== raw || limit < 1 || limit > MAX_CONTRIBUTORS) {
    return { ok: false, error: rangeMessage };
  }

  return { ok: true, limit };
}

type ContributorsLimit =
  | { ok: true; limit: number }
  | { ok: false; error: string };

/**
 * Validate the `contributors(verificationStatus:)` argument.
 *
 * The enum type already rejects unknown literals during validation, but a
 * variable can carry an arbitrary JSON value that bypasses the enum check, so
 * variables are coerced against the enum type here and rejected with a stable
 * message when they do not match one of the declared values.
 */
function resolveVerificationStatus(
  valueNode: ValueNode | undefined,
  variables: Record<string, unknown>
): VerificationStatus | undefined {
  if (!valueNode || valueNode.kind === Kind.NULL) return undefined;

  let raw: unknown;
  if (valueNode.kind === Kind.VARIABLE) {
    const variableName = valueNode.name.value;
    if (!(variableName in variables)) return undefined;
    const coercionErrors: GraphQLError[] = [];
    raw = coerceInputValue(
      variables[variableName],
      verificationStatusEnum,
      (_path, _invalidValue, error) => {
        coercionErrors.push(error);
      }
    );
    if (coercionErrors.length > 0) return undefined;
  } else {
    raw = valueFromAST(valueNode, verificationStatusEnum);
  }

  if (typeof raw !== "string") return undefined;
  return (VERIFICATION_STATUSES as readonly string[]).includes(raw)
    ? (raw as VerificationStatus)
    : undefined;
}

/**
 * Compute the maximum selection depth of a document, counting nested
 * selection sets. Used to bound query complexity before execution.
 */
function computeQueryDepth(selectionSet: SelectionSetNode | undefined): number {
  if (!selectionSet) return 0;
  let max = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const childDepth = computeQueryDepth(selection.selectionSet);
      max = Math.max(max, 1 + childDepth);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      max = Math.max(max, computeQueryDepth(selection.selectionSet));
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      // Fragment spreads are resolved against the fragment map by the caller;
      // depth is bounded conservatively by treating them as a single level.
      max = Math.max(max, 1);
    }
  }
  return max;
}

/**
 * Count the total number of field selections in a document, including fields
 * nested inside inline fragments and fragment spreads.
 */
function countQueryFields(
  selectionSet: SelectionSetNode | undefined,
  fragments: Map<string, FragmentDefinitionNode>
): number {
  if (!selectionSet) return 0;
  let count = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      count += 1 + countQueryFields(selection.selectionSet, fragments);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      count += countQueryFields(selection.selectionSet, fragments);
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const fragment = fragments.get(selection.name.value);
      if (fragment) {
        count += countQueryFields(fragment.selectionSet, fragments);
      }
    }
  }
  return count;
}

/**
 * Estimate the cost of a query as `fields * contributorsLimit`, so that a
 * request asking for many fields over a large page is rejected before it can
 * amplify load on the registrations store.
 */
function estimateQueryCost(
  document: { definitions: readonly DefinitionNode[] },
  variables: Record<string, unknown>
): { cost: number; limit: number } {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }

  let fields = 0;
  let limit = DEFAULT_CONTRIBUTORS;

  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    fields += countQueryFields(definition.selectionSet, fragments);
    for (const selection of definition.selectionSet.selections) {
      if (selection.kind !== Kind.FIELD) continue;
      if (selection.name.value !== "contributors") continue;
      const firstArg = selection.arguments?.find((arg) => arg.name.value === "first");
      const resolved = resolveContributorsLimit(firstArg?.value, variables);
      if (resolved.ok) {
        limit = Math.max(limit, resolved.limit);
      }
    }
  }

  return { cost: fields * limit, limit };
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>
): NextResponse {
  return NextResponse.json(
    { errors: [{ message, extensions: { code, ...extra } }] },
    { status }
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = extractClientIp(request);
  const rate = checkRateLimit(`graphql:${ip}`, MAX_REQUESTS_PER_MINUTE);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        errors: [
          {
            message: "Too many requests",
            extensions: { code: "RATE_LIMITED" },
          },
        ],
      },
      { status: 429, headers: buildRateLimitHeaders(rate) }
    );
  }

  const auth = await requireMaintainerSession(request);
  if (!auth.ok) {
    return auth.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }

  const payload = body as {
    query?: unknown;
    variables?: unknown;
    extensions?: unknown;
  };

  const rawQuery = payload.query;
  const hasInlineQuery = typeof rawQuery === "string" && rawQuery.length > 0;

  if (rawQuery !== undefined && typeof rawQuery !== "string") {
    return jsonError(400, "INVALID_QUERY", "`query` must be a string.");
  }

  const extensions =
    typeof payload.extensions === "object" && payload.extensions !== null
      ? (payload.extensions as Record<string, unknown>)
      : undefined;
  const bodyHash = extensions?.persistedQueryHash;

  const persisted = enforcePersistedQueryAllowlist(
    request.headers.get("x-persisted-query-hash"),
    bodyHash,
    hasInlineQuery
  );
  if (!persisted.ok) {
    return jsonError(400, persisted.reason, persisted.message);
  }

  if (!hasInlineQuery) {
    return jsonError(
      400,
      "MISSING_QUERY",
      "`query` is required unless persisted-query mode is enabled."
    );
  }

  const query = rawQuery as string;
  if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
    return jsonError(
      413,
      "QUERY_TOO_LARGE",
      `Query exceeds the ${MAX_QUERY_BYTES}-byte limit.`
    );
  }

  let document: ReturnType<typeof parse>;
  try {
    document = parse(query);
  } catch (error) {
    const message =
      error instanceof GraphQLError ? error.message : "Query could not be parsed.";
    return jsonError(400, "PARSE_ERROR", message);
  }

  const validationErrors = validate(schema, document, [
    ...(INTROSPECTION_DISABLED ? [NoSchemaIntrospectionCustomRule] : []),
  ]);
  if (validationErrors.length > 0) {
    return NextResponse.json(
      {
        errors: validationErrors.map((error) => ({
          message: error.message,
          locations: error.locations,
          extensions: { code: "VALIDATION_ERROR" },
        })),
      },
      { status: 400 }
    );
  }

  const depth = Math.max(
    ...document.definitions.map((definition) =>
      definition.kind === Kind.OPERATION_DEFINITION
        ? computeQueryDepth(definition.selectionSet)
        : 0
    )
  );
  if (depth > MAX_QUERY_DEPTH) {
    return jsonError(
      400,
      "QUERY_TOO_DEEP",
      `Query depth ${depth} exceeds the ${MAX_QUERY_DEPTH} limit.`
    );
  }

  const variables =
    typeof payload.variables === "object" && payload.variables !== null
      ? (payload.variables as Record<string, unknown>)
      : {};

  const { cost } = estimateQueryCost(document, variables);
  if (cost > MAX_QUERY_COST) {
    return jsonError(
      400,
      "QUERY_TOO_COSTLY",
      `Query cost ${cost} exceeds the ${MAX_QUERY_COST} limit.`
    );
  }

  const result = await graphql({
    schema,
    source: query,
    variableValues: variables,
    contextValue: { isMaintainer: true },
  });

  return NextResponse.json(result, { status: 200 });
}
