import { useEffect, useState } from "react";
import { CircleCheck, CircleX, Info, Power, TriangleAlert } from "lucide-react";
import type {
  DiscordSettings,
  DiscordTokenChange,
  UpdateDiscordConnectionInput,
} from "@t3-factory/contracts";
import { validateDiscordId, validateDiscordPublicKey } from "@t3-factory/domain-validation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fieldLabelClass } from "@/components/page";
import { api } from "../api.ts";
import { reportDiscordSettings } from "../chat-control-attention.ts";
import { AccessForm, useAccessSection } from "./chat-discord-access.tsx";
import { dayAndTime } from "./execution-state.tsx";
import { Notice } from "./notice.tsx";
import { SegmentedChoice } from "./segmented-choice.tsx";
import { useSettingsDraftGuard } from "./settings-draft-guard.tsx";
import {
  ChatControlPage,
  chatControlError,
  SectionSaveBar,
  useChatControlSection,
} from "./chat-control-form.tsx";

type TokenChoice = "keep" | "replace" | "remove";

interface ConnectionDraft {
  readonly applicationId: string;
  readonly publicKey: string;
  readonly tokenChoice: TokenChoice;
  /** A new token; held only in memory and never prefilled. */
  readonly tokenValue: string;
  readonly applicationChangeConfirmed: boolean;
}

const draftOf = ({ configuration }: DiscordSettings): ConnectionDraft => ({
  applicationId: configuration.applicationId ?? "",
  publicKey: configuration.publicKey ?? "",
  tokenChoice: "keep",
  tokenValue: "",
  applicationChangeConfirmed: false,
});

const applicationIdOf = (draft: ConnectionDraft) => draft.applicationId.trim() || null;
// The backend stores the Public Key in lowercase; compare drafts the same way.
const publicKeyOf = (draft: ConnectionDraft) => draft.publicKey.trim().toLowerCase() || null;

/** Whether the draft replaces a saved Application ID with a different one. */
const applicationChanged = (draft: ConnectionDraft, { configuration }: DiscordSettings) =>
  configuration.applicationId !== null &&
  applicationIdOf(draft) !== null &&
  applicationIdOf(draft) !== configuration.applicationId;

/** The token change this draft asks for, or null while a replacement has no value yet. */
function tokenChange(draft: ConnectionDraft, settings: DiscordSettings): DiscordTokenChange | null {
  const value = draft.tokenValue.trim();
  if (!settings.configuration.tokenConfigured)
    return value ? { kind: "replace", value } : { kind: "keep" };
  if (draft.tokenChoice === "replace") return value ? { kind: "replace", value } : null;
  return { kind: draft.tokenChoice };
}

function isDirty(draft: ConnectionDraft, { configuration }: DiscordSettings) {
  return (
    applicationIdOf(draft) !== configuration.applicationId ||
    publicKeyOf(draft) !== configuration.publicKey ||
    draft.tokenValue.trim() !== "" ||
    draft.tokenChoice !== "keep"
  );
}

const saveInput = (
  draft: ConnectionDraft,
  settings: DiscordSettings,
  token: DiscordTokenChange,
): UpdateDiscordConnectionInput => ({
  revision: settings.configuration.revision,
  applicationId: applicationIdOf(draft),
  publicKey: publicKeyOf(draft),
  token,
  applicationChangeConfirmed: draft.applicationChangeConfirmed,
});

/** Whether the host already holds exactly this save, so a lost acknowledgement was a success. */
const committed = (input: UpdateDiscordConnectionInput, current: DiscordSettings) =>
  current.configuration.revision === input.revision + 1 &&
  current.configuration.applicationId === input.applicationId &&
  current.configuration.publicKey === input.publicKey;

// While On, the running connection's state changes without any action on this page.
const STATUS_REFRESH_MS = 5_000;

/**
 * The page's saved settings and connection draft, with its save, check, On/Off and Discard
 * actions. While Chat control is On the settings are read again periodically, which updates the
 * connection state without touching any draft.
 */
