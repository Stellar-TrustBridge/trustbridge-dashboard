"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  KeyRound,
  Loader2,
  Trash2,
} from "lucide-react";
import { useId, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatRelativeTime } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

interface CreateResponse {
  key: ApiKeyRow & { secret: string };
  warning: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function ScopeChip({ scope }: { scope: string }) {
  return (
    <Badge variant="secondary" className="font-mono text-xs">
      {scope}
    </Badge>
  );
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-xs text-muted-foreground">
      <span className="font-medium">{label}:</span> {value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Secret reveal banner (shown once after creation)
// ---------------------------------------------------------------------------

function SecretBanner({
  secret,
  onDismiss,
}: {
  secret: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Clipboard API unavailable — user can still select + copy manually.
    }
  }

  return (
    <div
      role="alert"
      className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm dark:border-emerald-700 dark:bg-emerald-950/40"
      data-testid="secret-banner"
    >
      <div className="mb-2 flex items-center gap-2 font-semibold text-emerald-800 dark:text-emerald-200">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        API key created — copy it now
      </div>
      <p className="mb-3 text-emerald-700 dark:text-emerald-300">
        This secret will <strong>not</strong> be shown again. Store it in your
        CI/CD secret store (e.g. GitHub Actions secrets) before closing this
        banner.
      </p>
      <div className="flex items-center gap-2">
        <code
          className="flex-1 overflow-x-auto rounded border border-emerald-200 bg-white px-3 py-2 font-mono text-xs text-foreground dark:border-emerald-700 dark:bg-background"
          aria-label="API key secret"
          data-testid="secret-value"
        >
          {secret}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCopy}
          aria-label={copied ? "Copied" : "Copy API key to clipboard"}
          data-testid="copy-secret"
        >
          {copied ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          ) : (
            <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-3 text-xs text-emerald-700 underline underline-offset-2 dark:text-emerald-300"
        data-testid="dismiss-secret"
      >
        I&apos;ve saved it — dismiss
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

function CreateKeyForm({ onCreated }: { onCreated: (secret: string) => void }) {
  const nameId = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scopes: ["export:read"] }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error((payload as { error?: string }).error ?? "Failed to create key");
      }
      return res.json() as Promise<CreateResponse>;
    },
    onSuccess: (data) => {
      setName("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      onCreated(data.key.secret);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setError(null);
    mutation.mutate();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" aria-label="Create API key">
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>Key name</Label>
        <Input
          id={nameId}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. nightly-export-cron"
          maxLength={80}
          disabled={mutation.isPending}
          autoComplete="off"
          data-testid="api-key-name-input"
        />
        <p className="text-xs text-muted-foreground">
          Scope: <code className="font-mono">export:read</code> — read-only access
          to contributor export endpoints.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="text-sm text-destructive"
          data-testid="create-key-error"
        >
          {error}
        </p>
      )}

      <Button
        type="submit"
        disabled={mutation.isPending || !name.trim()}
        data-testid="create-key-submit"
      >
        {mutation.isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Creating…
          </>
        ) : (
          <>
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            Create key
          </>
        )}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Key row
// ---------------------------------------------------------------------------

function KeyRow({ apiKey }: { apiKey: ApiKeyRow }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const revokeButtonRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/settings/api-keys/${apiKey.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error((payload as { error?: string }).error ?? "Failed to revoke key");
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const isExpired = apiKey.expiresAt ? new Date(apiKey.expiresAt) < new Date() : false;

  return (
    <>
      <li
        className="flex flex-wrap items-start justify-between gap-3 py-4 text-sm"
        data-testid={`api-key-row-${apiKey.id}`}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{apiKey.name}</span>
            {isExpired && (
              <Badge variant="destructive" className="text-xs">
                Expired
              </Badge>
            )}
            {apiKey.scopes.map((s) => (
              <ScopeChip key={s} scope={s} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            <StatusLine
              label="Created"
              value={formatRelativeTime(apiKey.createdAt)}
            />
            {apiKey.lastUsedAt ? (
              <StatusLine
                label="Last used"
                value={formatRelativeTime(apiKey.lastUsedAt)}
              />
            ) : (
              <StatusLine label="Last used" value="Never" />
            )}
            {apiKey.expiresAt && (
              <StatusLine
                label={isExpired ? "Expired" : "Expires"}
                value={formatRelativeTime(apiKey.expiresAt)}
              />
            )}
          </div>
        </div>

        <Button
          ref={revokeButtonRef}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={mutation.isPending}
          aria-label={`Revoke API key "${apiKey.name}"`}
          data-testid={`revoke-key-${apiKey.id}`}
        >
          {mutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          )}
          Revoke
        </Button>
      </li>

      <ConfirmDialog
        open={confirmOpen}
        title="Revoke API key?"
        description={
          <>
            The key <strong>&quot;{apiKey.name}&quot;</strong> will stop working
            immediately. Any cron job or script using it will fail until you
            update it with a new key.
          </>
        }
        warning="This action cannot be undone."
        confirmLabel="Revoke key"
        destructive
        pending={mutation.isPending}
        onConfirm={() => {
          mutation.mutate();
          setConfirmOpen(false);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

/**
 * API key management panel for the maintainer settings page.
 *
 * Lets operator+ maintainers create and revoke hashed API keys scoped to
 * `export:read`. The raw secret is shown once after creation inside a
 * highlighted banner with a copy button; after dismissal or page reload it
 * is gone.
 */
export function ApiKeyPanel() {
  const [pendingSecret, setPendingSecret] = useState<string | null>(null);

  const keysQuery = useQuery<{ keys: ApiKeyRow[] }>({
    queryKey: ["api-keys"],
    queryFn: async () => {
      const res = await fetch("/api/settings/api-keys");
      if (!res.ok) throw new Error("Failed to load API keys");
      return res.json() as Promise<{ keys: ApiKeyRow[] }>;
    },
  });

  return (
    <Card data-testid="api-key-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" aria-hidden="true" />
          API keys
        </CardTitle>
        <CardDescription>
          Machine credentials for cron export automation. Keys carry the{" "}
          <code className="font-mono text-xs">export:read</code> scope and
          authenticate against{" "}
          <code className="font-mono text-xs">/api/contributors/export/*</code>{" "}
          without a browser session. Store secrets in your CI/CD secret store —
          they are shown once at creation.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Secret reveal banner — shown immediately after creation */}
        {pendingSecret && (
          <SecretBanner
            secret={pendingSecret}
            onDismiss={() => setPendingSecret(null)}
          />
        )}

        {/* Create form */}
        <CreateKeyForm onCreated={(secret) => setPendingSecret(secret)} />

        {/* Divider */}
        <div className="border-t border-border" aria-hidden="true" />

        {/* Key list */}
        <div>
          <h3 className="mb-3 text-sm font-medium">Active keys</h3>

          {keysQuery.isLoading ? (
            <div
              className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading keys…
            </div>
          ) : keysQuery.isError ? (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              data-testid="api-keys-error"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              Failed to load API keys.
            </div>
          ) : !keysQuery.data || keysQuery.data.keys.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="api-keys-empty"
            >
              No active API keys. Create one above to enable cron exports.
            </p>
          ) : (
            <ul
              className="divide-y divide-border"
              aria-label="Active API keys"
              data-testid="api-keys-list"
            >
              {keysQuery.data.keys.map((key) => (
                <KeyRow key={key.id} apiKey={key} />
              ))}
            </ul>
          )}
        </div>

        {/* Info callout */}
        <div className="flex gap-2 rounded-lg border border-border bg-muted/40 px-3 py-3 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <p>
            Keys are hashed at rest — TrustBridge never stores the raw secret.
            If you lose a key, revoke it and create a new one. Rate limiting
            applies: 60 requests per minute per IP.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
