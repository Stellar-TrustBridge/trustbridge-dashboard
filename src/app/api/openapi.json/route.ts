import { generateOpenAPISpec, validateOpenAPISpec } from "@/lib/openapi-spec";
import { publicOptionsResponse, withPublicCors } from "@/lib/public-cors";

/**
 * Representative error response examples for maintainer mutation routes.
 *
 * Shapes mirror the error envelope produced by `src/lib/error-handling.ts`
 * (`{ error, code, status }`) so integrators can build clients against the
 * real Wave error contract instead of guessing.
 */
const MUTATION_ERROR_EXAMPLES = {
  Unauthorized: {
    summary: "Missing or invalid session (401)",
    value: {
      error: "Authentication required",
      code: "UNAUTHENTICATED",
      status: 401,
    },
  },
  Forbidden: {
    summary: "Org-scope or CSRF rejection (403)",
    value: {
      error: "You do not have permission to perform this action",
      code: "FORBIDDEN",
      status: 403,
    },
  },
  UnprocessableEntity: {
    summary: "Validation failure (422)",
    value: {
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      status: 422,
    },
  },
} as const;

const MUTATION_ERROR_STATUSES = ["401", "403", "422"] as const;

/**
 * Attach representative 401/403/422 examples to every mutation operation
 * (POST/PUT/PATCH/DELETE) in the generated spec. Deterministic: iterates
 * paths in insertion order and only adds examples when a response exists.
 */
function addMutationErrorExamples(spec: Record<string, unknown>): void {
  const paths = spec.paths as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!paths) return;

  const mutationMethods = ["post", "put", "patch", "delete"];

  for (const pathItem of Object.values(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const method of mutationMethods) {
      const operation = pathItem[method] as
        | { responses?: Record<string, Record<string, unknown>> }
        | undefined;
      if (!operation?.responses) continue;

      for (const status of MUTATION_ERROR_STATUSES) {
        const response = operation.responses[status];
        if (!response) continue;

        const content = (response.content ??= {}) as Record<
          string,
          Record<string, unknown>
        >;
        const media = (content["application/json"] ??= {}) as Record<
          string,
          unknown
        >;
        const examples = (media.examples ??= {}) as Record<string, unknown>;

        const exampleKey =
          status === "401"
            ? "Unauthorized"
            : status === "403"
              ? "Forbidden"
              : "UnprocessableEntity";

        if (!examples[exampleKey]) {
          examples[exampleKey] = MUTATION_ERROR_EXAMPLES[exampleKey];
        }
      }
    }
  }
}

/**
 * GET /api/openapi.json
 *
 * Returns the OpenAPI 3.0.0 specification for the TrustBridge Dashboard API.
 * Can be used with Swagger UI or other API documentation tools.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  const spec = generateOpenAPISpec(baseUrl);
  addMutationErrorExamples(spec as unknown as Record<string, unknown>);
  const validation = validateOpenAPISpec(spec);

  if (!validation.valid) {
    return withPublicCors(Response.json(
      {
        error: "OpenAPI spec generation failed",
        details: validation.errors,
      },
      { status: 500 }
    ));
  }

  return withPublicCors(Response.json(spec, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  }));
}

export function OPTIONS() {
  return publicOptionsResponse("GET, OPTIONS");
}