function useDiscordPage() {
  const section = useChatControlSection({
    read: api.getDiscordSettings,
    update: api.updateDiscordConnection,
    draftOf,
    committed,
    name: "the Discord settings",
  });
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const { settings, draft, setSettings } = section;
  const enabled = settings?.chatControlEnabled ?? false;
  useEffect(() => {
    if (settings) reportDiscordSettings(settings);
  }, [settings]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(
      () => void api.getDiscordSettings().then(setSettings, () => undefined),
      STATUS_REFRESH_MS,
    );
    return () => clearInterval(timer);
  }, [enabled, setSettings]);
  const check = async (revision: number) => {
    setChecking(true);
    setCheckError("");
    try {
      setSettings(await api.checkDiscordConnection({ revision }));
    } catch (cause) {
      setCheckError(chatControlError(cause, "Factory could not run the check."));
    } finally {
      setChecking(false);
    }
  };
  const turn = async (on: boolean) => {
    setSwitching(true);
    setSwitchError("");
    try {
      setSettings(await api.setChatControlEnabled({ enabled: on }));
    } catch (cause) {
      setSwitchError(
        chatControlError(cause, `Factory could not turn Chat control ${on ? "On" : "Off"}.`),
      );
    } finally {
      setSwitching(false);
    }
  };
  return {
    ...section,
    dirty: settings !== null && draft !== null && isDirty(draft, settings),
    checking,
    checkError,
    check,
    switching,
    switchError,
    turn,
  };
}

/**
 * Settings → Chat control → Discord, host only: the On/Off switch, then the Discord connection and
 * Access, each with its own Save and Discard, and the check of the saved connection.
 */
export function ChatDiscordSettings() {
  const page = useDiscordPage();
  const access = useAccessSection();
  const { settings, draft, loadError } = page;
  const decision = useSettingsDraftGuard("chat-discord", [
    ...(page.dirty ? ["Discord connection"] : []),
    ...(access.dirty ? ["Access"] : []),
  ]);
  return (
    <ChatControlPage
      title="Discord"
      intro="The Discord bot Chat control uses. Factory connects to Discord over outbound connections only; it needs no public address, webhook or tunnel. Only this Factory host can see or change these settings."
      loadError={loadError || access.loadError}
      onRetry={() => {
        page.reload();
        access.reload();
      }}
      decision={decision}
    >
      {settings && draft && access.settings && access.draft ? (
        <>
          <ChatControlSwitch
            settings={settings}
            switching={page.switching}
            switchError={page.switchError}
            onTurn={(on) => void page.turn(on)}
          />
          <ConnectionForm
            settings={settings}
            draft={draft}
            dirty={page.dirty}
            saving={page.saving}
            saveError={page.saveError}
            onChange={page.setDraft}
            onSave={(input) => void page.save(input)}
            onDiscard={page.discard}
          />
          <AccessForm
            settings={access.settings}
            draft={access.draft}
            dirty={access.dirty}
            saving={access.saving}
            saveError={access.saveError}
            onChange={access.setDraft}
            onSave={(input) => void access.save(input)}
            onDiscard={access.discard}
          />
          <ConnectionCheck
            settings={settings}
            dirty={page.dirty}
            checking={page.checking}
            checkError={page.checkError}
            onCheck={(revision) => void page.check(revision)}
          />
          <SetupGuide />
        </>
      ) : null}
    </ChatControlPage>
  );
}

const STATUS_LABELS: Record<DiscordSettings["connectionStatus"], string> = {
  incomplete: "Incomplete",
  off: "Off",
  checking: "Checking",
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting",
  rejected: "Rejected",
};

/** Chat control's one persisted On/Off switch, with the running connection's separate diagnostics. */
function ChatControlSwitch({
  settings,
  switching,
  switchError,
  onTurn,
}: {
  settings: DiscordSettings;
  switching: boolean;
  switchError: string;
  onTurn: (on: boolean) => void;
}) {
  const on = settings.chatControlEnabled;
  const action = (
    <div>
      <Button
        type="button"
        variant={on ? "outline" : "default"}
        size="sm"
        disabled={switching}
        onClick={() => onTurn(!on)}
      >
        {switching ? (on ? "Turning Off…" : "Turning On…") : on ? "Turn Off" : "Turn On"}
      </Button>
    </div>
  );
  return (
    <section aria-label="Chat control state" className="grid gap-3">
      {on ? (
        <Notice tone="info" icon={Power} title="Chat control is On" action={action}>
          Factory answers allowed users who mention the bot or reply to it in allowed channels. The
          Application ID, Public Key and bot token are required while Chat control is On. Turning it
          Off disconnects from Discord and keeps the configuration, conversations and accepted work.
        </Notice>
      ) : (
        <Notice tone="neutral" icon={Power} title="Chat control is Off" action={action}>
          Factory answers no Discord messages, buttons or commands. It connects to Discord only when
          you check the saved connection, and you can save an incomplete connection. Turning On
          needs the saved Application ID, Public Key and bot token and the Language model&apos;s
          provider, base URL and model; a key, passed tests and Access entries are not required.
        </Notice>
      )}
      {switchError && (
        <Alert variant="destructive">
          <AlertDescription>{switchError}</AlertDescription>
        </Alert>
      )}
      {on && <OperatingDiagnostics settings={settings} />}
    </section>
  );
}

