"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useState } from "react";
import { Copy, KeyRound, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { VALID_SCOPES, type ApiKeyScope } from "@/app/api/settings/api-keys/route";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
}

interface CreateResponse {
  apiKey: ApiKeyRow;
  rawKey: string;
}

interface ListResponse {
  keys: ApiKeyRow[];
}

// ---------------------------------------------------------------------------
// ApiKeyPanel
// ---------------------------------------------------------------------------

export function ApiKeyPanel() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();

  // Form state
  const [keyName, setKeyName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<Set<ApiKeyScope>>(
    new Set()
  );

  // One-time secret state — cleared when the user dismisses.
  const [revealedSecret, setRevealedSecret] = useState<{
    keyName: string;
    rawKey: string;
  } | null>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const isMaintainer = session?.user?.isMaintainer === true;

  // -------------------------------------------------------------------------
  // Queries / mutations
  // -------------------------------------------------------------------------

  const listQuery = useQuery<ListResponse>({
    queryKey: ["api-keys"],
    queryFn: async () => {
      const res = await fetch("/api/settings/api-keys");
      if (!res.ok) throw new Error("Failed to load API keys");
      return res.json() as Promise<ListResponse>;
    },
    enabled: isMaintainer,
  });

  const createMutation = useMutation<CreateResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: keyName.trim(), scopes: [...selectedScopes] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Create failed");
      return data as CreateResponse;
    },
    onSuccess: (data) => {
      setRevealedSecret({ keyName: data.apiKey.name, rawKey: data.rawKey });
      setKeyName("");
      setSelectedScopes(new Set());
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const revokeMutation = useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/settings/api-keys/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Revoke failed");
    },
    onSuccess: () => {
      setRevokeError(null);
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (err) => {
      setRevokeError(err.message);
    },
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function toggleScope(scope: ApiKeyScope) {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      next.has(scope) ? next.delete(scope) : next.add(scope);
      return next;
    });
  }

  async function copyToClipboard(text: string, id: string) {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!isMaintainer) {
    return (
      <Card data-testid="api-key-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            API Keys
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p
            className="text-sm text-muted-foreground"
            data-testid="maintainer-only-message"
          >
            API key management is available to maintainers only.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="api-key-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          API Keys
        </CardTitle>
        <CardDescription>
          Manage maintainer API keys for treasury export automation.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ---- One-time secret banner ---- */}
        {revealedSecret && (
          <div
            className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 space-y-2"
            data-testid="raw-key-banner"
          >
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
              Copy your new API key now — it will not be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 truncate rounded bg-black/10 px-2 py-1 text-xs font-mono dark:bg-white/10"
                data-testid="raw-key-value"
              >
                {revealedSecret.rawKey}
              </code>
              <Button
                size="sm"
                variant="outline"
                data-testid="copy-raw-key-button"
                onClick={() =>
                  copyToClipboard(revealedSecret.rawKey, "raw")
                }
              >
                <Copy className="h-4 w-4" />
                {copiedId === "raw" ? "Copied!" : "Copy"}
              </Button>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs"
              data-testid="dismiss-raw-key-button"
              onClick={() => setRevealedSecret(null)}
            >
              I&apos;ve saved it — dismiss
            </Button>
          </div>
        )}

        {/* ---- Create form ---- */}
        <div className="space-y-3" data-testid="create-api-key-form">
          <h3 className="text-sm font-semibold">Create new API key</h3>

          <div className="flex flex-col gap-1">
            <label htmlFor="api-key-name" className="text-xs text-muted-foreground">
              Key name <span aria-hidden="true">*</span>
            </label>
            <input
              id="api-key-name"
              data-testid="api-key-name-input"
              type="text"
              placeholder="e.g. Treasury Export Bot"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              className="rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Scope checkboxes */}
          <div className="space-y-1" data-testid="scope-checkboxes">
            <p className="text-xs text-muted-foreground">Scopes</p>
            {VALID_SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid={`scope-checkbox-${scope}`}
                  checked={selectedScopes.has(scope)}
                  onChange={() => toggleScope(scope)}
                  className="accent-stellar-cyan"
                />
                {scope}
              </label>
            ))}
          </div>

          {createMutation.isError && (
            <p className="text-sm text-destructive" data-testid="create-error">
              {createMutation.error.message}
            </p>
          )}

          <Button
            variant="stellar"
            size="sm"
            data-testid="create-api-key-button"
            disabled={!keyName.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Creating…
              </>
            ) : (
              "Create API key"
            )}
          </Button>
        </div>

        {/* ---- Key list ---- */}
        <div data-testid="api-key-list">
          <h3 className="mb-2 text-sm font-semibold">Existing keys</h3>

          {listQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}

          {revokeError && (
            <p className="mb-2 text-sm text-destructive" data-testid="revoke-error">
              {revokeError}
            </p>
          )}

          {listQuery.data?.keys.length === 0 && (
            <p className="text-sm text-muted-foreground">No API keys yet.</p>
          )}

          <ul className="space-y-2">
            {listQuery.data?.keys.map((key) => (
              <li
                key={key.id}
                data-testid={`api-key-row-${key.id}`}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{key.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {key.scopes.join(", ") || "no scopes"}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {key.revokedAt ? (
                    <span
                      className="rounded-full bg-destructive/20 px-2 py-0.5 text-xs text-destructive"
                      data-testid={`revoked-badge-${key.id}`}
                    >
                      Revoked
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`revoke-button-${key.id}`}
                      disabled={revokeMutation.isPending}
                      onClick={() => revokeMutation.mutate(key.id)}
                      aria-label={`Revoke ${key.name}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
