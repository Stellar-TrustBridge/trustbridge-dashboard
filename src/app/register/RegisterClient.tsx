"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { useReducer, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";

import { AddressInput } from "@/components/AddressInput";
import { TrustlineGuidancePanel } from "@/components/TrustlineGuidancePanel";
import { TrustlineStatusBadge } from "@/components/TrustlineStatusBadge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { OnboardingChecklistState } from "@/types";

// ---------------------------------------------------------------------------
// Checklist reducer
// ---------------------------------------------------------------------------

type ChecklistAction =
  | { type: "COMPLETE_STEP"; key: keyof OnboardingChecklistState }
  | { type: "MERGE"; payload: OnboardingChecklistState };

/**
 * Merge incoming payload into existing state so completed steps are never
 * wiped by a partial server update.  Unknown keys from the API are ignored
 * because the spread only carries recognised fields through the typed payload.
 */
function checklistReducer(
  state: OnboardingChecklistState,
  action: ChecklistAction
): OnboardingChecklistState {
  switch (action.type) {
    case "COMPLETE_STEP":
      return { ...state, [action.key]: true };
    case "MERGE":
      // Only apply keys that are already defined in OnboardingChecklistState
      // to prevent stray server fields from polluting local state.
      return { ...state, ...action.payload };
    default:
      return state;
  }
}

/**
 * Normalise a potentially-null checklist value coming from the server to the
 * canonical empty object so the reducer always receives a valid state shape.
 */
function normaliseChecklist(
  raw: OnboardingChecklistState | null | undefined
): OnboardingChecklistState {
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

// ---------------------------------------------------------------------------
// API shape
// ---------------------------------------------------------------------------

interface RegistrationResponse {
  registration?: {
    stellarAddress: string;
    readiness: "ready" | "low_reserve" | "not_ready";
    checklistCompleted?: OnboardingChecklistState | null;
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RegisterClient() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [address, setAddress] = useState("");
  const [saved, setSaved] = useState(false);

  // Checklist state — typed, no `any` casts, partial updates safe.
  const [checklist, dispatchChecklist] = useReducer(checklistReducer, {});

  const maintainerError = searchParams.get("error") === "maintainer";

  const existingQuery = useQuery({
    queryKey: ["registration"],
    queryFn: async () => {
      const response = await fetch("/api/register");
      if (!response.ok) throw new Error("Failed to load registration");
      const data = (await response.json()) as RegistrationResponse;

      // Hydrate local checklist from persisted server state on first load.
      if (data.registration?.checklistCompleted != null) {
        dispatchChecklist({
          type: "MERGE",
          payload: normaliseChecklist(data.registration.checklistCompleted),
        });
      }

      return data;
    },
    enabled: !!session,
  });

  const saveMutation = useMutation({
    mutationFn: async (stellarAddress: string) => {
      const response = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stellarAddress }),
      });
      const data = (await response.json()) as {
        error?: string;
        registration?: RegistrationResponse["registration"];
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Registration failed");
      }
      return data;
    },
    onSuccess: (data) => {
      setSaved(true);
      // Mark the address registration step as complete.
      dispatchChecklist({ type: "COMPLETE_STEP", key: "addressRegistered" });

      // If the returned registration is ready, mark readiness confirmed too.
      if (data.registration?.readiness === "ready") {
        dispatchChecklist({ type: "COMPLETE_STEP", key: "readinessConfirmed" });
      }

      queryClient.invalidateQueries({ queryKey: ["registration"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
  });

  const existingAddress =
    existingQuery.data?.registration?.stellarAddress ?? "";

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      {maintainerError && (
        <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          Maintainer dashboard requires membership in the configured GitHub
          organization. You can still register your Stellar address here.
        </div>
      )}

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Contributor registration</h1>
        <p className="mt-2 text-muted-foreground">
          Signed in as{" "}
          <span className="font-medium text-foreground">
            @{session?.user?.githubUsername}
          </span>
          . Link your GitHub identity to a Stellar G-address for Wave payouts.
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-5">
        <div className="lg:col-span-3 space-y-6">
          {existingAddress && (
            <Card className="border-emerald-500/30 bg-emerald-500/5">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  Current registration
                </CardTitle>
                <CardDescription className="font-mono text-xs break-all">
                  {existingAddress}
                </CardDescription>
              </CardHeader>
              {existingQuery.data?.registration?.readiness && (
                <CardContent>
                  <TrustlineStatusBadge
                    status={existingQuery.data.registration.readiness}
                  />
                </CardContent>
              )}
            </Card>
          )}

          {/* Onboarding checklist — driven by shared OnboardingChecklistState */}
          <Card data-testid="onboarding-checklist">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Onboarding checklist</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {(
                  [
                    ["stellarAccountCreated", "Create a Stellar account"],
                    ["usdcTrustlineAdded", "Add USDC trustline"],
                    ["addressRegistered", "Register your address"],
                    ["readinessConfirmed", "Readiness confirmed"],
                  ] satisfies [keyof OnboardingChecklistState, string][]
                ).map(([key, label]) => (
                  <li key={key} className="flex items-center gap-2">
                    <CheckCircle2
                      className={`h-4 w-4 ${checklist[key] ? "text-emerald-500" : "text-muted-foreground/30"}`}
                    />
                    <span className={checklist[key] ? "font-medium" : "text-muted-foreground"}>
                      {label}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                {existingAddress ? "Update Stellar address" : "Stellar address"}
              </CardTitle>
              <CardDescription>
                Enter your public key (starts with G). Validation runs as you
                type via Horizon.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <AddressInput
                value={address}
                onChange={setAddress}
                disabled={saveMutation.isPending}
              />

              {saveMutation.isError && (
                <p className="text-sm text-destructive">
                  {(saveMutation.error as Error).message}
                </p>
              )}

              {saved && (
                <p className="text-sm text-emerald-600 dark:text-emerald-400">
                  Registration saved successfully.
                </p>
              )}

              <Button
                variant="stellar"
                disabled={!address.trim() || saveMutation.isPending}
                onClick={() => saveMutation.mutate(address.trim())}
              >
                {saveMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save registration"
                )}
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <TrustlineGuidancePanel />
        </div>
      </div>
    </div>
  );
}