/** The Gateway connection and command setup, reported separately: one is not the other. */
function OperatingDiagnostics({ settings }: { settings: DiscordSettings }) {
  const { connectionStatus, connectionProblem, commandSetup } = settings;
  const failing = connectionStatus === "rejected" || connectionStatus === "reconnecting";
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
      <dt className="text-muted-foreground">Gateway connection</dt>
      <dd className={failing ? "text-foreground" : "text-muted-foreground"}>
        <span className="font-medium text-foreground">{STATUS_LABELS[connectionStatus]}</span>
        {connectionProblem &&
          ` · ${dayAndTime(connectionProblem.occurredAt)} · ${connectionProblem.message}`}
        {connectionStatus === "rejected" && " Correct the cause, then retry the connection below."}
        {connectionStatus === "reconnecting" && " Factory retries with increasing waits."}
      </dd>
      <dt className="text-muted-foreground">Command setup</dt>
      <dd className="text-muted-foreground">
        {commandSetup ? (
          <>
            <span className="font-medium text-foreground">
              {commandSetup.outcome === "registered" ? "/factory reset registered" : "Failed"}
            </span>
            {` · ${dayAndTime(commandSetup.occurredAt)} · ${commandSetup.message}`}
          </>
        ) : (
          "Registered after Discord verifies the application."
        )}
      </dd>
    </dl>
  );
}

const problemOf = (result: { ok: true } | { ok: false; error: { message: string } } | null) =>
  result && !result.ok ? result.error.message : "";

/** The draft's field problems, its token change and whether it may be saved as it stands. */
function draftCheck(draft: ConnectionDraft, settings: DiscordSettings) {
  const applicationIdProblem = problemOf(
    draft.applicationId.trim()
      ? validateDiscordId(
          draft.applicationId,
          "discord_application_id",
          "applicationId",
          "Application ID",
        )
      : null,
  );
  const publicKeyProblem = problemOf(
    draft.publicKey.trim() ? validateDiscordPublicKey(draft.publicKey) : null,
  );
  const token = tokenChange(draft, settings);
  const changed = applicationChanged(draft, settings);
  return {
    applicationIdProblem,
    publicKeyProblem,
    token,
    changed,
    ready:
      !applicationIdProblem &&
      !publicKeyProblem &&
      token !== null &&
      (!changed || draft.applicationChangeConfirmed),
  };
}

function ConnectionForm({
  settings,
  draft,
  dirty,
  saving,
  saveError,
  onChange,
  onSave,
  onDiscard,
}: {
  settings: DiscordSettings;
  draft: ConnectionDraft;
  dirty: boolean;
  saving: boolean;
  saveError: string;
  onChange: (draft: ConnectionDraft) => void;
  onSave: (input: UpdateDiscordConnectionInput) => void;
  onDiscard: () => void;
}) {
  const { applicationIdProblem, publicKeyProblem, token, changed, ready } = draftCheck(
    draft,
    settings,
  );
  return (
    <section aria-label="Discord connection" className="grid gap-4">
      <div className="grid gap-1">
        <h3 className="text-sm font-semibold text-foreground">Connection</h3>
        <p className="text-sm text-muted-foreground">
          From the application in the Discord Developer Portal. Factory checks the token against the
          Application ID rather than reading the ID from the token.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id="discord-application-id"
          label="Application ID"
          value={draft.applicationId}
          placeholder="General Information → Application ID"
          hint="The decimal ID Discord shows for the application."
          problem={applicationIdProblem}
          disabled={saving}
          inputMode="numeric"
          onChange={(value) =>
            onChange({ ...draft, applicationId: value, applicationChangeConfirmed: false })
          }
        />
        <TextField
          id="discord-public-key"
          label="Public Key"
          value={draft.publicKey}
          placeholder="General Information → Public Key"
          hint="Not a secret. Factory does not use it to verify anything during a check."
          problem={publicKeyProblem}
          disabled={saving}
          onChange={(value) => onChange({ ...draft, publicKey: value })}
        />
      </div>
      {changed && (
        <ApplicationChangeNotice
          enabled={settings.chatControlEnabled}
          confirmed={draft.applicationChangeConfirmed}
          onConfirm={(confirmed) => onChange({ ...draft, applicationChangeConfirmed: confirmed })}
        />
      )}
      <TokenField settings={settings} draft={draft} disabled={saving} onChange={onChange} />
      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}
      <SectionSaveBar
        saved={settings.configuration}
        dirty={dirty}
        saving={saving}
        onSave={
          dirty && ready && token ? () => onSave(saveInput(draft, settings, token)) : undefined
        }
        onDiscard={onDiscard}
      />
    </section>
  );
}

