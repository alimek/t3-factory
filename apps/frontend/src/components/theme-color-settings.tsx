import { useState, type FormEvent, type ReactNode } from "react";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import type {
  AppearancePresentation,
  T3Appearance,
  T3AppearanceState,
} from "@t3-factory/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fieldLabelClass } from "@/components/page";
import { Notice } from "@/components/notice";
import { MutationGate } from "@/client-gate";
import { api } from "../api.ts";
import { useAppearance } from "../appearance.ts";
import { useLiveAppearance } from "../live/live-connection.ts";

const stateBadges: Record<
  T3AppearanceState,
  { label: string; variant: "secondary" | "success" | "attention" }
> = {
  "not-paired": { label: "Not paired", variant: "secondary" },
  connecting: { label: "Connecting", variant: "secondary" },
  following: { label: "Following T3", variant: "success" },
  unavailable: { label: "Unavailable", variant: "attention" },
  "re-pair-required": { label: "Pair again", variant: "attention" },
};

const formatDate = (at: string) => new Date(at).toLocaleString();

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="col-span-2 grid grid-cols-subgrid border-b py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

function modeText(presentation: AppearancePresentation, mode: "light" | "dark") {
  const half = presentation.modes[mode];
  return half.kind === "inherited" ? `T3 “${presentation.theme.name}” colors` : half.explanation;
}

function ThemeColorDetails({ appearance }: { appearance: T3Appearance }) {
  const { grant, presentation } = appearance;
  if (!grant) return null;
  return (
    <dl className="grid grid-cols-[10.5rem_1fr] text-sm">
      <Row label="Paired">{formatDate(grant.pairedAt)}</Row>
      <Row label="Grant expires">{formatDate(grant.expiresAt)}</Row>
      {presentation && <Row label="Light">{modeText(presentation, "light")}</Row>}
      {presentation && <Row label="Dark">{modeText(presentation, "dark")}</Row>}
    </dl>
  );
}

/** Host-only: consent, the pairing code and disconnecting the separate grant. */
function HostThemeColorControls({ appearance }: { appearance: T3Appearance | null }) {
  const [open, setOpen] = useState(false);
  const [pairing, setPairing] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (operation: () => Promise<T3Appearance>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The operation could not complete.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await run(() => api.pairAppearance({ pairing }))) {
      setOpen(false);
      setPairing("");
    }
  };
  const paired = appearance !== null && appearance.state !== "not-paired";
  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {open ? (
        <form className="grid max-w-xl gap-3" onSubmit={(event) => void submit(event)}>
          <Notice tone="info" icon={ShieldAlert} title="This grant reads more than colors">
            Theme colors use a separate T3 grant limited to orchestration:read. That scope also lets
            Factory read T3 conversations, threads and settings. T3 ends it after 30 days; Factory
            never renews it and asks you to pair again. Revoke it in T3 at any time; Disconnect
            deletes Factory’s copy.
          </Notice>
          <p className="text-sm text-muted-foreground">
            On the T3 computer, run{" "}
            <code className="font-mono text-label text-foreground">
              t3 auth pairing create --scope orchestration:read --json
            </code>{" "}
            and paste its credential, or paste the link{" "}
            <code className="font-mono text-label text-foreground">
              t3 pair --scope orchestration:read
            </code>{" "}
            prints.
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor="appearance-pairing" className={fieldLabelClass}>
              Pairing code or link
            </Label>
            <div className="flex gap-2">
              <Input
                id="appearance-pairing"
                required
                autoComplete="off"
                spellCheck={false}
                value={pairing}
                className="bg-background font-mono text-xs"
                onChange={(event) => setPairing(event.target.value)}
              />
              <MutationGate>
                <Button type="submit" disabled={busy}>
                  Pair
                </Button>
              </MutationGate>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <MutationGate>
            <Button
              type="button"
              variant={paired ? "outline" : "default"}
              disabled={busy}
              onClick={() => setOpen(true)}
            >
              {paired ? "Pair again" : "Pair theme colors"}
            </Button>
            {paired && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void run(api.disconnectAppearance)}
              >
                Disconnect theme colors
              </Button>
            )}
          </MutationGate>
        </div>
      )}
    </>
  );
}

/**
 * Host-only Settings → Appearance → Theme colors: whether Factory follows the T3 environment's
 * default theme, why not, and the grant's expiry. Independent of the connection's readiness.
 */
export function ThemeColorSettings() {
  const appearance = useLiveAppearance().value;
  const badge = appearance && stateBadges[appearance.state];
  const warn = appearance?.grant?.expiresSoon && appearance.state !== "re-pair-required";
  return (
    <section aria-labelledby="theme-colors-title" className="grid gap-3 border-t pt-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h3 id="theme-colors-title" className="text-base font-semibold text-foreground">
          Theme colors
        </h3>
        {badge && (
          <Badge variant={badge.variant} className="gap-1.5 pr-2 pl-1.75">
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {badge.label}
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Optionally use the colors of the T3 environment’s default theme. Every device keeps its own
        Light or Dark choice; Runs never depend on theme colors.
      </p>
      {appearance && (
        <p aria-live="polite" className="text-sm text-foreground">
          {appearance.explanation}
        </p>
      )}
      {warn && appearance.grant && (
        <Notice tone="attention" icon={TriangleAlert} title="Theme colors expire soon">
          The grant ends {formatDate(appearance.grant.expiresAt)}. Pair again before then; Factory
          never renews it on its own.
        </Notice>
      )}
      {appearance && <ThemeColorDetails appearance={appearance} />}
      <HostThemeColorControls appearance={appearance} />
    </section>
  );
}

/** Under Light or Dark on clients other than the host: what the selected mode shows, and why. */
export function ThemeColorsNote() {
  const mode = useAppearance();
  const appearance = useLiveAppearance().value;
  if (!appearance) return null;
  const presentation = appearance.presentation;
  const half = presentation?.modes[mode];
  let text = appearance.explanation;
  if (half?.kind === "inherited")
    text = `Colors follow T3’s default theme “${presentation!.theme.name}”.`;
  else if (half) text = half.explanation;
  else if (appearance.state === "not-paired")
    text =
      "Factory’s own colors. T3 theme colors can be paired in Settings → Appearance on the Factory host.";
  return <p className="text-xs text-muted-foreground">{text}</p>;
}
