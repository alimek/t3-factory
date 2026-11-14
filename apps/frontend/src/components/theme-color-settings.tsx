import { useState, type FormEvent } from "react";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import type {
  AppearancePresentation,
  T3Appearance,
  T3AppearanceState,
} from "@t3-factory/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fieldLabelClass } from "@/components/page";
import { Notice } from "@/components/notice";
import { MutationGate } from "@/client-gate";
import { api } from "../api.ts";
import { useAppearance } from "../appearance.ts";
import { useLiveAppearance } from "../live/live-connection.ts";
import {
  SettingsDetailRow,
  SettingsDisclosure,
  SettingsGroup,
  SettingsRow,
  StatusPill,
  type StatusTone,
} from "./settings-page.tsx";

const statePills: Record<T3AppearanceState, { label: string; tone: StatusTone }> = {
  "not-paired": { label: "Not paired", tone: "neutral" },
  connecting: { label: "Connecting", tone: "neutral" },
  following: { label: "Following T3", tone: "success" },
  unavailable: { label: "Unavailable", tone: "attention" },
  "re-pair-required": { label: "Pair again", tone: "attention" },
};

/** What the separate grant allows and how it ends: shown before pairing and in the disclosure. */
const grantScope =
  "Theme colors use a separate T3 grant limited to orchestration:read. That scope also lets Factory read T3 conversations, threads and settings. T3 ends it after 30 days; Factory never renews it and asks you to pair again. Revoke it in T3 at any time; Disconnect deletes Factory’s copy.";

const formatDate = (at: string) => new Date(at).toLocaleString();

function modeText(presentation: AppearancePresentation | null, mode: "light" | "dark") {
  if (!presentation) return "Factory colors";
  const half = presentation.modes[mode];
  return half.kind === "inherited" ? `T3 “${presentation.theme.name}” colors` : half.explanation;
}

function ThemeColorDetails({ appearance }: { appearance: T3Appearance | null }) {
  const grant = appearance?.grant;
  const presentation = appearance?.presentation ?? null;
  return (
    <>
      {grant && <SettingsDetailRow label="Paired" value={formatDate(grant.pairedAt)} />}
      {grant && <SettingsDetailRow label="Grant expires" value={formatDate(grant.expiresAt)} />}
      <SettingsDetailRow label="Light" value={modeText(presentation, "light")} />
      <SettingsDetailRow label="Dark" value={modeText(presentation, "dark")} />
    </>
  );
}

/** Host-only consent and pairing code for the separate theme-color grant. */
function PairingForm({
  busy,
  onPair,
  onCancel,
}: {
  busy: boolean;
  onPair: (pairing: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [pairing, setPairing] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await onPair(pairing)) setPairing("");
  };
  return (
    <form className="grid gap-3 p-4" onSubmit={(event) => void submit(event)}>
      <Notice tone="info" icon={ShieldAlert} title="This grant reads more than colors">
        {grantScope}
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
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * Host-only Settings → Appearance → T3 theme colors: whether Factory follows the T3
 * environment's default theme, why not, the grant's expiry and its pairing controls.
 * Independent of the connection's readiness.
 */
export function ThemeColorSettings() {
  const appearance = useLiveAppearance().value;
  const [open, setOpen] = useState(false);
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
  const pair = async (pairing: string) => {
    const paired = await run(() => api.pairAppearance({ pairing }));
    if (paired) setOpen(false);
    return paired;
  };
  const pill = appearance && statePills[appearance.state];
  const paired = appearance !== null && appearance.state !== "not-paired";
  const warn = appearance?.grant?.expiresSoon && appearance.state !== "re-pair-required";
  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <SettingsGroup
        label="T3 theme colors"
        badge={pill && <StatusPill tone={pill.tone}>{pill.label}</StatusPill>}
      >
        <SettingsRow
          title="Use T3’s default theme colors"
          description={
            <span aria-live="polite">
              {paired
                ? appearance.explanation
                : "Follow the colors of the T3 environment’s default theme. Runs never depend on theme colors."}
            </span>
          }
          control={
            !open && (
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
            )
          }
        />
        {open && <PairingForm busy={busy} onPair={pair} onCancel={() => setOpen(false)} />}
        <ThemeColorDetails appearance={appearance} />
      </SettingsGroup>
      {warn && appearance.grant && (
        <Notice tone="attention" icon={TriangleAlert} title="Theme colors expire soon">
          The grant ends {formatDate(appearance.grant.expiresAt)}. Pair again before then; Factory
          never renews it on its own.
        </Notice>
      )}
      <SettingsDisclosure
        label="About the theme-colors grant"
        hint="Separate orchestration:read grant · T3 ends it after 30 days"
      >
        <p>{grantScope}</p>
        <p>
          Only colors change; every device keeps its own Light or Dark choice, and Runs never depend
          on theme colors.
        </p>
      </SettingsDisclosure>
    </>
  );
}

/** T3 theme colors on clients other than the host: what the selected mode shows, and why. */
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
  return (
    <SettingsGroup label="T3 theme colors">
      <SettingsRow description={text} />
    </SettingsGroup>
  );
}