function TextField({
  id,
  label,
  value,
  placeholder,
  hint,
  problem,
  disabled,
  inputMode,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  hint: string;
  problem: string;
  disabled: boolean;
  inputMode?: "numeric";
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id} className={fieldLabelClass}>
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        inputMode={inputMode}
        disabled={disabled}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p
        id={`${id}-hint`}
        className={problem ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
      >
        {problem || hint}
      </p>
    </div>
  );
}

function ApplicationChangeNotice({
  enabled,
  confirmed,
  onConfirm,
}: {
  enabled: boolean;
  confirmed: boolean;
  onConfirm: (confirmed: boolean) => void;
}) {
  return (
    <Notice
      tone="attention"
      icon={TriangleAlert}
      title="A different Application ID connects a different bot"
      action={
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Checkbox
            checked={confirmed}
            onCheckedChange={(checked) => onConfirm(checked === true)}
          />
          I understand; use the new application.
        </label>
      }
    >
      Factory treats it as a new identity: nothing of the old bot carries over, including its
      conversations, reviews and buttons, and its earlier messages are no longer updated. The saved
      token must belong to the new application; check the connection after saving.
      {enabled && " Turn Chat control Off before saving a different application."}
    </Notice>
  );
}

/** Blank never clears a saved token: Replace and Remove are explicit. */
function TokenField({
  settings,
  draft,
  disabled,
  onChange,
}: {
  settings: DiscordSettings;
  draft: ConnectionDraft;
  disabled: boolean;
  onChange: (draft: ConnectionDraft) => void;
}) {
  const tokenInput = (label: string, placeholder: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor="discord-token" className={fieldLabelClass}>
        {label}
      </Label>
      <Input
        id="discord-token"
        type="password"
        value={draft.tokenValue}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, tokenValue: event.target.value })}
      />
    </div>
  );
  if (!settings.configuration.tokenConfigured)
    return tokenInput("Bot token", "Bot → Reset Token, then paste it here");
  return (
    <div className="grid gap-2">
      <p id="discord-token-label" className={fieldLabelClass}>
        Bot token · saved on this host
      </p>
      <SegmentedChoice
        labelledBy="discord-token-label"
        value={draft.tokenChoice}
        options={[
          ["keep", "Keep saved token"],
          ["replace", "Replace token"],
          ["remove", "Remove token"],
        ]}
        onChange={(next) => onChange({ ...draft, tokenChoice: next, tokenValue: "" })}
      />
      {draft.tokenChoice === "replace" && tokenInput("Replacement token", "Paste the new token")}
      {draft.tokenChoice === "remove" && (
        <p className="text-sm text-muted-foreground">
          Saving removes the token; the connection is then incomplete until you save a new one.
        </p>
      )}
    </div>
  );
}

