import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApiKeyPanel } from "@/components/ApiKeyPanel";

describe("ApiKeyPanel", () => {
    it("shows the scope bit and mask in the API key tooltip", () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(["api-keys"], {
            keys: [
                {
                    id: "key-1",
                    name: "nightly-export",
                    scopes: ["export:read"],
                    createdAt: "2026-10-01T00:00:00.000Z",
                    expiresAt: null,
                    lastUsedAt: null,
                },
            ],
        });

        render(
            <QueryClientProvider client={queryClient}>
                <ApiKeyPanel />
            </QueryClientProvider>
        );

        expect(screen.getByTestId("api-key-scope-export:read")).toHaveAttribute(
            "title",
            "export:read — bit 0 (mask 1): Read contributor export endpoints; does not allow writes."
        );
    });

    it("renders the empty state when no keys are present", () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(["api-keys"], { keys: [] });

        render(
            <QueryClientProvider client={queryClient}>
                <ApiKeyPanel />
            </QueryClientProvider>
        );

        expect(screen.getByTestId("api-keys-empty")).toBeInTheDocument();
    });
});