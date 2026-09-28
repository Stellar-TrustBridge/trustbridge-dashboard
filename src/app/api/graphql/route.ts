import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  graphql,
  parse,
  validate,
  valueFromAST,
  NoSchemaIntrospectionCustomRule,
  type DefinitionNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
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
      },
      resolve: async (_source, _args, context: { isMaintainer: boolean }) => {
        if (!context.isMaintainer) {
          throw new GraphQLError("Forbidden", {
            extensions: { code: "FORBIDDEN" },
          });
        }
        return getContributorsPaginated(_args.after, _args.first);
      },
    },
  },
});

const schema = new GraphQLSchema({ query: queryType });

function analyzeDocument(
  definitions: readonly DefinitionNode[],
  variables: Record<string, unknown>
): string | null {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of definitions) {
    if (definition.kind === "FragmentDefinition") {
      fragments.set(definition.name.value, definition);
    }
  }

  let fieldCount = 0;
  let cost = 0;
  let tooDeep = false;
  let badPageSize = false;

  function inspect(
    selectionSet: SelectionSetNode,
    depth: number,
    multiplier: number,
    fragmentPath: Set<string>
  ) {
    for (const selection of selectionSet.selections) {
      if (selection.kind === "Field") {
        const nextDepth = depth + 1;
        fieldCount += 1;
        if (nextDepth > MAX_QUERY_DEPTH) tooDeep = true;

        let childMultiplier = multiplier;
        if (selection.name.value === "contributors") {
          const firstArgument = selection.arguments?.find(
            (argument) => argument.name.value === "first"
          );
          const requested = firstArgument
            ? valueFromAST(firstArgument.value, GraphQLInt, variables)
            : DEFAULT_CONTRIBUTORS;
          const first = requested == null ? DEFAULT_CONTRIBUTORS : requested;
          if (first < 1 || first > MAX_CONTRIBUTORS) badPageSize = true;
          childMultiplier *= Math.min(Math.max(first, 1), MAX_CONTRIBUTORS);
        }

        cost += multiplier;
        if (selection.selectionSet) {
          inspect(selection.selectionSet, nextDepth, childMultiplier, fragmentPath);
        }
      } else if (selection.kind === "InlineFragment") {
        inspect(selection.selectionSet, depth, multiplier, fragmentPath);
      } else if (!fragmentPath.has(selection.name.value)) {
        const fragment = fragments.get(selection.name.value);
        if (fragment) {
          const nextPath = new Set(fragmentPath);
          nextPath.add(selection.name.value);
          inspect(fragment.selectionSet, depth, multiplier, nextPath);
        }
      }
    }
  }

  for (const definition of definitions) {
    if (definition.kind === "OperationDefinition") {
      if (definition.operation !== "query") {
        return "Only read-only query operations are supported";
      }
      inspect(definition.selectionSet, 0, 1, new Set());
    }
  }

  if (tooDeep) return `Query depth exceeds the limit of ${MAX_QUERY_DEPTH}`;
  if (badPageSize) {
    return `contributors.first must be between 1 and ${MAX_CONTRIBUTORS}`;
  }
  if (fieldCount > MAX_QUERY_FIELDS) {
    return `Query field count exceeds the limit of ${MAX_QUERY_FIELDS}`;
  }
  if (cost > MAX_QUERY_COST) {
    return `Query cost exceeds the limit of ${MAX_QUERY_COST}`;
  }
  return null;
}

export async function POST(request: NextRequest) {
  const clientIp = extractClientIp(request);
  const rateLimit = checkRateLimit(clientIp, {
    maxRequests: MAX_REQUESTS_PER_MINUTE,
  });
  const rateLimitHeaders = buildRateLimitHeaders(
    rateLimit,
    MAX_REQUESTS_PER_MINUTE
  );
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { errors: [{ message: "Rate limit exceeded" }] },
      { status: 429, headers: rateLimitHeaders }
    );
  }

  const bodyText = await request.text();
  if (Buffer.byteLength(bodyText, "utf8") > MAX_QUERY_BYTES) {
    return NextResponse.json({ errors: [{ message: "Query body is too large" }] }, { status: 413 });
  }

  let body: { query?: unknown; variables?: unknown };
  try {
    body = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ errors: [{ message: "Invalid JSON body" }] }, { status: 400 });
  }

  if (typeof body.query !== "string") {
    return NextResponse.json({ errors: [{ message: "A query string is required" }] }, { status: 400 });
  }

  const variables =
    body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
      ? (body.variables as Record<string, unknown>)
      : {};

  let document;
  try {
    document = parse(body.query);
  } catch (error) {
    return NextResponse.json(
      { errors: [{ message: error instanceof Error ? error.message : "Invalid GraphQL query" }] },
      { status: 400 }
    );
  }

  const limitError = analyzeDocument(document.definitions, variables);
  if (limitError) {
    return NextResponse.json({ errors: [{ message: limitError }] }, { status: 400 });
  }

  const validationRules =
    process.env.NODE_ENV === "production"
      ? [NoSchemaIntrospectionCustomRule]
      : undefined;
  const validationErrors = validate(schema, document, validationRules);
  if (validationErrors.length > 0) {
    return NextResponse.json(
      { errors: validationErrors.map((error) => ({ message: error.message })) },
      { status: 400 }
    );
  }

  const session = await requireMaintainerSession();
  const result = await graphql({
    schema,
    source: body.query,
    variableValues: variables,
    contextValue: { isMaintainer: Boolean(session) },
  });

  return NextResponse.json(result);
}