function ConnectionCheck({
  settings,
  dirty,
  checking,
  checkError,
  onCheck,
}: {
  settings: DiscordSettings;
  dirty: boolean;
  checking: boolean;
  checkError: string;
  onCheck: (revision: number) => void;
}) {
  const { configuration, latestCheck, connectionStatus, chatControlEnabled } = settings;
  if (chatControlEnabled)
    return (
      <RunningConnection
        settings={settings}
        dirty={dirty}
        checking={checking}
        checkError={checkError}
        onRetry={() => onCheck(configuration.revision)}
      />
    );
  const incomplete = connectionStatus === "incomplete";
  const unavailable = dirty || incomplete;
  return (
    <section aria-label="Discord connection check" className="grid gap-3 border-t pt-5">
      <div className="grid gap-1">
        <h3 className="text-sm font-semibold text-foreground">Check the saved connection</h3>
        <p className="text-sm text-muted-foreground">
          Connects to the Discord Gateway with the saved token, confirms the session becomes ready
          as the configured application, then disconnects, within 30 seconds. During the check
          Factory answers no messages, buttons or commands and posts nothing.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={unavailable || checking || connectionStatus === "checking"}
          onClick={() => onCheck(configuration.revision)}
        >
          {checking || connectionStatus === "checking" ? "Checking…" : "Check saved connection"}
        </Button>
        {unavailable && (
          <p className="text-sm text-muted-foreground">
            {dirty
              ? "Save or discard your edits to check."
              : "Save the Application ID, Public Key and bot token to check."}
          </p>
        )}
      </div>
      {checkError && (
        <Alert variant="destructive">
          <AlertDescription>{checkError}</AlertDescription>
        </Alert>
      )}
      {latestCheck && (
        <Notice
          tone="neutral"
          icon={latestCheck.outcome === "verified" ? CircleCheck : CircleX}
          title={`Latest check ${latestCheck.outcome === "verified" ? "verified" : "failed"} · ${dayAndTime(latestCheck.checkedAt)} · revision ${latestCheck.revision}`}
        >
          {latestCheck.message}
          {latestCheck.revision !== configuration.revision &&
            ` This check was for an earlier configuration; revision ${configuration.revision} is unchecked.`}
        </Notice>
      )}
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
        <span>
          A passing check shows that Discord accepted the token for this application. It does not
          show that the bot can read or post in your channels, that messages are delivered, that
          commands are set up or that the Public Key is correct.
        </span>
      </p>
    </section>
  );
}

/** While On, the running connection is retried instead of opening a separate check session. */
function RunningConnection({
  settings,
  dirty,
  checking,
  checkError,
  onRetry,
}: {
  settings: DiscordSettings;
  dirty: boolean;
  checking: boolean;
  checkError: string;
  onRetry: () => void;
}) {
  const retryable =
    settings.connectionStatus === "rejected" || settings.connectionStatus === "reconnecting";
  return (
    <section aria-label="Discord connection check" className="grid gap-3 border-t pt-5">
      <div className="grid gap-1">
        <h3 className="text-sm font-semibold text-foreground">Running connection</h3>
        <p className="text-sm text-muted-foreground">
          While Chat control is On, Factory keeps one Gateway connection and reports its state
          above. Retrying reconnects that connection with the saved configuration; it never opens a
          second one.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={!retryable || dirty || checking}
          onClick={onRetry}
        >
          {checking ? "Retrying…" : "Retry connection"}
        </Button>
        {retryable && dirty && (
          <p className="text-sm text-muted-foreground">Save or discard your edits to retry.</p>
        )}
      </div>
      {checkError && (
        <Alert variant="destructive">
          <AlertDescription>{checkError}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

const permissions = [
  "View Channels",
  "Send Messages",
  "Send Messages in Threads",
  "Create Public Threads",
  "Manage Threads",
  "Read Message History",
  "Add Reactions",
  "Attach Files",
];

function SetupGuide() {
  return (
    <section aria-label="Discord setup" className="grid gap-3 border-t pt-5">
      <h3 className="text-sm font-semibold text-foreground">Set up the Discord application</h3>
      <ol className="grid list-decimal gap-2 pl-5 text-sm text-muted-foreground">
        <li>
          In the Discord Developer Portal, create an application. Copy its{" "}
          <strong className="font-medium text-foreground">Application ID</strong> and{" "}
          <strong className="font-medium text-foreground">Public Key</strong> from General
          Information.
        </li>
        <li>
          On the Bot page, reset and copy the token, and turn on{" "}
          <strong className="font-medium text-foreground">Message Content Intent</strong>. Without
          it Discord refuses the connection. Other privileged intents are not needed.
        </li>
        <li>
          Leave <strong className="font-medium text-foreground">Interactions Endpoint URL</strong>{" "}
          empty. Factory receives buttons and commands over its own outbound Gateway connection;
          with a URL set, Discord sends them to that URL instead.
        </li>
        <li>
          In OAuth2 → URL Generator, choose the scopes{" "}
          <strong className="font-medium text-foreground">bot</strong> and{" "}
          <strong className="font-medium text-foreground">applications.commands</strong> and the bot
          permissions {permissions.join(", ")}. Open the generated link to invite the bot to each
          server you want to use. One application can serve several servers; no server ID is needed.
        </li>
        <li>
          Keep this Factory server running. The bot works only while Factory runs, and Factory never
          runs it anywhere else. When Chat control turns On, Factory registers its only command,{" "}
          <strong className="font-medium text-foreground">/factory reset</strong>, which clears a
          thread&apos;s shared conversation without deleting Discord messages or accepted work.
        </li>
      </ol>
    </section>
  );
}
