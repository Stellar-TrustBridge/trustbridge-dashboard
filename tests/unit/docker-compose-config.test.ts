import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

const compose = read("docker-compose.yml");
const dockerfile = read("Dockerfile");
const dockerignore = read(".dockerignore");
const seed = read("docker/postgres/seed.sql");
const mockCompose = read("mock/horizon/docker-compose.yml");
const docs = read("docs/DOCKER_COMPOSE.md");
const setup = read("docs/SETUP.md");
const docsIndex = read("docs/README.md");

describe("docker-compose local Wave stack", () => {
  it("defines web, horizon-mock, postgres and adminer services with expected ports", () => {
    for (const service of ["web:", "horizon-mock:", "postgres:", "postgres-admin:"]) {
      expect(compose).toContain(service);
    }
    expect(compose).toContain('"3000:3000"');
    expect(compose).toContain('"8089:8080"');
    expect(compose).toContain('"5432:5432"');
    expect(compose).toContain('"8080:8080"');
  });

  it("wires web to postgres and mock Horizon with healthcheck dependencies", () => {
    expect(compose).toContain("build:");
    expect(compose).toContain("dockerfile: Dockerfile");
    expect(compose).toContain("@postgres:5432/trustbridge_dashboard");
    expect(compose).toContain("NEXT_PUBLIC_HORIZON_URL: http://localhost:8089");
    expect(compose).toContain("condition: service_healthy");
    expect(compose).toContain("mock/horizon/mappings:/home/wiremock/mappings:ro");
    expect(compose).toMatch(/wiremock\/wiremock/);
    expect(mockCompose).toContain('"8089:8080"');
  });

  it("builds the Next.js app in a Node 20 image with Prisma generation", () => {
    expect(dockerfile).toContain("FROM node:20-alpine AS deps");
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("npx prisma generate");
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain('CMD ["npm", "start"]');
    expect(dockerfile).toContain("ARG NEXT_PUBLIC_HORIZON_URL");
    expect(dockerignore).toContain("node_modules");
    expect(dockerignore).toContain(".next");
  });

  it("mounts deterministic seed SQL and inserts valid Prisma fixtures", () => {
    expect(compose).toContain(
      "./docker/postgres/seed.sql:/docker-entrypoint-initdb.d/20-seed.sql:ro"
    );
    expect(compose).toContain(
      "./docker/postgres/init-roles.sql:/docker-entrypoint-initdb.d/10-init-roles.sql:ro"
    );
    expect(seed).toContain('INSERT INTO "User"');
    expect(seed).toContain('INSERT INTO "Registration"');
    expect(seed).toContain("ON CONFLICT DO NOTHING");
    expect(seed).toContain("seed-user-alice");
    expect(seed).toContain("seed-reg-alice");
    expect(seed).toContain("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
    expect(seed).toContain("GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
    expect(seed).toContain("'default'");
  });

  it("documents a copy-paste quickstart with migration, seed and mock env", () => {
    expect(docs).toContain("docker compose up -d --build");
    expect(docs).toContain("npx prisma migrate deploy");
    expect(docs).toContain(
      "docker compose exec -T postgres psql -U trustbridge -d trustbridge_dashboard < docker/postgres/seed.sql"
    );
    expect(docs).toContain("NEXT_PUBLIC_HORIZON_URL=http://localhost:8089");
    expect(docs).toContain("http://localhost:3000");
    expect(docs).toContain("http://localhost:8080");
    expect(docs).toContain("http://localhost:8089");
    expect(setup).toContain("docker compose up -d --build");
    expect(setup).toContain("trustbridge_dashboard");
    expect(docsIndex).toContain("mock Horizon");
  });

  it("covers all required troubleshooting sections", () => {
    for (const heading of [
      "Port 5432 already in use",
      "Port 3000 already in use",
      "Port 8089 already in use",
      "Stale volumes",
      ".env.local",
      "init-roles.sql",
      "Seed skipped",
    ]) {
      expect(docs).toContain(heading);
    }
    expect(docs).toContain("docker compose down -v");
  });

  it("fails when the web service points at localhost instead of the compose network", () => {
    const webSection = compose.slice(compose.indexOf("  web:"));
    expect(webSection).not.toMatch(/DATABASE_URL:.*@localhost:5432/);
    expect(webSection).toContain("@postgres:5432");
  });

  it("fails when setup docs still advertise conflicting local credentials", () => {
    expect(setup).not.toContain("POSTGRES_PASSWORD=postgres");
    expect(setup).not.toContain("POSTGRES_DB=trustbridge \\");
    expect(setup).toContain("trustbridge-dev-password");
  });

  it("fails when the dangling pool-tuning link is still present", () => {
    for (const file of [docs, setup, docsIndex, read("README.md"), read("docs/ARCHITECTURE.md"), read(".env.example")]) {
      expect(file).not.toContain("PRISMA_POOL_TUNING.md");
    }
  });
});
